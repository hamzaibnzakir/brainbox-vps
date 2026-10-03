//! Background transfer manager.
//!
//! Transfers run on their own SFTP sessions, independent of any UI panel.
//! Each job writes to a `.bbxpart` file and renames it into place when done,
//! so an interrupted transfer never leaves a truncated file under the real
//! name. Pause stops at a chunk boundary and keeps the partial file; resume
//! and retry continue from the bytes already written.

use super::ops::{atomic_replace, file_name, join, mkdir_p, parent};
use crate::error::{humanize_fs_io, humanize_sftp, AppError, ErrorCode, Result};
use crate::events::{names, EventSinkExt, SharedSink};
use crate::model::{AppNotification, TransferDirection, TransferInfo, TransferRequest, TransferState};
use crate::ssh::{ConnectionManager, ServerConnection};
use crate::storage::now;
use parking_lot::Mutex;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{watch, Semaphore};

pub const PART_SUFFIX: &str = ".bbxpart";
const CHUNK: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ctl {
    Run,
    Pause,
    Cancel,
}

#[derive(Debug, Clone)]
struct Item {
    local: PathBuf,
    remote: String,
    size: u64,
    done: u64,
    complete: bool,
    is_dir: bool,
}

struct Job {
    req: TransferRequest,
    info: Mutex<TransferInfo>,
    items: tokio::sync::Mutex<Option<Vec<Item>>>,
    ctl: watch::Sender<Ctl>,
    running: Mutex<bool>,
}

pub struct TransferManager {
    conns: Arc<ConnectionManager>,
    sink: SharedSink,
    jobs: Mutex<Vec<Arc<Job>>>,
    sem: Mutex<Arc<Semaphore>>,
    min_notify_secs: Mutex<u64>,
}

struct Speed {
    window_start: Instant,
    window_bytes: u64,
    bps: f64,
}

impl Speed {
    fn new() -> Self {
        Self { window_start: Instant::now(), window_bytes: 0, bps: 0.0 }
    }
    fn add(&mut self, n: u64) {
        self.window_bytes += n;
        let el = self.window_start.elapsed().as_secs_f64();
        if el >= 0.5 {
            let inst = self.window_bytes as f64 / el;
            self.bps = if self.bps == 0.0 { inst } else { self.bps * 0.6 + inst * 0.4 };
            self.window_start = Instant::now();
            self.window_bytes = 0;
        }
    }
}

impl TransferManager {
    pub fn new(conns: Arc<ConnectionManager>, sink: SharedSink, concurrency: usize) -> Arc<Self> {
        Arc::new(Self {
            conns,
            sink,
            jobs: Mutex::new(Vec::new()),
            sem: Mutex::new(Arc::new(Semaphore::new(concurrency.max(1)))),
            min_notify_secs: Mutex::new(10),
        })
    }

    pub fn set_concurrency(&self, n: usize) {
        *self.sem.lock() = Arc::new(Semaphore::new(n.max(1)));
    }

    pub fn set_min_notify_secs(&self, s: u64) {
        *self.min_notify_secs.lock() = s;
    }

    fn find(&self, id: &str) -> Result<Arc<Job>> {
        self.jobs.lock().iter().find(|j| j.info.lock().id == id).cloned().ok_or_else(|| {
            AppError::new(ErrorCode::NotFound, "Transfer not found", "This transfer no longer exists.")
        })
    }

    fn publish(&self, job: &Job) {
        let info = job.info.lock().clone();
        self.sink.emit(names::TRANSFER, &info);
    }

    pub fn list(&self) -> Vec<TransferInfo> {
        self.jobs.lock().iter().map(|j| j.info.lock().clone()).collect()
    }

    pub fn get(&self, id: &str) -> Result<TransferInfo> {
        Ok(self.find(id)?.info.lock().clone())
    }

