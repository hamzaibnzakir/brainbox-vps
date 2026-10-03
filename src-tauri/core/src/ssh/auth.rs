//! SSH user authentication: password (+ keyboard-interactive fallback),
//! private keys (file or vault-imported, with passphrases) and SSH agents
//! (OpenSSH agent named pipe / Pageant on Windows, SSH_AUTH_SOCK elsewhere).

use super::handler::ClientHandler;
use crate::error::{AppError, ErrorCode, Result};
use crate::model::{AuthMethod, ServerProfile};
use crate::security::SecretString;
use russh::client::{AuthResult, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::{PrivateKeyWithHashAlg, PublicKey};
use russh::MethodKind;
use std::sync::Arc;

/// Secrets needed to authenticate one connection attempt.
#[derive(Default, Clone)]
pub struct Credentials {
    pub password: Option<SecretString>,
    pub passphrase: Option<SecretString>,
    pub key_data: Option<SecretString>,
    pub proxy_password: Option<SecretString>,
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("password", &self.password.is_some())
            .field("passphrase", &self.passphrase.is_some())
            .field("key_data", &self.key_data.is_some())
            .finish()
    }
}

fn auth_failed(user: &str, host: &str, how: &str) -> AppError {
    AppError::new(
        ErrorCode::AuthFailed,
        "Authentication failed",
        format!("The server rejected the {how} for \"{user}\" on {host}."),
    )
    .causes([
        "The username or password/key may be wrong",
        "The server may not allow this authentication method",
        "The account may be locked (e.g. by fail2ban)",
    ])
}

pub fn expand_tilde(p: &str) -> std::path::PathBuf {
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        if let Some(h) = dirs::home_dir() {
            return h.join(rest);
        }
    }
    std::path::PathBuf::from(p)
}

/// Load a private key from vault data or a file, mapping errors to clear messages.
pub fn load_private_key(profile: &ServerProfile, creds: &Credentials) -> Result<russh::keys::PrivateKey> {
    let pass = creds.passphrase.as_ref().map(|p| p.expose());
    let (res, source) = if let Some(data) = &creds.key_data {
        (russh::keys::decode_secret_key(data.expose().trim(), pass), "the imported key".to_string())
    } else if let Some(path) = &profile.key_path {
        let p = expand_tilde(path);
        if !p.exists() {
            return Err(AppError::new(ErrorCode::KeyLoadFailed, "Private key not found", format!("The key file \"{path}\" does not exist."))
                .causes(["The file may have been moved or deleted", "Edit the server and choose the key again"]));
        }
        (russh::keys::load_secret_key(&p, pass), path.clone())
    } else {
        return Err(AppError::new(ErrorCode::KeyLoadFailed, "No private key", "Choose a private key file or import a key for this server."));
    };
    res.map_err(|e| match e {
        russh::keys::Error::KeyIsEncrypted => {
            if pass.is_some() {
                AppError::new(ErrorCode::BadPassphrase, "Wrong passphrase", format!("The passphrase for {source} is incorrect."))
            } else {
                AppError::new(ErrorCode::NeedPassphrase, "Passphrase required", format!("{source} is protected by a passphrase."))
            }
        }
        other => {
            let raw = other.to_string();
            let low = raw.to_lowercase();
            if pass.is_some() && (low.contains("decrypt") || low.contains("pad") || low.contains("crypto") || low.contains("checkint")) {
                AppError::new(ErrorCode::BadPassphrase, "Wrong passphrase", format!("The passphrase for {source} is incorrect.")).details(raw)
            } else {
                AppError::new(ErrorCode::KeyLoadFailed, "Cannot read private key", format!("{source} could not be loaded."))
                    .causes(["The file may not be a private key", "PuTTY .ppk keys must be converted to OpenSSH format (PuTTYgen → Export OpenSSH key)"])
                    .details(raw)
            }
        }
    })
}

async fn rsa_hash(handle: &Handle<ClientHandler>, key_is_rsa: bool) -> Option<russh::keys::HashAlg> {
    if !key_is_rsa {
        return None;
    }
    handle.best_supported_rsa_hash().await.ok().flatten().flatten()
}

