use crate::embed::{E5Embedder, Embedder, FakeEmbedder};
use crate::locks;
use crate::log::log_line;
use crate::mcp::{Ctx, serve};
use crate::paths::{Paths, VERSION, try_lock};
use crate::sync::run_sync;
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
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

/// The daemon socket path, or an error when it does not fit in `sun_path`.
pub fn socket_path(paths: &Paths) -> Result<PathBuf> {
    let socket = paths.daemon_socket();
    if socket.as_os_str().len() > MAX_SOCKET_PATH {
        bail!("socket path too long: {}", socket.display());
    }
    Ok(socket)
}

/// The first line a client sends on a daemon connection: `{"client":"<name>"}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "client", rename_all = "lowercase")]
pub enum Hello {
    /// `host_pid`: the Claude Code or Codex process the bridge runs under.
    Mcp {
        #[serde(default)]
        host_pid: Option<u32>,
    },
    Sync,
    Status,
}

impl Hello {
    pub fn line(self) -> String {
        format!(
            "{}\n",
            serde_json::to_string(&self).expect("unit enum serializes")
        )
    }
}

/// The one-line reply to a `Hello::Status` connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Status {
    pub version: String,
    pub clients: u64,
    pub sync_running: bool,
    pub model: String,
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
        locks::lock(&self.sched).pending = true;
        self.wake.notify_one();
    }

    fn touch(&self) {
        *locks::lock(&self.last_active) = Instant::now();
    }

    fn status(&self) -> Status {
        let model = if locks::read(&self.ctx.embedder).is_some() {
            "ready"
        } else if self.ctx.load_failed.load(Ordering::SeqCst) {
            "failed"
        } else {
            "loading"
        };
        let s = locks::lock(&self.sched);
        Status {
            version: VERSION.into(),
            clients: self.clients.load(Ordering::SeqCst) as u64,
            sync_running: s.running || s.pending,
            model: model.into(),
        }
    }

    fn busy(&self) -> bool {
        let s = locks::lock(&self.sched);
        s.running
            || s.pending
            || self.loading.load(Ordering::SeqCst)
            || self.clients.load(Ordering::SeqCst) > 0
    }
}

/// Runs until idle. Returns `Ok` without doing anything when another daemon of this version
/// holds the daemon lock.
pub fn run(paths: &Paths, opts: DaemonOpts) -> Result<()> {
    let Some(mut lock) = try_lock(&paths.daemon_lock())? else {
        return Ok(());
    };
    lock.set_len(0)?;
    writeln!(lock, "{}", std::process::id())?;

    let socket = socket_path(paths)?;
    // Only the lock holder may replace the socket file.
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket)?;

    // fastembed prefers HF_HOME over our cache dir.
    // SAFETY: `run` is only called from `main` on the main thread, and this runs before the
    // daemon spawns any thread, so nothing else reads or writes the environment concurrently.
    unsafe { std::env::remove_var("HF_HOME") };
    let embedder: Option<Arc<dyn Embedder>> = if opts.fake_embedder {
        Some(Arc::new(FakeEmbedder))
    } else {
        None
    };
    let state = Arc::new(State::new(Ctx {
        paths: paths.clone(),
        embedder: Arc::new(RwLock::new(embedder)),
        load_failed: AtomicBool::new(false),
    }));
    state.request_sync();

    let st = state.clone();
    std::thread::spawn(move || {
        scheduler(&st, |paths, embedder| run_sync(paths, embedder).map(drop));
    });
    if !opts.fake_embedder {
        state.loading.store(true, Ordering::SeqCst);
        let st = state.clone();
        std::thread::spawn(move || {
            let models = st.ctx.paths.models();
            let _ = std::fs::create_dir_all(&models);
            load_model(&st, || E5Embedder::load(&models).map(|e| Arc::new(e) as _));
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
                log_line(paths, &format!("daemon accept: {e}"));
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
    Ok(())
}

/// Runs `sync` once per batch of sync requests, forever.
fn scheduler(st: &State, sync: impl Fn(&Paths, Option<&dyn Embedder>) -> Result<()>) {
    loop {
        {
            let mut s = locks::lock(&st.sched);
            while !s.pending {
                s = locks::wait(&st.wake, s);
            }
            s.pending = false;
            s.running = true;
        }
        let embedder = locks::read(&st.ctx.embedder).clone();
        let paths = &st.ctx.paths;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            sync(paths, embedder.as_deref())
        }));
        match result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => log_line(paths, &format!("sync: {e:#}")),
            Err(_) => log_line(paths, "sync: panicked"),
        }
        // touch first so the idle watcher never sees not-busy with a stale last_active.
        st.touch();
        locks::lock(&st.sched).running = false;
    }
}

