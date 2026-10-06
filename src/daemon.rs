use crate::embed::{E5Embedder, Embedder, FakeEmbedder, embed_pending};
use crate::locks;
use crate::log::log_line;
use crate::mcp::{Ctx, serve};
use crate::paths::{Paths, VERSION, try_lock};
use crate::sync::{SyncStats, run_sync};
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};

pub const DEFAULT_IDLE_SECS: u64 = 600;
/// Below the smallest `sun_path` (104 bytes on macOS) with room to spare.
const MAX_SOCKET_PATH: usize = 100;
const MAX_HELLO: u64 = 4096;
/// A connection that sends no hello line within this time is closed, so it cannot hold a thread.
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);

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
    /// Like `Sync`, but the daemon replies one line once that sync has finished. Finished means
    /// indexed (keyword-searchable); embedding continues in the background afterwards.
    SyncWait,
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
    /// Sync runs started and finished since daemon start.
    started: u64,
    finished: u64,
}

struct State {
    ctx: Ctx,
    sched: Mutex<Sched>,
    wake: Condvar,
    /// Notified each time a sync run finishes.
    done: Condvar,
    /// MCP connections from accept until EOF.
    clients: AtomicUsize,
    /// Model download/load in progress; keeps a hook-started daemon alive on slow links.
    loading: AtomicBool,
    /// Wakes the embedding worker; capacity 1, so wake-ups during a pass collapse into one.
    embed_wake: SyncSender<()>,
    /// The embedding worker is in a pass.
    embedding: AtomicBool,
    last_active: Mutex<Instant>,
}

impl State {
    /// The state and the receiving end of its embedding wake-up channel.
    fn new(ctx: Ctx) -> (State, Receiver<()>) {
        let (embed_wake, wakes) = sync_channel(1);
        let st = State {
            ctx,
            sched: Mutex::new(Sched::default()),
            wake: Condvar::new(),
            done: Condvar::new(),
            clients: AtomicUsize::new(0),
            loading: AtomicBool::new(false),
            embed_wake,
            embedding: AtomicBool::new(false),
            last_active: Mutex::new(Instant::now()),
        };
        (st, wakes)
    }

    fn wake_embedder(&self) {
        // Full: a queued pass will see these exchanges too. Disconnected: no worker (tests).
        let _ = self.embed_wake.try_send(());
    }

    fn request_sync(&self) {
        locks::lock(&self.sched).pending = true;
        self.wake.notify_one();
    }