pub async fn authenticate(handle: &mut Handle<ClientHandler>, profile: &ServerProfile, creds: &Credentials) -> Result<()> {
    let user = profile.username.clone();
    let host = profile.host.clone();
    let net = |e: russh::Error| crate::error::humanize_russh(&e, &crate::error::NetCtx::ssh(&host, profile.port));

    match profile.auth_method {
        AuthMethod::Password => {
            let Some(pw) = &creds.password else {
                return Err(AppError::new(ErrorCode::NeedPassword, "Password required", format!("Enter the password for {user}@{host}.")));
            };
            let res = handle.authenticate_password(user.clone(), pw.expose()).await.map_err(net)?;
            match res {
                AuthResult::Success => Ok(()),
                AuthResult::Failure { remaining_methods, .. } => {
                    if remaining_methods.contains(&MethodKind::KeyboardInteractive) && keyboard_interactive(handle, &user, pw).await.map_err(net)? {
                        return Ok(());
                    }
                    if !remaining_methods.contains(&MethodKind::Password) && !remaining_methods.is_empty() {
                        let allowed: Vec<&str> = remaining_methods.iter().map(<&str>::from).collect();
                        return Err(AppError::new(
                            ErrorCode::AuthFailed,
                            "Password login not allowed",
                            format!("{host} does not accept password logins."),
                        )
                        .causes([format!("The server only allows: {}", allowed.join(", ")), "Use an SSH key instead".into()]));
                    }
                    Err(auth_failed(&user, &host, "password"))
                }
            }
        }
        AuthMethod::Key => {
            let key = load_private_key(profile, creds)?;
            let is_rsa = matches!(key.algorithm(), russh::keys::Algorithm::Rsa { .. });
            let hash = rsa_hash(handle, is_rsa).await;
            let res = handle
                .authenticate_publickey(user.clone(), PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await
                .map_err(net)?;
            match res {
                AuthResult::Success => Ok(()),
                AuthResult::Failure { .. } => Err(auth_failed(&user, &host, "private key")
                    .causes(["The public key may not be in ~/.ssh/authorized_keys on the server", "The username may be wrong"])),
            }
        }
        AuthMethod::Agent => authenticate_agent(handle, &user, &host).await,
    }
}

async fn keyboard_interactive(handle: &mut Handle<ClientHandler>, user: &str, pw: &SecretString) -> std::result::Result<bool, russh::Error> {
    let mut resp = handle.authenticate_keyboard_interactive_start(user.to_string(), None).await?;
    for _ in 0..5 {
        match resp {
            KeyboardInteractiveAuthResponse::Success => return Ok(true),
            KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                // Answer password-style (no-echo) prompts with the password.
                let answers = prompts.iter().map(|p| if p.echo { String::new() } else { pw.expose().to_string() }).collect();
                resp = handle.authenticate_keyboard_interactive_respond(answers).await?;
            }
        }
    }
    Ok(false)
}

fn agent_unavailable(details: impl Into<String>) -> AppError {
    #[cfg(windows)]
    let causes = [
        "Start the \"OpenSSH Authentication Agent\" Windows service and add your key with ssh-add",
        "Or run Pageant and load your key",
    ];
    #[cfg(not(windows))]
    let causes = ["Start ssh-agent and add your key with ssh-add", "Make sure SSH_AUTH_SOCK is set"];
    AppError::new(ErrorCode::AgentUnavailable, "SSH agent not available", "No running SSH agent was found.").causes(causes).details(details)
}

async fn try_agent_keys<S>(
    handle: &mut Handle<ClientHandler>,
    agent: &mut russh::keys::agent::client::AgentClient<S>,
    user: &str,
) -> Result<Option<bool>>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let ids = agent.request_identities().await.map_err(|e| agent_unavailable(e.to_string()))?;
    let keys: Vec<PublicKey> = ids
        .into_iter()
        .filter_map(|i| match i {
            russh::keys::agent::AgentIdentity::PublicKey { key, .. } => Some(key),
            _ => None,
        })
        .collect();
    if keys.is_empty() {
        return Ok(None);
    }
    for key in keys {
        let is_rsa = matches!(key.algorithm(), russh::keys::Algorithm::Rsa { .. });
        let hash = rsa_hash(handle, is_rsa).await;
        match handle.authenticate_publickey_with(user.to_string(), key, hash, agent).await {
            Ok(AuthResult::Success) => return Ok(Some(true)),
            Ok(_) => continue,
            Err(e) => {
                log::warn!("agent signing failed: {e}");
                continue;
            }
        }
    }
    Ok(Some(false))
}

async fn authenticate_agent(handle: &mut Handle<ClientHandler>, user: &str, host: &str) -> Result<()> {
    #[allow(unused_mut)]
    let mut outcome: Option<bool> = None;
    #[allow(unused_mut)]
    let mut last_err = String::from("no agent");
    #[allow(unused_mut)]
    let mut connected = false;

    #[cfg(windows)]
    {
        use russh::keys::agent::client::AgentClient;
        match AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
            Ok(mut a) => {
                connected = true;
                match try_agent_keys(handle, &mut a, user).await {
                    Ok(o) => outcome = o,
                    Err(e) => last_err = format!("{e:?}"),
                }
            }
            Err(e) => last_err = e.to_string(),
        }
        if outcome != Some(true) {
            if let Ok(mut a) = AgentClient::connect_pageant().await {
                connected = true;
                match try_agent_keys(handle, &mut a, user).await {
                    Ok(Some(true)) => outcome = Some(true),
                    Ok(o) if outcome.is_none() => outcome = o,
                    Ok(_) => {}
                    Err(e) => last_err = format!("{e:?}"),
                }
            }
        }
    }
    #[cfg(unix)]
    {
        match russh::keys::agent::client::AgentClient::connect_env().await {
            Ok(mut a) => {
                connected = true;
                outcome = try_agent_keys(handle, &mut a, user).await?
            }
            Err(e) => last_err = e.to_string(),
        }
    }

    match outcome {
        Some(true) => Ok(()),
        Some(false) => Err(auth_failed(user, host, "agent keys")),
        None if !connected => Err(agent_unavailable(last_err)),
        None => Err(AppError::new(ErrorCode::AgentUnavailable, "No keys in agent", "The SSH agent is running but has no keys loaded.")
            .causes(["Add a key with ssh-add"])),
    }
}