    pub fn enqueue(self: &Arc<Self>, req: TransferRequest) -> Result<TransferInfo> {
        if req.local_path.trim().is_empty() || req.remote_path.trim().is_empty() {
            return Err(AppError::invalid("Both a local and a remote path are required."));
        }
        let name = match req.direction {
            TransferDirection::Upload => Path::new(&req.local_path).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
            TransferDirection::Download => file_name(&req.remote_path),
        };
        let info = TransferInfo {
            id: uuid::Uuid::new_v4().to_string(),
            server_id: req.server_id.clone(),
            direction: req.direction,
            name,
            local_path: req.local_path.clone(),
            remote_path: req.remote_path.clone(),
            is_dir: false,
            state: TransferState::Queued,
            total_bytes: 0,
            transferred_bytes: 0,
            files_total: 0,
            files_done: 0,
            speed_bps: 0.0,
            eta_secs: None,
            current_file: None,
            error: None,
            created_at: now(),
            started_at: None,
            finished_at: None,
        };
        let job = Arc::new(Job { req, info: Mutex::new(info.clone()), items: tokio::sync::Mutex::new(None), ctl: watch::channel(Ctl::Run).0, running: Mutex::new(false) });
        self.jobs.lock().push(job.clone());
        self.publish(&job);
        self.spawn(job);
        Ok(info)
    }

    fn spawn(self: &Arc<Self>, job: Arc<Job>) {
        {
            let mut r = job.running.lock();
            if *r {
                return;
            }
            *r = true;
        }
        let me = self.clone();
        crate::rt::spawn(async move {
            me.run(job.clone()).await;
            *job.running.lock() = false;
        });
    }

    pub fn pause(&self, id: &str) -> Result<()> {
        let job = self.find(id)?;
        let st = job.info.lock().state;
        if matches!(st, TransferState::Running | TransferState::Queued) {
            job.ctl.send_replace(Ctl::Pause);
            if st == TransferState::Queued {
                job.info.lock().state = TransferState::Paused;
                self.publish(&job);
            }
        }
        Ok(())
    }

    pub fn resume(self: &Arc<Self>, id: &str) -> Result<()> {
        let job = self.find(id)?;
        let st = job.info.lock().state;
        if matches!(st, TransferState::Paused | TransferState::Failed) {
            job.ctl.send_replace(Ctl::Run);
            {
                let mut i = job.info.lock();
                i.state = TransferState::Queued;
                i.error = None;
                i.finished_at = None;
            }
            self.publish(&job);
            self.spawn(job);
        }
        Ok(())
    }

    pub fn retry(self: &Arc<Self>, id: &str) -> Result<()> {
        self.resume(id)
    }

    pub async fn cancel(&self, id: &str) -> Result<()> {
        let job = self.find(id)?;
        let st = job.info.lock().state;
        match st {
            TransferState::Running | TransferState::Queued => {
                job.ctl.send_replace(Ctl::Cancel);
                // A queued job waiting for a permit notices via the watch.
            }
            TransferState::Paused | TransferState::Failed => {
                job.ctl.send_replace(Ctl::Cancel);
                self.cleanup_parts(&job).await;
                let mut i = job.info.lock();
                i.state = TransferState::Cancelled;
                i.finished_at = Some(now());
                drop(i);
                self.publish(&job);
            }
            _ => {}
        }
        Ok(())
    }

    /// Remove finished (completed/cancelled/failed) jobs from the list.
    pub fn clear_finished(&self) {
        self.jobs.lock().retain(|j| !matches!(j.info.lock().state, TransferState::Completed | TransferState::Cancelled));
    }

    async fn cleanup_parts(&self, job: &Job) {
        let items = job.items.lock().await.clone().unwrap_or_default();
        match job.req.direction {
            TransferDirection::Download => {
                for it in items.iter().filter(|i| !i.complete && !i.is_dir) {
                    let _ = tokio::fs::remove_file(part_local(&it.local)).await;
                }
            }
            TransferDirection::Upload => {
                if let Ok(conn) = self.conns.require(&job.req.server_id) {
                    if let Ok(s) = conn.sftp().await {
                        for it in items.iter().filter(|i| !i.complete && !i.is_dir) {
                            let _ = s.remove_file(format!("{}{PART_SUFFIX}", it.remote)).await;
                        }
                    }
                }
            }
        }
    }

