use crate::embed::{E5Embedder, Embedder, FakeEmbedder};
use crate::log::log_line;
use crate::mcp::{serve, Ctx};
use crate::paths::Paths;
use crate::sync::run_sync;
use anyhow::{bail, Result};
use fs2::FileExt;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};

pub const DEFAULT_IDLE_SECS: u64 = 600;
/// Below the smallest `sun_path` (104 bytes on macOS) with room to spare.
const MAX_SOCKET_PATH: usize = 100;
const MAX_HELLO: u64 = 4096;

#[derive(Debug, Clone, Copy)]
pub struct DaemonOpts {
    pub idle_secs: u64,
    pub fake_embedder: bool,
}

impl Default for DaemonOpts {
    fn default() -> Self {
        DaemonOpts {
            idle_secs: DEFAULT_IDLE_SECS,
            fake_embedder: false,
        }
    }
}

pub fn socket_too_long(socket: &Path) -> bool {
    socket.as_os_str().len() > MAX_SOCKET_PATH
}

#[derive(Default)]
struct Sched {
    running: bool,
    pending: bool,
}

struct State {
    ctx: Ctx,
    sched: Mutex<Sched>,
    wake: Condvar,
    /// MCP connections from accept until EOF.
    clients: AtomicUsize,
    /// Model download/load in progress; keeps a hook-started daemon alive on slow links.
    loading: AtomicBool,
    last_active: Mutex<Instant>,
}

impl State {
    fn new(ctx: Ctx) -> State {
        State {
            ctx,
            sched: Mutex::new(Sched::default()),
            wake: Condvar::new(),
            clients: AtomicUsize::new(0),
            loading: AtomicBool::new(false),
            last_active: Mutex::new(Instant::now()),
        }
    }

    fn request_sync(&self) {
        self.sched.lock().unwrap().pending = true;
        self.wake.notify_one();
    }

    fn touch(&self) {
        *self.last_active.lock().unwrap() = Instant::now();
    }

    fn busy(&self) -> bool {
        let s = self.sched.lock().unwrap();
        s.running
            || s.pending
            || self.loading.load(Ordering::SeqCst)
            || self.clients.load(Ordering::SeqCst) > 0
    }
}

/// Runs until idle. Returns `Ok` without doing anything when another daemon of this version
/// holds the daemon lock.
pub fn run(paths: Paths, opts: DaemonOpts) -> Result<()> {
    std::fs::create_dir_all(&paths.data)?;
    let mut lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(paths.daemon_lock())?;
    if lock.try_lock_exclusive().is_err() {
        return Ok(());
    }
    lock.set_len(0)?;
    writeln!(lock, "{}", std::process::id())?;

    let socket = paths.daemon_socket();
    if socket_too_long(&socket) {
        bail!("socket path too long: {}", socket.display());
    }
    // Only the lock holder may replace the socket file.
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket)?;

    // fastembed prefers HF_HOME over our cache dir.
    std::env::remove_var("HF_HOME");
    let embedder: Option<Arc<dyn Embedder>> = if opts.fake_embedder {
        Some(Arc::new(FakeEmbedder))
    } else {
        None
    };
    let state = Arc::new(State::new(Ctx {
        paths: paths.clone(),
        embedder: Arc::new(RwLock::new(embedder)),
    }));
    state.request_sync();

    let st = state.clone();
    std::thread::spawn(move || scheduler(&st));
    if !opts.fake_embedder {
        state.loading.store(true, Ordering::SeqCst);
        let st = state.clone();
        std::thread::spawn(move || {
            let models = st.ctx.paths.models();
            let _ = std::fs::create_dir_all(&models);
            finish_load(&st, E5Embedder::load(&models).map(|e| Arc::new(e) as _));
        });
    }
    let st = state.clone();
    let idle = Duration::from_secs(opts.idle_secs);
    std::thread::spawn(move || idle_watch(&st, idle, &socket, lock));

    for conn in listener.incoming() {
        match conn {
            Ok(stream) => {
                let st = state.clone();
                std::thread::spawn(move || handle_conn(stream, &st));
            }
            Err(e) => {
                log_line(&paths, &format!("daemon accept: {e}"));
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
    Ok(())
}

fn scheduler(st: &State) {
    loop {
        {
            let mut s = st.sched.lock().unwrap();
            while !s.pending {
                s = st.wake.wait(s).unwrap();
            }
            s.pending = false;
            s.running = true;
        }
        let embedder = st.ctx.embedder.read().unwrap().clone();
        let paths = &st.ctx.paths;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_sync(paths, embedder.as_deref())
        }));
        match result {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => log_line(paths, &format!("sync: {e:#}")),
            Err(_) => log_line(paths, "sync: panicked"),
        }
        // touch first so the idle watcher never sees not-busy with a stale last_active.
        st.touch();
        st.sched.lock().unwrap().running = false;
    }
}