    /// Requests a sync and blocks until a run that started after the request has finished.
    fn sync_and_wait(&self) {
        let mut s = locks::lock(&self.sched);
        // A running sync may have read its sources before this request; wait for the next one.
        let target = s.started + 1;
        s.pending = true;
        self.wake.notify_one();
        while s.finished < target {
            s = locks::wait(&self.done, s);
        }
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
            || self.embedding.load(Ordering::SeqCst)
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
    let (state, wakes) = State::new(Ctx {
        paths: paths.clone(),
        embedder: Arc::new(RwLock::new(embedder)),
        load_failed: AtomicBool::new(false),
    });
    let state = Arc::new(state);
    state.request_sync();

    let st = state.clone();
    std::thread::spawn(move || scheduler(&st, run_sync));
    let st = state.clone();
    std::thread::spawn(move || {
        // One connection for the worker's lifetime, opened by the first pass that needs it.
        let mut conn = None;
        embed_worker(&st, &wakes, |paths, e| {
            let c = match &mut conn {
                Some(c) => c,
                None => conn.insert(crate::db::open(&paths.db())?),
            };
            embed_pending(c, e).map(drop)
        });
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

/// How a `guarded` run ended; a failure is already logged.
enum Run<T> {
    Done(T),
    Failed,
    Panicked,
}

/// Runs `f`, catching a panic, and logs an error or a panic as `<label>: ...`.
fn guarded<T>(paths: &Paths, label: &str, f: impl FnOnce() -> Result<T>) -> Run<T> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(Ok(v)) => Run::Done(v),
        Ok(Err(e)) => {
            log_line(paths, &format!("{label}: {e:#}"));
            Run::Failed
        }
        Err(_) => {
            log_line(paths, &format!("{label}: panicked"));
            Run::Panicked
        }
    }
}

/// Runs `sync` once per batch of sync requests, forever, waking the embedding worker after each
/// run that indexed new exchanges (or failed, having maybe indexed some).
fn scheduler(st: &State, sync: impl Fn(&Paths) -> Result<SyncStats>) {
    loop {
        {
            let mut s = locks::lock(&st.sched);
            while !s.pending {
                s = locks::wait(&st.wake, s);
            }
            s.pending = false;
            s.running = true;
            s.started += 1;
        }
        let paths = &st.ctx.paths;
        match guarded(paths, "sync", || sync(paths)) {
            // A migration holds the write lock long enough to fail an embedding batch.
            Run::Done(stats) if stats.new_exchanges == 0 && stats.migrated == 0 => {}
            _ => st.wake_embedder(),
        }
        // touch first so the idle watcher never sees not-busy with a stale last_active.
        st.touch();
        let mut s = locks::lock(&st.sched);
        s.running = false;
        s.finished += 1;
        st.done.notify_all();
    }
}

/// Embeds pending exchanges, one pass per wake-up, until the channel closes. Holds no lock
/// while waiting; a pass only clones the model handle (releasing the read lock at once) and
/// leaves locking to `embed`: one model batch, then one short write transaction, in turn.
fn embed_worker(
    st: &State,
    wakes: &Receiver<()>,
    mut embed: impl FnMut(&Paths, &dyn Embedder) -> Result<()>,
) {
    while wakes.recv().is_ok() {
        let Some(e) = locks::read(&st.ctx.embedder).clone() else {
            continue; // no model yet; `finish_load` wakes us again
        };
        st.embedding.store(true, Ordering::SeqCst);
        let paths = &st.ctx.paths;
        if let Run::Panicked = guarded(paths, "embedding", || embed(paths, e.as_ref()))
            && let Ok(c) = crate::db::open(&paths.db())
        {
            crate::embed::record_embed_error(&c, "embedding panicked");
        }
        st.touch();
        st.embedding.store(false, Ordering::SeqCst);
    }
}

/// Runs `load` and finishes loading with its result; a panic counts as a failed load so
/// `loading` is always cleared.
fn load_model(st: &State, load: impl FnOnce() -> Result<Arc<dyn Embedder>>) {
    let loaded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(load))
        .unwrap_or_else(|_| Err(anyhow::anyhow!("model load panicked")));
    finish_load(st, loaded);
}

/// Installs a loaded model (and wakes the embedding worker for the backlog) or logs the failure.
/// Either way loading is over: touch, then clear `loading`.
fn finish_load(st: &State, loaded: Result<Arc<dyn Embedder>>) {
    match loaded {
        Ok(e) => {
            *locks::write(&st.ctx.embedder) = Some(e);
            st.wake_embedder();
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
    // Fails (EINVAL on macOS) only when the peer already closed; its buffered hello still reads.
    let _ = stream.set_read_timeout(Some(HELLO_TIMEOUT));
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
            // MCP clients stay connected and idle between requests.
            let _ = reader.get_ref().set_read_timeout(None);
            st.clients.fetch_add(1, Ordering::SeqCst);
            if let Err(e) = serve(&mut reader, &writer, &st.ctx, host_pid) {
                log_line(&st.ctx.paths, &format!("mcp connection: {e:#}"));
            }
            st.clients.fetch_sub(1, Ordering::SeqCst);
            st.touch();
        }
        Some(Hello::Sync) => st.request_sync(),
        Some(Hello::SyncWait) => {
            st.sync_and_wait();
            let _ = writeln!(&writer, "done");
        }
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

    fn state() -> (tempfile::TempDir, State, Receiver<()>) {
        let t = tempfile::tempdir().unwrap();
        let (st, wakes) = State::new(Ctx {
            paths: Paths::new(t.path().join("data")),
            embedder: Arc::new(RwLock::new(None)),
            load_failed: AtomicBool::new(false),
        });
        (t, st, wakes)
    }

    #[test]
    fn hello_lines_roundtrip_and_accept_bare_mcp() {
        for h in [
            Hello::Mcp { host_pid: Some(7) },
            Hello::Sync,
            Hello::SyncWait,
            Hello::Status,
        ] {
            assert_eq!(serde_json::from_str::<Hello>(h.line().trim()).unwrap(), h);
        }
        assert_eq!(
            serde_json::from_str::<Hello>(r#"{"client":"mcp"}"#).unwrap(),
            Hello::Mcp { host_pid: None }
        );
    }

    #[test]
    fn loading_counts_as_busy_until_load_finishes() {
        let (_t, st, _wakes) = state();
        assert!(!st.busy());
        st.loading.store(true, Ordering::SeqCst);
        assert!(st.busy(), "model loading must block idle exit");
        finish_load(&st, Err(anyhow::anyhow!("offline")));
        assert!(!st.busy(), "failed load must release busy");
        assert!(st.ctx.embedder.read().unwrap().is_none());
    }

    #[test]
    fn panicking_load_counts_as_failed() {
        let (_t, st, _wakes) = state();
        st.loading.store(true, Ordering::SeqCst);
        load_model(&st, || panic!("synthetic load panic"));
        assert!(!st.loading.load(Ordering::SeqCst));
        assert_eq!(st.status().model, "failed");
    }

    #[test]
    fn status_reports_model_state() {
        let (_t, st, _wakes) = state();
        st.loading.store(true, Ordering::SeqCst);
        assert_eq!(st.status().model, "loading");
        finish_load(&st, Err(anyhow::anyhow!("offline")));
        assert_eq!(st.status().model, "failed");
        finish_load(&st, Ok(Arc::new(FakeEmbedder)));
        let s = st.status();
        assert_eq!(s.model, "ready");
        assert_eq!(s.version, VERSION);
        assert_eq!(s.clients, 0);
        assert!(
            !s.sync_running,
            "a loaded model needs no sync, only embedding"
        );
    }

    #[test]
    fn successful_load_installs_model_and_wakes_embedder() {
        let (_t, st, wakes) = state();
        st.loading.store(true, Ordering::SeqCst);
        finish_load(&st, Ok(Arc::new(FakeEmbedder)));
        assert!(!st.loading.load(Ordering::SeqCst));
        assert!(st.ctx.embedder.read().unwrap().is_some());
        assert!(wakes.try_recv().is_ok());
    }

    #[test]
    fn embed_wakes_collapse_and_worker_survives_a_panicking_pass() {
        let (_t, st, wakes) = state();
        *st.ctx.embedder.write().unwrap() = Some(Arc::new(FakeEmbedder));
        for _ in 0..5 {
            st.wake_embedder();
        }
        st.wake_embedder();
        let st = Arc::new(st);
        let passes = Arc::new(AtomicUsize::new(0));
        let (w_st, w_passes) = (st.clone(), passes.clone());
        std::thread::spawn(move || {
            embed_worker(&w_st, &wakes, |_, _| {
                // The first pass panics.
                assert!(
                    w_passes.fetch_add(1, Ordering::SeqCst) > 0,
                    "synthetic embedding panic"
                );
                Ok(())
            });
        });
        let deadline = Instant::now() + Duration::from_secs(10);
        while passes.load(Ordering::SeqCst) < 1 || st.busy() {
            assert!(Instant::now() < deadline, "first pass never ran");
            std::thread::sleep(Duration::from_millis(10));
        }
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(
            passes.load(Ordering::SeqCst),
            1,
            "six wake-ups ran more than one pass"
        );
        st.wake_embedder();
        while passes.load(Ordering::SeqCst) < 2 {
            assert!(
                Instant::now() < deadline,
                "worker died with the panicking pass"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn sync_wait_returns_once_indexed_while_embedding_still_runs() {
        let (_t, st, wakes) = state();
        *st.ctx.embedder.write().unwrap() = Some(Arc::new(FakeEmbedder));
        let st = Arc::new(st);
        let (release, held) = std::sync::mpsc::channel::<()>();
        let held = Mutex::new(held);
        let w_st = st.clone();
        std::thread::spawn(move || {
            // Every pass blocks until released, like a slow model with a long backlog.
            embed_worker(&w_st, &wakes, |_, _| {
                let _ = held.lock().unwrap().recv();
                Ok(())
            });
        });
        let s_st = st.clone();
        std::thread::spawn(move || scheduler(&s_st, |_| Ok(SyncStats::default())));
        st.wake_embedder();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !st.embedding.load(Ordering::SeqCst) {
            assert!(Instant::now() < deadline, "embedding pass never started");
            std::thread::sleep(Duration::from_millis(10));
        }
        let (done, waited) = std::sync::mpsc::channel();
        let c_st = st.clone();
        std::thread::spawn(move || {
            c_st.sync_and_wait();
            let _ = done.send(());
        });
        waited
            .recv_timeout(Duration::from_secs(5))
            .expect("sync --wait waited for the embedding pass");
        assert!(st.embedding.load(Ordering::SeqCst));
        drop(release);
    }

    #[test]
    fn scheduler_wakes_the_embedder_only_after_new_exchanges() {
        let (_t, st, wakes) = state();
        let st = Arc::new(st);
        let new = Arc::new(AtomicUsize::new(0));
        let (s_st, s_new) = (st.clone(), new.clone());
        std::thread::spawn(move || {
            scheduler(&s_st, |_| {
                Ok(SyncStats {
                    new_exchanges: s_new.load(Ordering::SeqCst),
                    ..SyncStats::default()
                })
            });
        });
        st.sync_and_wait();
        assert!(wakes.try_recv().is_err(), "woke with nothing to embed");
        new.store(3, Ordering::SeqCst);
        st.sync_and_wait();
        assert!(wakes.try_recv().is_ok());
    }

    #[test]
    fn scheduler_wakes_the_embedder_after_a_migration() {
        let (_t, st, wakes) = state();
        let st = Arc::new(st);
        let s_st = st.clone();
        std::thread::spawn(move || {
            scheduler(&s_st, |_| {
                Ok(SyncStats {
                    migrated: 1,
                    ..SyncStats::default()
                })
            });
        });
        st.sync_and_wait();
        assert!(
            wakes.try_recv().is_ok(),
            "an embedding batch may have failed meanwhile"
        );
    }

    #[test]
    fn scheduler_coalesces_requests_made_during_a_run() {
        let (_t, st, _wakes) = state();
        let st = Arc::new(st);
        // Each run blocks until `release` is dropped, so all requests land mid-run.
        let (release, gate) = std::sync::mpsc::channel::<()>();
        let gate = Mutex::new(gate);
        let s_st = st.clone();
        std::thread::spawn(move || {
            scheduler(&s_st, |_| {
                let _ = gate.lock().unwrap().recv();
                Ok(SyncStats::default())
            });
        });
        st.request_sync();
        let deadline = Instant::now() + Duration::from_secs(10);
        while st.sched.lock().unwrap().started < 1 {
            assert!(Instant::now() < deadline, "first sync never started");
            std::thread::sleep(Duration::from_millis(10));
        }
        for _ in 0..10 {
            st.request_sync();
        }
        drop(release);
        while st.status().sync_running {
            assert!(Instant::now() < deadline, "syncs never finished");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(st.sched.lock().unwrap().started, 2);
    }

    #[test]
    fn scheduler_keeps_syncing_after_locks_were_poisoned() {
        let (_t, st, _wakes) = state();
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
            scheduler(&sched_st, |_| {
                sched_runs.fetch_add(1, Ordering::SeqCst);
                Ok(SyncStats::default())
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