    async fn run(self: &Arc<Self>, job: Arc<Job>) {
        let mut ctl = job.ctl.subscribe();
        // Wait for a slot.
        let sem = self.sem.lock().clone();
        let permit = tokio::select! {
            p = sem.acquire_owned() => match p { Ok(p) => p, Err(_) => return },
            _ = async {
                loop {
                    if ctl.changed().await.is_err() {
                        break;
                    }
                    if *ctl.borrow() != Ctl::Run {
                        break;
                    }
                }
            } => {
                let c = *ctl.borrow();
                if c == Ctl::Cancel {
                    let mut i = job.info.lock();
                    i.state = TransferState::Cancelled;
                    i.finished_at = Some(now());
                    drop(i);
                    self.publish(&job);
                } else {
                    job.info.lock().state = TransferState::Paused;
                    self.publish(&job);
                }
                return;
            }
        };
        {
            let mut i = job.info.lock();
            i.state = TransferState::Running;
            i.started_at.get_or_insert(now());
        }
        self.publish(&job);
        let started = Instant::now();
        let result = self.execute(&job, &mut ctl).await;
        drop(permit);
        let final_state = match &result {
            Ok(()) => TransferState::Completed,
            Err(e) if e.code == ErrorCode::Cancelled => {
                if *job.ctl.borrow() == Ctl::Pause {
                    TransferState::Paused
                } else {
                    self.cleanup_parts(&job).await;
                    TransferState::Cancelled
                }
            }
            Err(_) => TransferState::Failed,
        };
        {
            let mut i = job.info.lock();
            i.state = final_state;
            i.speed_bps = 0.0;
            i.eta_secs = None;
            if final_state != TransferState::Paused {
                i.finished_at = Some(now());
            }
            if let Err(e) = &result {
                if final_state == TransferState::Failed {
                    i.error = Some(e.clone());
                }
            }
            if final_state == TransferState::Completed {
                i.current_file = None;
            }
        }
        self.publish(&job);
        if final_state == TransferState::Completed && started.elapsed() >= Duration::from_secs(*self.min_notify_secs.lock()) {
            let i = job.info.lock().clone();
            let verb = if i.direction == TransferDirection::Upload { "Upload" } else { "Download" };
            self.sink.emit(
                names::NOTIFY,
                &AppNotification { kind: "transfer_finished".into(), title: format!("{verb} finished"), body: i.name.clone(), server_id: Some(i.server_id.clone()) },
            );
        }
    }

    async fn execute(&self, job: &Arc<Job>, ctl: &mut watch::Receiver<Ctl>) -> Result<()> {
        let conn = self.conns.require(&job.req.server_id)?;
        let s = conn.new_sftp().await?;
        // Plan once; later runs (resume/retry) reuse the plan.
        {
            let mut items = job.items.lock().await;
            if items.is_none() {
                let planned = match job.req.direction {
                    TransferDirection::Upload => plan_upload(&s, &job.req).await?,
                    TransferDirection::Download => plan_download(&s, &job.req).await?,
                };
                let mut i = job.info.lock();
                i.is_dir = planned.iter().any(|x| x.is_dir);
                i.total_bytes = planned.iter().filter(|x| !x.is_dir).map(|x| x.size).sum();
                i.files_total = planned.iter().filter(|x| !x.is_dir).count() as u32;
                *items = Some(planned);
            }
        }
        self.publish(job);

        let mut speed = Speed::new();
        let mut last_pub = Instant::now();
        let n = job.items.lock().await.as_ref().map(|v| v.len()).unwrap_or(0);
        for idx in 0..n {
            let item = job.items.lock().await.as_ref().unwrap()[idx].clone();
            if item.complete {
                continue;
            }
            if item.is_dir {
                match job.req.direction {
                    TransferDirection::Upload => mkdir_p(&s, &item.remote).await?,
                    TransferDirection::Download => tokio::fs::create_dir_all(&item.local).await.map_err(|e| humanize_fs_io(&e, &item.local.to_string_lossy()))?,
                }
                job.items.lock().await.as_mut().unwrap()[idx].complete = true;
                continue;
            }
            job.info.lock().current_file = Some(match job.req.direction {
                TransferDirection::Upload => item.local.to_string_lossy().to_string(),
                TransferDirection::Download => item.remote.clone(),
            });
            let mut on_progress = |delta: u64, done: u64| {
                speed.add(delta);
                let mut i = job.info.lock();
                i.transferred_bytes += delta;
                i.speed_bps = speed.bps;
                let remaining = i.total_bytes.saturating_sub(i.transferred_bytes);
                i.eta_secs = if speed.bps > 1.0 { Some((remaining as f64 / speed.bps) as u64) } else { None };
                drop(i);
                let _ = done;
                if last_pub.elapsed() >= Duration::from_millis(250) {
                    last_pub = Instant::now();
                    self.publish(job);
                }
            };
            let res = match job.req.direction {
                TransferDirection::Upload => upload_file(&conn, &s, &item, ctl, &mut on_progress).await,
                TransferDirection::Download => download_file(&s, &item, ctl, &mut on_progress).await,
            };
            match res {
                Ok(()) => {
                    let mut items = job.items.lock().await;
                    let it = &mut items.as_mut().unwrap()[idx];
                    it.complete = true;
                    it.done = it.size;
                    job.info.lock().files_done += 1;
                }
                Err((done, e)) => {
                    // Remember progress so resume continues from here.
                    job.items.lock().await.as_mut().unwrap()[idx].done = done;
                    return Err(e);
                }
            }
        }
        Ok(())
    }
}

