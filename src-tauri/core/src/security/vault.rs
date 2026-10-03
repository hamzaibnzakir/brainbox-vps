//! Encrypted credential vault.
//!
//! Secrets (SSH passwords, key passphrases, imported private keys, proxy and
//! AI API keys) are sealed with AES-256-GCM. Each blob is bound to its record
//! id through the AEAD associated data, so ciphertexts cannot be swapped
//! between records.
//!
//! The 256-bit master key lives in the Windows Credential Manager (DPAPI,
//! per-user) when available. Elsewhere — or if the credential store is not
//! usable — it is kept in a `vault.key` file readable only by the current user.

use crate::error::{AppError, ErrorCode, Result};
use crate::security::secret::SecretString;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand::RngCore;
use std::path::Path;
use zeroize::Zeroizing;

const NONCE_LEN: usize = 12;
const PREFIX: &str = "bbx1:";
const KEY_FILE: &str = "vault.key";
#[cfg(windows)]
const KEYRING_SERVICE: &str = "Brainbox VPS";
#[cfg(windows)]
const KEYRING_USER: &str = "vault-master-key";

pub struct Vault {
    key: Zeroizing<[u8; 32]>,
    pub backend: &'static str,
}

impl std::fmt::Debug for Vault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Vault").field("backend", &self.backend).finish()
    }
}

fn vault_err(msg: &str, e: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorCode::Vault, "Credential vault error", msg).details(e.to_string())
}

impl Vault {
    /// Construct from an explicit key (tests).
    pub fn with_key(key: [u8; 32]) -> Self {
        Self { key: Zeroizing::new(key), backend: "memory" }
    }

    /// Open (or initialise) the vault for the given data directory.
    pub fn open(data_dir: &Path) -> Result<Self> {
        #[cfg(windows)]
        {
            if let Some(v) = Self::open_keyring(data_dir) {
                return Ok(v);
            }
        }
        Self::open_file(&data_dir.join(KEY_FILE))
    }

    #[cfg(windows)]
    fn open_keyring(data_dir: &Path) -> Option<Self> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok()?;
        if let Ok(s) = entry.get_password() {
            let raw = Zeroizing::new(B64.decode(s.as_bytes()).ok()?);
            if raw.len() == 32 {
                let mut k = [0u8; 32];
                k.copy_from_slice(&raw);
                return Some(Self { key: Zeroizing::new(k), backend: "windows-credential-manager" });
            }
        }
        // Migrate an existing file key into the credential manager, or create one.
        let file = data_dir.join(KEY_FILE);
        let key = read_key_file(&file).unwrap_or_else(random_key);
        let encoded = Zeroizing::new(B64.encode(&*key));
        if entry.set_password(&encoded).is_ok() {
            if file.exists() {
                let _ = std::fs::remove_file(&file);
            }
            return Some(Self { key, backend: "windows-credential-manager" });
        }
        None
    }

    fn open_file(path: &Path) -> Result<Self> {
        if let Some(k) = read_key_file(path) {
            return Ok(Self { key: k, backend: "key-file" });
        }
        if path.exists() {
            return Err(AppError::new(
                ErrorCode::Vault,
                "Vault key is corrupted",
                "The local vault key file is invalid, so saved passwords cannot be decrypted.",
            )
            .details(path.display().to_string()));
        }
        let key = random_key();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| vault_err("Cannot create data folder", e))?;
        }
        write_private(path, &*key).map_err(|e| vault_err("Cannot write vault key", e))?;
        Ok(Self { key, backend: "key-file" })
    }

    pub fn seal(&self, plaintext: &[u8], record_id: &str) -> Result<String> {
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&*self.key));
        let mut nonce = [0u8; NONCE_LEN];
        rand::thread_rng().fill_bytes(&mut nonce);
        let ct = cipher
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad: record_id.as_bytes() })
            .map_err(|e| vault_err("Encryption failed", e))?;
        let mut blob = Vec::with_capacity(NONCE_LEN + ct.len());
        blob.extend_from_slice(&nonce);
        blob.extend_from_slice(&ct);
        Ok(format!("{PREFIX}{}", B64.encode(blob)))
    }

    pub fn unseal(&self, blob: &str, record_id: &str) -> Result<Zeroizing<Vec<u8>>> {
        let body = blob.strip_prefix(PREFIX).ok_or_else(|| vault_err("Unknown secret format", "missing prefix"))?;
        let raw = B64.decode(body).map_err(|e| vault_err("Secret is corrupted", e))?;
        if raw.len() <= NONCE_LEN {
            return Err(vault_err("Secret is corrupted", "blob too short"));
        }
        let (nonce, ct) = raw.split_at(NONCE_LEN);
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&*self.key));
        let pt = cipher
            .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: record_id.as_bytes() })
            .map_err(|_| {
                AppError::new(
                    ErrorCode::Vault,
                    "Cannot decrypt saved credential",
                    "A saved credential could not be decrypted. It may have been created on another computer or user account.",
                )
                .causes(["Re-enter the password or key for this server"])
            })?;
        Ok(Zeroizing::new(pt))
    }

    pub fn seal_str(&self, s: &SecretString, record_id: &str) -> Result<String> {
        self.seal(s.expose().as_bytes(), record_id)
    }

    pub fn unseal_str(&self, blob: &str, record_id: &str) -> Result<SecretString> {
        let pt = self.unseal(blob, record_id)?;
        let s = std::str::from_utf8(&pt).map_err(|e| vault_err("Secret is not valid text", e))?;
        Ok(SecretString::new(s.to_string()))
    }
}

