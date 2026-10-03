//! Runtime access for code that may be called from threads without a Tokio
//! context (e.g. synchronous Tauri commands run on the main thread).
//!
//! Every background task in the core goes through [`spawn`], which uses the
//! current runtime when there is one and otherwise the runtime registered by
//! the host application at startup.

use std::future::Future;
use std::sync::OnceLock;
use tokio::runtime::Handle;
use tokio::task::JoinHandle;

static HANDLE: OnceLock<Handle> = OnceLock::new();

/// Register the runtime used when no Tokio context is active on the caller's thread.
pub fn set_handle(handle: Handle) {
    let _ = HANDLE.set(handle);
}

/// The current runtime, or the registered fallback.
pub fn handle() -> Handle {
    Handle::try_current().unwrap_or_else(|_| {
        HANDLE
            .get()
            .cloned()
            .expect("brainbox_core::rt::set_handle must be called before spawning outside a Tokio runtime")
    })
}

/// Spawn a task on the current or registered runtime.
pub fn spawn<F>(fut: F) -> JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    handle().spawn(fut)
}

#[cfg(test)]
mod tests {
    #[test]
    fn spawns_from_a_plain_thread_after_registration() {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
        super::set_handle(rt.handle().clone());
        let out = std::thread::spawn(|| {
            let h = super::spawn(async { 40 + 2 });
            super::handle().block_on(h).unwrap()
        })
        .join()
        .unwrap();
        assert_eq!(out, 42);
    }
}