fn part_local(p: &Path) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(PART_SUFFIX);
    PathBuf::from(s)
}

async fn plan_upload(s: &SftpSession, req: &TransferRequest) -> Result<Vec<Item>> {
    let local = PathBuf::from(&req.local_path);
    let meta = tokio::fs::metadata(&local).await.map_err(|e| humanize_fs_io(&e, &req.local_path))?;
    let base_remote = req.remote_path.clone();
    if !req.overwrite {
        if let Ok(m) = s.metadata(base_remote.clone()).await {
            if !(meta.is_dir() && m.is_dir()) {
                return Err(AppError::new(ErrorCode::AlreadyExists, "File already exists", format!("\"{}\" already exists on the server.", file_name(&base_remote)))
                    .causes(["Choose Replace to overwrite it"]));
            }
        }
    }
    if let Some(p) = parent(&base_remote) {
        mkdir_p(s, &p).await?;
    }
    if !meta.is_dir() {
        return Ok(vec![Item { local, remote: base_remote, size: meta.len(), done: 0, complete: false, is_dir: false }]);
    }
    let mut out = vec![Item { local: local.clone(), remote: base_remote.clone(), size: 0, done: 0, complete: false, is_dir: true }];
    let mut stack = vec![(local.clone(), base_remote.clone())];
    while let Some((ldir, rdir)) = stack.pop() {
        let mut rd = tokio::fs::read_dir(&ldir).await.map_err(|e| humanize_fs_io(&e, &ldir.to_string_lossy()))?;
        let mut children = Vec::new();
        while let Some(e) = rd.next_entry().await.map_err(|e| humanize_fs_io(&e, &ldir.to_string_lossy()))? {
            children.push(e);
        }
        children.sort_by_key(|e| e.file_name());
        for e in children {
            let ft = e.file_type().await.map_err(|er| humanize_fs_io(&er, &e.path().to_string_lossy()))?;
            let name = e.file_name().to_string_lossy().to_string();
            let r = join(&rdir, &name);
            if ft.is_dir() {
                out.push(Item { local: e.path(), remote: r.clone(), size: 0, done: 0, complete: false, is_dir: true });
                stack.push((e.path(), r));
            } else if ft.is_file() {
                let size = e.metadata().await.map(|m| m.len()).unwrap_or(0);
                out.push(Item { local: e.path(), remote: r, size, done: 0, complete: false, is_dir: false });
            }
        }
    }
    Ok(out)
}