fn random_key() -> Zeroizing<[u8; 32]> {
    let mut k = Zeroizing::new([0u8; 32]);
    rand::thread_rng().fill_bytes(&mut *k);
    k
}

fn read_key_file(path: &Path) -> Option<Zeroizing<[u8; 32]>> {
    let bytes = Zeroizing::new(std::fs::read(path).ok()?);
    if bytes.len() != 32 {
        return None;
    }
    let mut k = Zeroizing::new([0u8; 32]);
    k.copy_from_slice(&bytes);
    Some(k)
}

#[cfg(unix)]
fn write_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?;
    f.write_all(data)?;
    f.sync_all()
}

#[cfg(not(unix))]
fn write_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    // %APPDATA% is per-user; the key file inherits the user-only ACL.
    std::fs::write(path, data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_aad_binding() {
        let v = Vault::with_key([7u8; 32]);
        let blob = v.seal(b"s3cret", "srv1:password").unwrap();
        assert!(blob.starts_with(PREFIX));
        assert!(!blob.contains("s3cret"));
        assert_eq!(&*v.unseal(&blob, "srv1:password").unwrap(), b"s3cret");
        // Swapping a blob to another record must fail.
        assert!(v.unseal(&blob, "srv2:password").is_err());
    }

    #[test]
    fn nonces_are_unique() {
        let v = Vault::with_key([1u8; 32]);
        assert_ne!(v.seal(b"x", "a").unwrap(), v.seal(b"x", "a").unwrap());
    }

    #[test]
    fn wrong_key_fails() {
        let a = Vault::with_key([1u8; 32]);
        let b = Vault::with_key([2u8; 32]);
        let blob = a.seal(b"pw", "id").unwrap();
        assert!(b.unseal(&blob, "id").is_err());
    }

    #[test]
    fn file_backend_persists_key() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(KEY_FILE);
        let v1 = Vault::open_file(&p).unwrap();
        let blob = v1.seal(b"keep", "r").unwrap();
        let v2 = Vault::open_file(&p).unwrap();
        assert_eq!(&*v2.unseal(&blob, "r").unwrap(), b"keep");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn corrupted_key_file_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join(KEY_FILE);
        std::fs::write(&p, b"short").unwrap();
        assert!(Vault::open_file(&p).is_err());
    }
}
