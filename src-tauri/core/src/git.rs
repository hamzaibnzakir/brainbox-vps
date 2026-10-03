//! Git repositories on the server, driven through the git CLI.
//! Every action is also something the user could type in the terminal.

use crate::error::{AppError, ErrorCode, Result};
use crate::model::*;
use crate::ssh::exec::{exec, ExecOptions};
use crate::ssh::quote::{sh_quote, sh_script};
use crate::ssh::ServerConnection;

fn git_cmd(repo: &str, args: &str) -> String {
    // Never block on credential prompts; never page.
    sh_script(&format!("GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat git -C {} {args}", sh_quote(repo)))
}

fn git_error(what: &str, out: &ExecOutput) -> AppError {
    let err = format!("{}{}", out.stderr, out.stdout);
    let low = err.to_lowercase();
    if low.contains("command not found") || low.contains("git: not found") {
        return AppError::new(ErrorCode::GitUnavailable, "Git is not installed", "The `git` command is not available on this server.");
    }
    if low.contains("not a git repository") {
        return AppError::new(ErrorCode::NotFound, "Not a Git repository", "This folder is not a Git repository.").details(err.trim().to_string());
    }
    if low.contains("dubious ownership") {
        return AppError::new(ErrorCode::PermissionDenied, "Repository owned by another user", "Git refuses to work in a repository owned by a different user.")
            .causes(["Run in the terminal: git config --global --add safe.directory <path>", "Or connect as the repository owner"])
            .details(err.trim().to_string());
    }
    if low.contains("terminal prompts disabled") || low.contains("could not read username") || low.contains("authentication failed") || low.contains("permission denied (publickey)") {
        return AppError::new(ErrorCode::AuthFailed, "Git needs credentials", "The remote repository asked for credentials.")
            .causes(["Configure an SSH deploy key or a credential helper on the server", "Or run the command in the terminal to enter credentials"])
            .details(err.trim().to_string());
    }
    if low.contains("not possible to fast-forward") || low.contains("diverging branches") {
        return AppError::new(ErrorCode::CommandFailed, "Branches have diverged", "The local and remote branches have diverged, so a fast-forward pull is not possible.")
            .causes(["Resolve it in the terminal (merge or rebase)"])
            .details(err.trim().to_string());
    }
    if low.contains("would be overwritten") || low.contains("please commit your changes") {
        return AppError::new(ErrorCode::CommandFailed, "Local changes in the way", "Uncommitted changes would be overwritten.")
            .causes(["Commit or stash your changes first"])
            .details(err.trim().to_string());
    }
    AppError::command_failed(what, out.exit_code, &err)
}

async fn run(conn: &ServerConnection, repo: &str, args: &str, what: &str, secs: u64) -> Result<String> {
    let out = exec(conn, &git_cmd(repo, args), ExecOptions::timeout(secs)).await?;
    if out.exit_code != Some(0) {
        return Err(git_error(what, &out));
    }
    Ok(out.stdout)
}

/// Find repositories in common locations (or under `root`).
pub async fn discover(conn: &ServerConnection, root: Option<&str>) -> Result<Vec<String>> {
    let roots = match root {
        Some(r) => sh_quote(r),
        None => "\"$HOME\" /var/www /srv /opt /home /root".into(),
    };
    let script = format!("find {roots} -maxdepth 5 -type d -name .git -prune 2>/dev/null | head -n 200");
    let out = exec(conn, &sh_script(&script), ExecOptions::timeout(60)).await?;
    let mut v: Vec<String> = out.stdout.lines().filter_map(|l| l.strip_suffix("/.git")).map(str::to_string).collect();
    v.sort();
    v.dedup();
    Ok(v)
}