async fn plan_download(s: &SftpSession, req: &TransferRequest) -> Result<Vec<Item>> {
    let m = s.metadata(req.remote_path.clone()).await.map_err(|e| humanize_sftp(&e, &req.remote_path))?;
    let local = PathBuf::from(&req.local_path);
    if !req.overwrite && local.exists() && !(m.is_dir() && local.is_dir()) {
        return Err(AppError::new(ErrorCode::AlreadyExists, "File already exists", format!("\"{}\" already exists on this computer.", local.display()))
            .causes(["Choose Replace to overwrite it"]));
    }
    if let Some(p) = local.parent() {
        tokio::fs::create_dir_all(p).await.map_err(|e| humanize_fs_io(&e, &p.to_string_lossy()))?;
    }
    if !m.is_dir() {
        return Ok(vec![Item { local, remote: req.remote_path.clone(), size: m.size.unwrap_or(0), done: 0, complete: false, is_dir: false }]);
    }
    let mut out = vec![Item { local: local.clone(), remote: req.remote_path.clone(), size: 0, done: 0, complete: false, is_dir: true }];
    let mut stack = vec![(req.remote_path.clone(), local)];
    while let Some((rdir, ldir)) = stack.pop() {
        let rd = s.read_dir(rdir.clone()).await.map_err(|e| humanize_sftp(&e, &rdir))?;
        let mut children: Vec<_> = rd.collect();
        children.sort_by_key(|e| e.file_name());
        for e in children {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let md = e.metadata();
            let r = join(&rdir, &name);
            let l = ldir.join(sanitize_local_name(&name));
            if md.is_dir() {
                out.push(Item { local: l.clone(), remote: r.clone(), size: 0, done: 0, complete: false, is_dir: true });
                stack.push((r, l));
            } else if md.is_regular() {
                out.push(Item { local: l, remote: r, size: md.size.unwrap_or(0), done: 0, complete: false, is_dir: false });
            }
        }
    }
    Ok(out)
}

/// Make a remote filename valid on Windows.
pub fn sanitize_local_name(name: &str) -> String {
    let mut s: String = name.chars().map(|c| if "<>:\"\\|?*".contains(c) || (c as u32) < 32 { '_' } else { c }).collect();
    while s.ends_with('.') || s.ends_with(' ') {
        s.pop();
        s.push('_');
    }
    let upper = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "LPT1", "LPT2", "LPT3"].contains(&upper.as_str()) {
        s = format!("_{s}");
    }
    if s.is_empty() { "_".into() } else { s }
}

fn check(ctl: &watch::Receiver<Ctl>) -> Option<AppError> {
    match *ctl.borrow() {
        Ctl::Run => None,
        _ => Some(AppError::cancelled()),
    }
}

type Fail = (u64, AppError);