/// Runs `load` and finishes loading with its result; a panic counts as a failed load so
/// `loading` is always cleared.
fn load_model(st: &State, load: impl FnOnce() -> Result<Arc<dyn Embedder>>) {
    let loaded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(load))
        .unwrap_or_else(|_| Err(anyhow::anyhow!("model load panicked")));
    finish_load(st, loaded);
}

/// Installs a loaded model (and requests a sync to embed the backlog) or logs the failure.
/// Either way loading is over: touch, then clear `loading`.
fn finish_load(st: &State, loaded: Result<Arc<dyn Embedder>>) {
    match loaded {
        Ok(e) => {
            *locks::write(&st.ctx.embedder) = Some(e);
            st.request_sync();
        }
        Err(e) => {
            st.ctx.load_failed.store(true, Ordering::SeqCst);
            log_line(&st.ctx.paths, &format!("model load failed: {e:#}"));
        }
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
        if locks::lock(&st.last_active).elapsed() >= idle {
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
    match serde_json::from_str::<Hello>(hello.trim()).ok() {
        Some(Hello::Mcp { host_pid }) => {
            st.clients.fetch_add(1, Ordering::SeqCst);
            if let Err(e) = serve(&mut reader, &writer, &st.ctx, host_pid) {
                log_line(&st.ctx.paths, &format!("mcp connection: {e:#}"));
            }
            st.clients.fetch_sub(1, Ordering::SeqCst);
            st.touch();
        }
        Some(Hello::Sync) => st.request_sync(),
        // Neither a client nor activity: doctor must not keep the daemon alive.
        Some(Hello::Status) => {
            let status = serde_json::to_string(&st.status()).expect("status serializes");
            let _ = writeln!(&writer, "{status}");
        }
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
            load_failed: AtomicBool::new(false),
        });
        (t, st)
    }

    #[test]
    fn hello_lines_roundtrip_and_accept_bare_mcp() {
        for h in [Hello::Mcp { host_pid: Some(7) }, Hello::Sync, Hello::Status] {
            assert_eq!(serde_json::from_str::<Hello>(h.line().trim()).unwrap(), h);
        }
        assert_eq!(
            serde_json::from_str::<Hello>(r#"{"client":"mcp"}"#).unwrap(),
            Hello::Mcp { host_pid: None }
        );
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
    fn panicking_load_counts_as_failed() {
        let (_t, st) = state();
        st.loading.store(true, Ordering::SeqCst);
        load_model(&st, || panic!("synthetic load panic"));
        assert!(!st.loading.load(Ordering::SeqCst));
        assert_eq!(st.status().model, "failed");
    }

    #[test]
    fn status_reports_model_state() {
        let (_t, st) = state();
        st.loading.store(true, Ordering::SeqCst);
        assert_eq!(st.status().model, "loading");
        finish_load(&st, Err(anyhow::anyhow!("offline")));
        assert_eq!(st.status().model, "failed");
        finish_load(&st, Ok(Arc::new(FakeEmbedder)));
        let s = st.status();
        assert_eq!(s.model, "ready");
        assert_eq!(s.version, VERSION);
        assert_eq!(s.clients, 0);
        assert!(s.sync_running, "load success requested a sync");
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

    #[test]
    fn scheduler_keeps_syncing_after_locks_were_poisoned() {
        let (_t, st) = state();
        let st = Arc::new(st);
        let poison = st.clone();
        let _ = std::thread::spawn(move || {
            let _s = poison.sched.lock().unwrap();
            let _a = poison.last_active.lock().unwrap();
            let _e = poison.ctx.embedder.write().unwrap();
            panic!("synthetic panic while holding daemon locks");
        })
        .join();
        assert!(st.sched.is_poisoned() && st.ctx.embedder.is_poisoned());

        let runs = Arc::new(AtomicUsize::new(0));
        let (sched_st, sched_runs) = (st.clone(), runs.clone());
        std::thread::spawn(move || {
            scheduler(&sched_st, |_, _| {
                sched_runs.fetch_add(1, Ordering::SeqCst);
                Ok(())
            });
        });
        for want in 1..=2 {
            st.request_sync();
            let deadline = Instant::now() + Duration::from_secs(10);
            while runs.load(Ordering::SeqCst) < want || st.status().sync_running {
                assert!(Instant::now() < deadline, "sync {want} never ran");
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        assert!(!st.busy());
    }
}