pub fn parse_status(path: &str, s: &str) -> GitStatus {
    let mut st = GitStatus { path: path.to_string(), ..Default::default() };
    for l in s.lines() {
        if let Some(h) = l.strip_prefix("# branch.head ") {
            st.branch = (h != "(detached)").then(|| h.to_string());
        } else if let Some(u) = l.strip_prefix("# branch.upstream ") {
            st.upstream = Some(u.to_string());
        } else if let Some(ab) = l.strip_prefix("# branch.ab ") {
            for p in ab.split_whitespace() {
                if let Some(a) = p.strip_prefix('+') {
                    st.ahead = a.parse().unwrap_or(0);
                } else if let Some(b) = p.strip_prefix('-') {
                    st.behind = b.parse().unwrap_or(0);
                }
            }
        } else if let Some(rest) = l.strip_prefix("1 ") {
            let xy = &rest[..2];
            let p = rest.splitn(8, ' ').nth(7).unwrap_or("").to_string();
            st.files.push(GitFileChange { path: p, staged: xy[..1].replace('.', ""), unstaged: xy[1..].replace('.', ""), untracked: false });
        } else if let Some(rest) = l.strip_prefix("2 ") {
            let xy = &rest[..2];
            let p = rest.splitn(9, ' ').nth(8).unwrap_or("").split('\t').next().unwrap_or("").to_string();
            st.files.push(GitFileChange { path: p, staged: xy[..1].replace('.', ""), unstaged: xy[1..].replace('.', ""), untracked: false });
        } else if let Some(rest) = l.strip_prefix("u ") {
            let p = rest.splitn(10, ' ').nth(9).unwrap_or("").to_string();
            st.files.push(GitFileChange { path: p, staged: "U".into(), unstaged: "U".into(), untracked: false });
        } else if let Some(p) = l.strip_prefix("? ") {
            st.files.push(GitFileChange { path: p.to_string(), staged: String::new(), unstaged: "?".into(), untracked: true });
        }
    }
    st
}

pub async fn status(conn: &ServerConnection, repo: &str) -> Result<GitStatus> {
    let out = run(conn, repo, "status --porcelain=v2 --branch", "git status", 60).await?;
    Ok(parse_status(repo, &out))
}

pub fn parse_branches(s: &str) -> Vec<GitBranch> {
    s.lines()
        .filter_map(|l| {
            let v: Vec<&str> = l.split('\t').collect();
            if v.len() < 3 {
                return None;
            }
            let full = v[1];
            let (name, remote) = if let Some(n) = full.strip_prefix("refs/heads/") {
                (n.to_string(), false)
            } else {
                let n = full.strip_prefix("refs/remotes/")?;
                if n.ends_with("/HEAD") {
                    return None;
                }
                (n.to_string(), true)
            };
            Some(GitBranch { name, is_remote: remote, is_current: v[0] == "*", commit: v[2].to_string(), upstream: v.get(3).filter(|u| !u.is_empty()).map(|u| u.to_string()) })
        })
        .collect()
}

pub async fn branches(conn: &ServerConnection, repo: &str) -> Result<Vec<GitBranch>> {
    let out = run(conn, repo, "for-each-ref --format='%(HEAD)%09%(refname)%09%(objectname:short)%09%(upstream:short)' refs/heads refs/remotes", "git branch", 60).await?;
    Ok(parse_branches(&out))
}

pub fn parse_log(s: &str) -> Vec<GitCommit> {
    s.lines()
        .filter_map(|l| {
            let v: Vec<&str> = l.split('\x1f').collect();
            (v.len() >= 5).then(|| GitCommit { hash: v[0].into(), author: v[1].into(), email: v[2].into(), timestamp: v[3].parse().unwrap_or(0), subject: v[4..].join("\x1f") })
        })
        .collect()
}

pub async fn log(conn: &ServerConnection, repo: &str, limit: u32, file: Option<&str>) -> Result<Vec<GitCommit>> {
    let mut args = format!("log --pretty=format:'%H%x1f%an%x1f%ae%x1f%at%x1f%s' -n {}", limit.clamp(1, 1000));
    if let Some(f) = file {
        args.push_str(&format!(" -- {}", sh_quote(f)));
    }
    match run(conn, repo, &args, "git log", 60).await {
        Ok(o) => Ok(parse_log(&o)),
        Err(e) if e.details.as_deref().unwrap_or("").contains("does not have any commits") => Ok(vec![]),
        Err(e) => Err(e),
    }
}