async fn upload_file(
    conn: &ServerConnection,
    s: &SftpSession,
    item: &Item,
    ctl: &watch::Receiver<Ctl>,
    on_progress: &mut impl FnMut(u64, u64),
) -> std::result::Result<(), Fail> {
    let part = format!("{}{PART_SUFFIX}", item.remote);
    // Resume from the real size of the partial file on the server.
    let mut offset = match s.metadata(part.clone()).await {
        Ok(m) => m.size.unwrap_or(0).min(item.size),
        Err(_) => 0,
    };
    let mut local = tokio::fs::File::open(&item.local).await.map_err(|e| (offset, humanize_fs_io(&e, &item.local.to_string_lossy())))?;
    let flags = if offset == 0 { OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE } else { OpenFlags::CREATE | OpenFlags::WRITE };
    let mut remote = s.open_with_flags(part.clone(), flags).await.map_err(|e| (offset, humanize_sftp(&e, &item.remote)))?;
    if offset > 0 {
        local.seek(std::io::SeekFrom::Start(offset)).await.map_err(|e| (offset, humanize_fs_io(&e, "")))?;
        remote.seek(std::io::SeekFrom::Start(offset)).await.map_err(|e| (offset, AppError::new(ErrorCode::Io, "Resume failed", "Could not resume the upload.").details(e.to_string())))?;
    }
    // Account for bytes already present when resuming.
    if offset > item.done {
        on_progress(offset - item.done, offset);
    }
    let mut buf = vec![0u8; CHUNK];
    loop {
        if let Some(e) = check(ctl) {
            let _ = remote.shutdown().await;
            return Err((offset, e));
        }
        let n = local.read(&mut buf).await.map_err(|e| (offset, humanize_fs_io(&e, &item.local.to_string_lossy())))?;
        if n == 0 {
            break;
        }
        remote.write_all(&buf[..n]).await.map_err(|e| {
            (offset, AppError::new(ErrorCode::Io, "Upload interrupted", format!("Writing \"{}\" to the server failed.", file_name(&item.remote)))
                .causes(["The connection may have dropped — retry to continue where it stopped", "The server disk may be full"])
                .details(e.to_string()))
        })?;
        offset += n as u64;
        on_progress(n as u64, offset);
    }
    remote.shutdown().await.map_err(|e| (offset, AppError::new(ErrorCode::Io, "Upload failed", "Could not finish writing the file.").details(e.to_string())))?;
    drop(remote);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(m) = std::fs::metadata(&item.local) {
            let attrs = russh_sftp::client::fs::Metadata { permissions: Some(m.permissions().mode() & 0o7777), size: None, uid: None, gid: None, user: None, group: None, atime: None, mtime: None };
            let _ = s.set_metadata(part.clone(), attrs).await;
        }
    }
    atomic_replace(conn, s, &part, &item.remote).await.map_err(|e| (offset, e))?;
    Ok(())
}

async fn download_file(
    s: &SftpSession,
    item: &Item,
    ctl: &watch::Receiver<Ctl>,
    on_progress: &mut impl FnMut(u64, u64),
) -> std::result::Result<(), Fail> {
    let part = part_local(&item.local);
    let mut offset = tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0).min(item.size);
    let mut local = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(offset == 0)
        .open(&part)
        .await
        .map_err(|e| (offset, humanize_fs_io(&e, &part.to_string_lossy())))?;
    let mut remote = s.open(item.remote.clone()).await.map_err(|e| (offset, humanize_sftp(&e, &item.remote)))?;
    if offset > 0 {
        local.set_len(offset).await.map_err(|e| (offset, humanize_fs_io(&e, "")))?;
        local.seek(std::io::SeekFrom::Start(offset)).await.map_err(|e| (offset, humanize_fs_io(&e, "")))?;
        remote.seek(std::io::SeekFrom::Start(offset)).await.map_err(|e| (offset, AppError::new(ErrorCode::Io, "Resume failed", "Could not resume the download.").details(e.to_string())))?;
    }
    if offset > item.done {
        on_progress(offset - item.done, offset);
    }
    let mut buf = vec![0u8; CHUNK];
    loop {
        if let Some(e) = check(ctl) {
            let _ = local.flush().await;
            return Err((offset, e));
        }
        let n = remote.read(&mut buf).await.map_err(|e| {
            (offset, AppError::new(ErrorCode::Io, "Download interrupted", format!("Reading \"{}\" from the server failed.", file_name(&item.remote)))
                .causes(["The connection may have dropped — retry to continue where it stopped"])
                .details(e.to_string()))
        })?;
        if n == 0 {
            break;
        }
        local.write_all(&buf[..n]).await.map_err(|e| (offset, humanize_fs_io(&e, &part.to_string_lossy())))?;
        offset += n as u64;
        on_progress(n as u64, offset);
    }
    local.flush().await.map_err(|e| (offset, humanize_fs_io(&e, "")))?;
    local.sync_all().await.ok();
    drop(local);
    tokio::fs::rename(&part, &item.local).await.map_err(|e| (offset, humanize_fs_io(&e, &item.local.to_string_lossy())))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_safe_names() {
        assert_eq!(sanitize_local_name("a:b?.txt"), "a_b_.txt");
        assert_eq!(sanitize_local_name("CON"), "_CON");
        assert_eq!(sanitize_local_name("trail."), "trail_");
        assert_eq!(sanitize_local_name("ok name.log"), "ok name.log");
    }
}
