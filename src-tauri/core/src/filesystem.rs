//! Local (this computer) file operations for the dual-pane file manager.
//! Only these specific operations are exposed to the UI — never a generic
//! filesystem API.

use crate::error::{humanize_fs_io, AppError, ErrorCode, Result};
use crate::model::{DirListing, FileEntry, FileKind};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub fn home() -> String {
    dirs::home_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| "/".into())
}

fn is_hidden(name: &str, _meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if _meta.file_attributes() & 0x2 != 0 {
            return true;
        }
    }
    name.starts_with('.')
}

pub fn entry(path: &Path) -> Result<FileEntry> {
    let lm = std::fs::symlink_metadata(path).map_err(|e| humanize_fs_io(&e, &path.to_string_lossy()))?;
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.to_string_lossy().to_string());
    let is_link = lm.file_type().is_symlink();
    let target = if is_link { std::fs::metadata(path).ok() } else { None };
    let m = target.as_ref().unwrap_or(&lm);
    Ok(FileEntry {
        hidden: is_hidden(&name, &lm),
        kind: if is_link {
            FileKind::Symlink
        } else if lm.is_dir() {
            FileKind::Dir
        } else if lm.is_file() {
            FileKind::File
        } else {
            FileKind::Other
        },
        link_is_dir: is_link && m.is_dir(),
        size: if m.is_dir() { 0 } else { m.len() },
        modified: m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64),
        permissions: {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                Some(lm.permissions().mode() & 0o7777)
            }
            #[cfg(not(unix))]
            {
                None
            }
        },
        owner: None,
        group: None,
        name,
        path: path.to_string_lossy().to_string(),
    })
}

#[cfg(windows)]
fn drives() -> Vec<FileEntry> {
    (b'A'..=b'Z')
        .filter_map(|c| {
            let root = format!("{}:\\", c as char);
            Path::new(&root).exists().then(|| FileEntry {
                name: format!("{}:", c as char),
                path: root,
                kind: FileKind::Dir,
                link_is_dir: false,
                size: 0,
                modified: None,
                permissions: None,
                owner: None,
                group: None,
                hidden: false,
            })
        })
        .collect()
}

pub fn list(path: &str) -> Result<DirListing> {
    #[cfg(windows)]
    if path.is_empty() {
        return Ok(DirListing { path: String::new(), parent: None, entries: drives() });
    }
    let p = if path.is_empty() { PathBuf::from("/") } else { PathBuf::from(path) };
    let rd = std::fs::read_dir(&p).map_err(|e| humanize_fs_io(&e, path))?;
    let mut entries: Vec<FileEntry> = rd.filter_map(|e| e.ok()).filter_map(|e| entry(&e.path()).ok()).collect();
    crate::sftp::ops::sort_entries(&mut entries);
    let parent = match p.parent() {
        Some(par) => Some(par.to_string_lossy().to_string()),
        None => {
            if cfg!(windows) {
                Some(String::new()) // drive root → "This PC"
            } else {
                None
            }
        }
    };
    Ok(DirListing { path: p.to_string_lossy().to_string(), parent, entries })
}

fn check_name(name: &str) -> Result<()> {
    if name.trim().is_empty() || name.contains(['/', '\\']) || name == "." || name == ".." {
        return Err(AppError::invalid("Enter a valid name."));
    }
    #[cfg(windows)]
    if name.contains(['<', '>', ':', '"', '|', '?', '*']) {
        return Err(AppError::invalid("Windows file names cannot contain < > : \" | ? *"));
    }
    Ok(())
}

pub fn mkdir(dir: &str, name: &str) -> Result<String> {
    check_name(name)?;
    let p = Path::new(dir).join(name);
    std::fs::create_dir(&p).map_err(|e| humanize_fs_io(&e, &p.to_string_lossy()))?;
    Ok(p.to_string_lossy().to_string())
}

pub fn create_file(dir: &str, name: &str) -> Result<String> {
    check_name(name)?;
    let p = Path::new(dir).join(name);
    std::fs::OpenOptions::new().write(true).create_new(true).open(&p).map_err(|e| humanize_fs_io(&e, &p.to_string_lossy()))?;
    Ok(p.to_string_lossy().to_string())
}

pub fn rename(path: &str, new_name: &str) -> Result<String> {
    check_name(new_name)?;
    let src = Path::new(path);
    let dst = src.parent().unwrap_or(Path::new("")).join(new_name);
    if dst.exists() && dst != src {
        return Err(AppError::new(ErrorCode::AlreadyExists, "Name already used", format!("\"{new_name}\" already exists here.")));
    }
    std::fs::rename(src, &dst).map_err(|e| humanize_fs_io(&e, path))?;
    Ok(dst.to_string_lossy().to_string())
}