pub async fn diff(conn: &ServerConnection, repo: &str, file: Option<&str>, staged: bool) -> Result<String> {
    let mut args = String::from("diff --no-color");
    if staged {
        args.push_str(" --cached");
    }
    if let Some(f) = file {
        args.push_str(&format!(" -- {}", sh_quote(f)));
    }
    run(conn, repo, &args, "git diff", 60).await
}

pub async fn show(conn: &ServerConnection, repo: &str, hash: &str) -> Result<String> {
    if !hash.chars().all(|c| c.is_ascii_hexdigit()) || hash.len() < 4 {
        return Err(AppError::invalid("Invalid commit hash."));
    }
    run(conn, repo, &format!("show --no-color --stat --patch {hash}"), "git show", 60).await
}

pub async fn action(conn: &ServerConnection, repo: &str, action: GitAction, confirmed: bool) -> Result<String> {
    if !confirmed && action != GitAction::Fetch {
        return Err(AppError::confirmation_required("This Git operation"));
    }
    let (args, what) = match action {
        GitAction::Fetch => ("fetch --all --prune", "git fetch"),
        GitAction::Pull => ("pull --ff-only", "git pull"),
        GitAction::Push => ("push", "git push"),
    };
    let out = exec(conn, &git_cmd(repo, &format!("{args} 2>&1")), ExecOptions::timeout(600)).await?;
    if out.exit_code != Some(0) {
        return Err(git_error(what, &ExecOutput { stderr: out.stdout.clone(), ..out }));
    }
    Ok(out.stdout)
}

pub async fn checkout(conn: &ServerConnection, repo: &str, branch: &str, confirmed: bool) -> Result<String> {
    if !confirmed {
        return Err(AppError::confirmation_required("Switching branches"));
    }
    if branch.is_empty() || branch.starts_with('-') || branch.contains("..") || branch.chars().any(|c| c.is_whitespace() || "~^:?*[\\".contains(c)) {
        return Err(AppError::invalid("Invalid branch name."));
    }
    // Remote branch "origin/x" → create a tracking branch "x".
    let args = match branch.split_once('/') {
        Some((remote, local)) if !local.is_empty() && run(conn, repo, &format!("remote get-url {}", sh_quote(remote)), "git remote", 20).await.is_ok() => {
            format!("checkout --track {} 2>&1 || git checkout {} 2>&1", sh_quote(branch), sh_quote(local))
        }
        _ => format!("checkout {} 2>&1", sh_quote(branch)),
    };
    let out = exec(conn, &git_cmd(repo, &args), ExecOptions::timeout(120)).await?;
    if out.exit_code != Some(0) {
        return Err(git_error("git checkout", &ExecOutput { stderr: out.stdout.clone(), ..out }));
    }
    Ok(out.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn porcelain_v2() {
        let s = "# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b src/app.ts\n1 A. N... 0 100644 100644 0 b new file.txt\n2 R. N... 100644 100644 100644 a b R100 renamed.txt\told.txt\n? untracked.log\n";
        let st = parse_status("/r", s);
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!((st.ahead, st.behind), (2, 1));
        assert_eq!(st.files.len(), 4);
        assert_eq!(st.files[0].path, "src/app.ts");
        assert_eq!(st.files[0].unstaged, "M");
        assert_eq!(st.files[1].path, "new file.txt");
        assert_eq!(st.files[1].staged, "A");
        assert_eq!(st.files[2].path, "renamed.txt");
        assert!(st.files[3].untracked);
    }

    #[test]
    fn branches_and_log() {
        let b = parse_branches("*\trefs/heads/main\tabc123\torigin/main\n \trefs/heads/dev\tdef456\t\n \trefs/remotes/origin/HEAD\tabc\t\n \trefs/remotes/origin/main\tabc123\t\n");
        assert_eq!(b.len(), 3);
        assert!(b[0].is_current);
        assert_eq!(b[2].name, "origin/main");
        assert!(b[2].is_remote);
        let l = parse_log("h1\x1fAda\x1fa@x\x1f1700000000\x1fFix: thing\nh2\x1fBob\x1fb@x\x1f1700000001\x1fInit");
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].subject, "Fix: thing");
    }
}
