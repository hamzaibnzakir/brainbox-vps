//! Remote file operations over SFTP (plus a few safe shell helpers for things
//! SFTP v3 cannot do: copy, atomic replace, search, folder size).

use crate::error::{humanize_sftp, AppError, ErrorCode, Result};
use crate::model::{DirListing, FileEntry, FileKind, TextFile};
use crate::ssh::exec::{exec, exec_ok, ExecOptions};
use crate::ssh::quote::{sh_quote, sh_script};
use crate::ssh::ServerConnection;
use russh_sftp::client::fs::Metadata;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use std::time::UNIX_EPOCH;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const MAX_EDIT_BYTES: u64 = 20 * 1024 * 1024;

pub fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        return name.to_string();
    }
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

pub fn parent(path: &str) -> Option<String> {
    let t = path.trim_end_matches('/');
    if t.is_empty() {
        return None;
    }
    match t.rfind('/') {
        Some(0) => Some("/".into()),
        Some(i) => Some(t[..i].to_string()),
        None => None,
    }
}

pub fn file_name(path: &str) -> String {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or(path).to_string()
}

fn mtime(m: &Metadata) -> Option<i64> {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64)
}

fn kind_of(m: &Metadata) -> FileKind {
    if m.is_symlink() {
        FileKind::Symlink
    } else if m.is_dir() {
        FileKind::Dir
    } else if m.is_regular() {
        FileKind::File
    } else {
        FileKind::Other
    }
}

pub fn entry_from(path: String, name: String, m: &Metadata) -> FileEntry {
    FileEntry {
        hidden: name.starts_with('.'),
        kind: kind_of(m),
        link_is_dir: false,
        size: m.size.unwrap_or(0),
        modified: mtime(m),
        permissions: m.permissions.map(|p| p & 0o7777),
        owner: m.user.clone().or_else(|| m.uid.map(|u| u.to_string())),
        group: m.group.clone().or_else(|| m.gid.map(|g| g.to_string())),
        name,
        path,
    }
}

async fn sftp(conn: &ServerConnection) -> Result<std::sync::Arc<SftpSession>> {
    conn.sftp().await
}

/// Run an SFTP op; if the shared session died (timeout/closed), reopen once.
macro_rules! with_sftp {
    ($conn:expr, $path:expr, |$s:ident| $body:expr) => {{
        let $s = sftp($conn).await?;
        match $body.await {
            Ok(v) => Ok(v),
            Err(e) => {
                let retry = matches!(e, russh_sftp::client::error::Error::Timeout | russh_sftp::client::error::Error::UnexpectedBehavior(_) | russh_sftp::client::error::Error::IO(_));
                if retry && $conn.is_connected() {
                    $conn.invalidate_sftp().await;
                    let $s = sftp($conn).await?;
                    $body.await.map_err(|e| humanize_sftp(&e, $path))
                } else {
                    Err(humanize_sftp(&e, $path))
                }
            }
        }
    }};
}

pub async fn home_dir(conn: &ServerConnection) -> Result<String> {
    with_sftp!(conn, ".", |s| s.canonicalize("."))
}

pub async fn canonicalize(conn: &ServerConnection, path: &str) -> Result<String> {
    let p = path.to_string();
    with_sftp!(conn, path, |s| s.canonicalize(p.clone()))
}

pub async fn list_dir(conn: &ServerConnection, path: &str) -> Result<DirListing> {
    let path = if path.trim().is_empty() || path == "~" { home_dir(conn).await? } else { path.to_string() };
    let p = path.clone();
    let rd = with_sftp!(conn, &path, |s| s.read_dir(p.clone()))?;
    let mut entries: Vec<FileEntry> = rd
        .filter(|e| {
            let n = e.file_name();
            n != "." && n != ".."
        })
        .map(|e| {
            let name = e.file_name();
            entry_from(join(&path, &name), name, &e.metadata())
        })
        .collect();
    // Resolve whether symlinks point at directories (in parallel, bounded).
    let s = sftp(conn).await?;
    let links: Vec<usize> = entries.iter().enumerate().filter(|(_, e)| e.kind == FileKind::Symlink).map(|(i, _)| i).collect();
    for chunk in links.chunks(32) {
        let futs = chunk.iter().map(|&i| {
            let s = s.clone();
            let p = entries[i].path.clone();
            async move { (i, s.metadata(p).await.ok().map(|m| (m.is_dir(), m.size.unwrap_or(0)))) }
        });
        for (i, r) in futures::future::join_all(futs).await {
            if let Some((is_dir, size)) = r {
                entries[i].link_is_dir = is_dir;
                if !is_dir {
                    entries[i].size = size;
                }
            }
        }
    }
    sort_entries(&mut entries);
    Ok(DirListing { parent: parent(&path), path, entries })
}