/// Installs a loaded model (and requests a sync to embed the backlog) or logs the failure.
/// Either way loading is over: touch, then clear `loading`.
fn finish_load(st: &State, loaded: Result<Arc<dyn Embedder>>) {
    match loaded {
        Ok(e) => {
            *st.ctx.embedder.write().unwrap() = Some(e);
            st.request_sync();
        }
        Err(e) => log_line(&st.ctx.paths, &format!("model load failed: {e:#}")),
    }
    st.touch();
    st.loading.store(false, Ordering::SeqCst);
}

/// Exits the process once nothing has been going on for `idle`. Holds the daemon lock until then.
fn idle_watch(st: &State, idle: Duration, socket: &Path, _lock: std::fs::File) {
    loop {
        std::thread::sleep(Duration::from_secs(1));
        if st.busy() {
            continue;
        }
        if st.last_active.lock().unwrap().elapsed() >= idle {
            let _ = std::fs::remove_file(socket);
            std::process::exit(0);
        }
    }
}

fn handle_conn(stream: UnixStream, st: &State) {
    let Ok(writer) = stream.try_clone() else {
        return;
    };
    let mut reader = BufReader::new(stream);
    let mut hello = String::new();
    if reader
        .by_ref()
        .take(MAX_HELLO)
        .read_line(&mut hello)
        .is_err()
    {
        return;
    }
    let client = serde_json::from_str::<Value>(hello.trim())
        .ok()
        .and_then(|v| v.get("client")?.as_str().map(str::to_string));
    match client.as_deref() {
        Some("mcp") => {
            st.clients.fetch_add(1, Ordering::SeqCst);
            if let Err(e) = serve(&mut reader, &writer, &st.ctx) {
                log_line(&st.ctx.paths, &format!("mcp connection: {e:#}"));
            }
            st.clients.fetch_sub(1, Ordering::SeqCst);
            st.touch();
        }
        Some("sync") => st.request_sync(),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> (tempfile::TempDir, State) {
        let t = tempfile::tempdir().unwrap();
        let st = State::new(Ctx {
            paths: Paths::new(t.path().join("data")),
            embedder: Arc::new(RwLock::new(None)),
        });
        (t, st)
    }

    #[test]
    fn loading_counts_as_busy_until_load_finishes() {
        let (_t, st) = state();
        assert!(!st.busy());
        st.loading.store(true, Ordering::SeqCst);
        assert!(st.busy(), "model loading must block idle exit");
        finish_load(&st, Err(anyhow::anyhow!("offline")));
        assert!(!st.busy(), "failed load must release busy");
        assert!(st.ctx.embedder.read().unwrap().is_none());
    }

    #[test]
    fn successful_load_installs_model_and_requests_sync() {
        let (_t, st) = state();
        st.loading.store(true, Ordering::SeqCst);
        finish_load(&st, Ok(Arc::new(FakeEmbedder)));
        assert!(!st.loading.load(Ordering::SeqCst));
        assert!(st.ctx.embedder.read().unwrap().is_some());
        assert!(st.sched.lock().unwrap().pending);
    }
}