/// Delete to the Recycle Bin / Trash when possible, otherwise permanently.
pub fn delete(paths: &[String], permanent: bool) -> Result<()> {
    for p in paths {
        let path = Path::new(p);
        if path.parent().is_none() {
            return Err(AppError::invalid("Refusing to delete a drive or root folder."));
        }
        if !permanent
            && trash::delete(path).is_ok() {
                continue;
            }
        let m = std::fs::symlink_metadata(path).map_err(|e| humanize_fs_io(&e, p))?;
        if m.is_dir() {
            std::fs::remove_dir_all(path).map_err(|e| humanize_fs_io(&e, p))?;
        } else {
            std::fs::remove_file(path).map_err(|e| humanize_fs_io(&e, p))?;
        }
    }
    Ok(())
}

fn copy_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    let m = std::fs::symlink_metadata(src)?;
    if m.is_dir() {
        std::fs::create_dir_all(dst)?;
        for e in std::fs::read_dir(src)? {
            let e = e?;
            copy_recursive(&e.path(), &dst.join(e.file_name()))?;
        }
    } else {
        std::fs::copy(src, dst)?;
    }
    Ok(())
}

fn unique_dest(dir: &Path, name: &std::ffi::OsStr) -> PathBuf {
    let base = dir.join(name);
    if !base.exists() {
        return base;
    }
    let stem = Path::new(name).file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = Path::new(name).extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    for i in 2..1000 {
        let c = dir.join(format!("{stem} ({i}){ext}"));
        if !c.exists() {
            return c;
        }
    }
    base
}

pub fn copy(paths: &[String], to_dir: &str) -> Result<Vec<String>> {
    let dir = Path::new(to_dir);
    let mut out = Vec::new();
    for p in paths {
        let src = Path::new(p);
        let name = src.file_name().ok_or_else(|| AppError::invalid("Invalid source path."))?;
        if dir.starts_with(src) {
            return Err(AppError::invalid("Cannot copy a folder into itself."));
        }
        let dst = unique_dest(dir, name);
        copy_recursive(src, &dst).map_err(|e| humanize_fs_io(&e, p))?;
        out.push(dst.to_string_lossy().to_string());
    }
    Ok(out)
}

pub fn move_to(paths: &[String], to_dir: &str) -> Result<Vec<String>> {
    let dir = Path::new(to_dir);
    let mut out = Vec::new();
    for p in paths {
        let src = Path::new(p);
        let name = src.file_name().ok_or_else(|| AppError::invalid("Invalid source path."))?;
        let dst = dir.join(name);
        if dst.exists() {
            return Err(AppError::new(ErrorCode::AlreadyExists, "Already exists", format!("\"{}\" already exists in the destination.", name.to_string_lossy())));
        }
        if std::fs::rename(src, &dst).is_err() {
            // Cross-volume move: copy then delete.
            copy_recursive(src, &dst).map_err(|e| humanize_fs_io(&e, p))?;
            delete(std::slice::from_ref(p), true)?;
        }
        out.push(dst.to_string_lossy().to_string());
    }
    Ok(out)
}

pub fn search(root: &str, query: &str, limit: usize) -> Result<Vec<FileEntry>> {
    let q = query.to_lowercase();
    if q.trim().is_empty() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for e in walkdir::WalkDir::new(root).max_depth(10).into_iter().filter_map(|e| e.ok()) {
        if e.file_name().to_string_lossy().to_lowercase().contains(&q) {
            if let Ok(fe) = entry(e.path()) {
                out.push(fe);
                if out.len() >= limit {
                    break;
                }
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_ops() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path().to_string_lossy().to_string();
        let sub = mkdir(&root, "Sub").unwrap();
        let f = create_file(&root, "a.txt").unwrap();
        std::fs::write(&f, "hello").unwrap();
        assert!(mkdir(&root, "../x").is_err());
        let l = list(&root).unwrap();
        assert_eq!(l.entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), vec!["Sub", "a.txt"]);
        assert_eq!(l.entries[1].size, 5);
        let c = copy(std::slice::from_ref(&f), &root).unwrap();
        assert!(c[0].ends_with("a (2).txt"));
        let r = rename(&c[0], "b.txt").unwrap();
        assert_eq!(rename(&r, "a.txt").unwrap_err().code, ErrorCode::AlreadyExists);
        move_to(std::slice::from_ref(&r), &sub).unwrap();
        assert!(Path::new(&sub).join("b.txt").exists());
        assert_eq!(search(&root, "B.T", 10).unwrap().len(), 1);
        assert!(copy(std::slice::from_ref(&sub), &sub).is_err());
        delete(std::slice::from_ref(&sub), true).unwrap();
        assert!(!Path::new(&sub).exists());
    }
}