pub fn sort_entries(entries: &mut [FileEntry]) {
    entries.sort_by(|a, b| {
        let ad = a.kind == FileKind::Dir || a.link_is_dir;
        let bd = b.kind == FileKind::Dir || b.link_is_dir;
        bd.cmp(&ad).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

pub async fn stat(conn: &ServerConnection, path: &str) -> Result<FileEntry> {
    let p = path.to_string();
    let m = with_sftp!(conn, path, |s| s.symlink_metadata(p.clone()))?;
    let mut e = entry_from(path.to_string(), file_name(path), &m);
    if e.kind == FileKind::Symlink {
        if let Ok(t) = with_sftp!(conn, path, |s| s.metadata(p.clone())) {
            e.link_is_dir = t.is_dir();
        }
    }
    Ok(e)
}

pub async fn exists(conn: &ServerConnection, path: &str) -> Result<bool> {
    let p = path.to_string();
    match sftp(conn).await?.symlink_metadata(p).await {
        Ok(_) => Ok(true),
        Err(russh_sftp::client::error::Error::Status(st)) if st.status_code == russh_sftp::protocol::StatusCode::NoSuchFile => Ok(false),
        Err(e) => Err(humanize_sftp(&e, path)),
    }
}

pub async fn mkdir(conn: &ServerConnection, path: &str) -> Result<()> {
    if exists(conn, path).await? {
        return Err(AppError::new(ErrorCode::AlreadyExists, "Already exists", format!("\"{}\" already exists.", file_name(path))));
    }
    let p = path.to_string();
    with_sftp!(conn, path, |s| s.create_dir(p.clone()))
}

/// Create every missing directory along `path` (like `mkdir -p`).
pub async fn mkdir_p(s: &SftpSession, path: &str) -> Result<()> {
    let mut cur = String::new();
    for part in path.split('/') {
        if part.is_empty() {
            if cur.is_empty() {
                cur.push('/');
            }
            continue;
        }
        cur = join(&cur, part);
        match s.metadata(cur.clone()).await {
            Ok(m) if m.is_dir() => continue,
            Ok(_) => return Err(AppError::new(ErrorCode::NotADirectory, "Not a folder", format!("\"{cur}\" exists and is not a folder."))),
            Err(_) => {
                if let Err(e) = s.create_dir(cur.clone()).await {
                    // A concurrent creator may have won the race.
                    if !s.metadata(cur.clone()).await.map(|m| m.is_dir()).unwrap_or(false) {
                        return Err(humanize_sftp(&e, &cur));
                    }
                }
            }
        }
    }
    Ok(())
}

pub async fn create_file(conn: &ServerConnection, path: &str) -> Result<()> {
    let p = path.to_string();
    let f = with_sftp!(conn, path, |s| s.open_with_flags(p.clone(), OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE))?;
    drop(f);
    Ok(())
}

pub async fn rename(conn: &ServerConnection, from: &str, to: &str) -> Result<()> {
    if from == to {
        return Ok(());
    }
    if exists(conn, to).await? {
        return Err(AppError::new(ErrorCode::AlreadyExists, "Name already used", format!("\"{}\" already exists in this folder.", file_name(to))));
    }
    let (f, t) = (from.to_string(), to.to_string());
    with_sftp!(conn, from, |s| s.rename(f.clone(), t.clone()))
}

/// Recursively delete files/folders via SFTP.
pub async fn delete(conn: &ServerConnection, paths: &[String]) -> Result<u32> {
    let s = sftp(conn).await?;
    let mut count = 0u32;
    for p in paths {
        if p.trim().is_empty() || p == "/" {
            return Err(AppError::invalid("Refusing to delete the root folder."));
        }
        count += delete_one(&s, p).await?;
    }
    Ok(count)
}

fn delete_one<'a>(s: &'a SftpSession, path: &'a str) -> futures::future::BoxFuture<'a, Result<u32>> {
    Box::pin(async move {
        let m = s.symlink_metadata(path.to_string()).await.map_err(|e| humanize_sftp(&e, path))?;
        if m.is_dir() && !m.is_symlink() {
            let mut n = 0;
            let rd = s.read_dir(path.to_string()).await.map_err(|e| humanize_sftp(&e, path))?;
            for e in rd {
                let name = e.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                n += delete_one(s, &join(path, &name)).await?;
            }
            s.remove_dir(path.to_string()).await.map_err(|e| humanize_sftp(&e, path))?;
            Ok(n + 1)
        } else {
            s.remove_file(path.to_string()).await.map_err(|e| humanize_sftp(&e, path))?;
            Ok(1)
        }
    })
}

/// Server-side copy (SFTP has no copy primitive).
pub async fn copy(conn: &ServerConnection, from: &str, to: &str) -> Result<()> {
    if exists(conn, to).await? {
        return Err(AppError::new(ErrorCode::AlreadyExists, "Already exists", format!("\"{}\" already exists.", file_name(to))));
    }
    exec_ok(conn, &format!("cp -a -- {} {}", sh_quote(from), sh_quote(to)), "Copying", ExecOptions::timeout(3600)).await?;
    Ok(())
}

/// Move, replacing nothing (rename across directories).
pub async fn move_to(conn: &ServerConnection, from: &str, to_dir: &str) -> Result<String> {
    let dest = join(to_dir, &file_name(from));
    rename(conn, from, &dest).await?;
    Ok(dest)
}

pub async fn chmod(conn: &ServerConnection, path: &str, mode: u32) -> Result<()> {
    let s = sftp(conn).await?;
    let mut m = s.metadata(path.to_string()).await.map_err(|e| humanize_sftp(&e, path))?;
    let ty = m.permissions.unwrap_or(0) & !0o7777;
    let attrs = Metadata { permissions: Some(ty | (mode & 0o7777)), size: None, uid: None, gid: None, user: None, group: None, atime: None, mtime: None };
    m.permissions = attrs.permissions;
    s.set_metadata(path.to_string(), attrs).await.map_err(|e| humanize_sftp(&e, path))
}

/// Decode bytes as text, rejecting binary files.
pub fn decode_text(bytes: &[u8]) -> Result<(String, &'static str)> {
    let probe = &bytes[..bytes.len().min(8192)];
    if probe.contains(&0) {
        return Err(AppError::new(ErrorCode::Unsupported, "Binary file", "This file looks binary and cannot be opened in the text editor.")
            .causes(["Download it to open it with a suitable program"]));
    }
    let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    match std::str::from_utf8(b) {
        Ok(s) => Ok((s.to_string(), if b.len() != bytes.len() { "utf-8-bom" } else { "utf-8" })),
        Err(_) => Ok((b.iter().map(|&c| c as char).collect(), "latin-1")),
    }
}

pub fn encode_text(content: &str, encoding: &str) -> Result<Vec<u8>> {
    match encoding {
        "latin-1" => content
            .chars()
            .map(|c| if (c as u32) <= 0xFF { Ok(c as u8) } else { Err(()) })
            .collect::<std::result::Result<Vec<u8>, ()>>()
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "Cannot save in Latin-1", "The text contains characters that do not exist in this file's encoding.")),
        "utf-8-bom" => {
            let mut v = vec![0xEF, 0xBB, 0xBF];
            v.extend_from_slice(content.as_bytes());
            Ok(v)
        }
        _ => Ok(content.as_bytes().to_vec()),
    }
}

pub async fn read_text(conn: &ServerConnection, path: &str) -> Result<TextFile> {
    let e = stat(conn, path).await?;
    if e.kind == FileKind::Dir || e.link_is_dir {
        return Err(AppError::new(ErrorCode::IsADirectory, "That's a folder", "Folders cannot be opened in the editor."));
    }
    if e.size > MAX_EDIT_BYTES {
        return Err(AppError::new(ErrorCode::Unsupported, "File too large", format!("Files over {} MB cannot be opened in the editor.", MAX_EDIT_BYTES / 1024 / 1024))
            .causes(["Download the file instead", "Use the log viewer to stream large logs"]));
    }
    let s = sftp(conn).await?;
    let mut f = s.open(path.to_string()).await.map_err(|err| humanize_sftp(&err, path))?;
    let mut bytes = Vec::with_capacity(e.size as usize);
    f.read_to_end(&mut bytes).await.map_err(|err| AppError::new(ErrorCode::Io, "Read failed", format!("Could not read \"{path}\".")).details(err.to_string()))?;
    let (content, enc) = decode_text(&bytes)?;
    let eol = if content.contains("\r\n") { "crlf" } else { "lf" };
    Ok(TextFile { path: path.to_string(), content, encoding: enc.to_string(), size: bytes.len() as u64, modified: e.modified, permissions: e.permissions, eol: eol.into() })
}

/// Save a text file *atomically*: write a temp file in the same directory,
/// copy permissions, then rename over the original. If `expected_mtime` is
/// given and the file changed on the server since it was opened, refuse.
pub async fn write_text(
    conn: &ServerConnection,
    path: &str,
    content: &str,
    encoding: &str,
    expected_mtime: Option<i64>,
) -> Result<FileEntry> {
    let bytes = encode_text(content, encoding)?;
    let existing = match stat(conn, path).await {
        Ok(e) => Some(e),
        Err(e) if e.code == ErrorCode::NotFound => None,
        Err(e) => return Err(e),
    };
    if let (Some(exp), Some(cur)) = (expected_mtime, existing.as_ref().and_then(|e| e.modified)) {
        if cur != exp {
            return Err(AppError::new(ErrorCode::AlreadyExists, "File changed on the server", "Someone else modified this file after you opened it.")
                .causes(["Reload the file to see the latest version", "Or use \"Save anyway\" to overwrite their changes"])
                .details(format!("opened mtime {exp}, server mtime {cur}")));
        }
    }
    let dir = parent(path).unwrap_or_else(|| ".".into());
    let tmp = join(&dir, &format!(".{}.bbx-{}.tmp", file_name(path), &uuid::Uuid::new_v4().simple().to_string()[..8]));
    let s = sftp(conn).await?;
    {
        let mut f = s
            .open_with_flags(tmp.clone(), OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE | OpenFlags::EXCLUDE)
            .await
            .map_err(|e| humanize_sftp(&e, path))?;
        let w = async {
            f.write_all(&bytes).await?;
            f.flush().await?;
            f.shutdown().await
        };
        if let Err(e) = w.await {
            let _ = s.remove_file(tmp.clone()).await;
            return Err(AppError::new(ErrorCode::Io, "Save failed", format!("Could not write \"{}\".", file_name(path)))
                .causes(["The disk on the server may be full", "The connection may have dropped"])
                .details(e.to_string()));
        }
    }
    if let Some(perm) = existing.as_ref().and_then(|e| e.permissions) {
        let attrs = Metadata { permissions: Some(perm), size: None, uid: None, gid: None, user: None, group: None, atime: None, mtime: None };
        let _ = s.set_metadata(tmp.clone(), attrs).await;
    }
    if let Err(e) = atomic_replace(conn, &s, &tmp, path).await {
        let _ = s.remove_file(tmp.clone()).await;
        return Err(e);
    }
    stat(conn, path).await
}

/// rename(2) over an existing file. SFTP v3 rename refuses to overwrite, so
/// use `mv -f` (atomic on the same filesystem) and fall back to remove+rename.
pub async fn atomic_replace(conn: &ServerConnection, s: &SftpSession, tmp: &str, dest: &str) -> Result<()> {
    if s.rename(tmp.to_string(), dest.to_string()).await.is_ok() {
        return Ok(());
    }
    let out = exec(conn, &format!("mv -f -- {} {}", sh_quote(tmp), sh_quote(dest)), ExecOptions::timeout(60)).await;
    match out {
        Ok(o) if o.exit_code == Some(0) => Ok(()),
        Ok(o) if o.stderr.to_lowercase().contains("permission denied") => Err(AppError::command_failed("Saving", o.exit_code, &o.stderr)),
        _ => {
            s.remove_file(dest.to_string()).await.map_err(|e| humanize_sftp(&e, dest))?;
            s.rename(tmp.to_string(), dest.to_string()).await.map_err(|e| humanize_sftp(&e, dest))
        }
    }
}

/// Find files by name under `root` (case-insensitive substring).
pub async fn search(conn: &ServerConnection, root: &str, query: &str, limit: u32) -> Result<Vec<FileEntry>> {
    let q = query.replace(['*', '?', '[', ']'], "");
    if q.trim().is_empty() {
        return Ok(vec![]);
    }
    let script = format!(
        "find {} -xdev -maxdepth 12 -iname {} -printf '%y\\t%s\\t%T@\\t%m\\t%u\\t%g\\t%p\\n' 2>/dev/null | head -n {}",
        sh_quote(root),
        sh_quote(&format!("*{q}*")),
        limit.clamp(1, 2000)
    );
    let out = exec(conn, &sh_script(&script), ExecOptions::timeout(60)).await?;
    Ok(parse_find_output(&out.stdout))
}

pub fn parse_find_output(s: &str) -> Vec<FileEntry> {
    s.lines()
        .filter_map(|l| {
            let mut it = l.splitn(7, '\t');
            let ty = it.next()?;
            let size = it.next()?.parse().ok()?;
            let mtime = it.next()?.split('.').next()?.parse().ok();
            let mode = u32::from_str_radix(it.next()?, 8).ok();
            let owner = it.next().map(str::to_string);
            let group = it.next().map(str::to_string);
            let path = it.next()?.to_string();
            let name = file_name(&path);
            Some(FileEntry {
                hidden: name.starts_with('.'),
                kind: match ty {
                    "d" => FileKind::Dir,
                    "f" => FileKind::File,
                    "l" => FileKind::Symlink,
                    _ => FileKind::Other,
                },
                link_is_dir: false,
                size,
                modified: mtime,
                permissions: mode,
                owner,
                group,
                name,
                path,
            })
        })
        .collect()
}

pub async fn dir_size(conn: &ServerConnection, path: &str) -> Result<u64> {
    let out = exec(conn, &sh_script(&format!("du -sb -- {} 2>/dev/null | cut -f1", sh_quote(path))), ExecOptions::timeout(120)).await?;
    out.stdout.trim().parse().map_err(|_| AppError::new(ErrorCode::Unsupported, "Size unavailable", "Could not measure the folder size."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_helpers() {
        assert_eq!(join("/var", "log"), "/var/log");
        assert_eq!(join("/", "etc"), "/etc");
        assert_eq!(parent("/var/log/"), Some("/var".into()));
        assert_eq!(parent("/var"), Some("/".into()));
        assert_eq!(parent("/"), None);
        assert_eq!(file_name("/a/b/c.txt"), "c.txt");
    }

    #[test]
    fn text_decoding() {
        assert_eq!(decode_text(b"hello").unwrap(), ("hello".into(), "utf-8"));
        assert_eq!(decode_text(b"\xEF\xBB\xBFhi").unwrap().1, "utf-8-bom");
        let (s, enc) = decode_text(b"caf\xe9").unwrap();
        assert_eq!(enc, "latin-1");
        assert_eq!(s, "café");
        assert_eq!(encode_text(&s, enc).unwrap(), b"caf\xe9");
        assert!(decode_text(b"ELF\0\0\x01").is_err());
        assert!(encode_text("€", "latin-1").is_err());
    }

    #[test]
    fn find_parsing() {
        let e = parse_find_output("f\t120\t1700000000.5\t644\troot\troot\t/etc/my file.conf\nd\t4096\t1700000001.0\t755\tu\tg\t/etc/x\n");
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].name, "my file.conf");
        assert_eq!(e[0].permissions, Some(0o644));
        assert_eq!(e[1].kind, FileKind::Dir);
    }
}
