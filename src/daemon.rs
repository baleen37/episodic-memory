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
use std::sync::atomic::{AtomicUsize, Ordering};
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
    last_active: Mutex<Instant>,
}

impl State {
    fn request_sync(&self) {
        self.sched.lock().unwrap().pending = true;
        self.wake.notify_one();
    }

    fn touch(&self) {
        *self.last_active.lock().unwrap() = Instant::now();
    }

    fn busy(&self) -> bool {
        let s = self.sched.lock().unwrap();
        s.running || s.pending || self.clients.load(Ordering::SeqCst) > 0
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
    let state = Arc::new(State {
        ctx: Ctx {
            paths: paths.clone(),
            embedder: Arc::new(RwLock::new(embedder)),
        },
        sched: Mutex::new(Sched::default()),
        wake: Condvar::new(),
        clients: AtomicUsize::new(0),
        last_active: Mutex::new(Instant::now()),
    });
    state.request_sync();

    let st = state.clone();
    std::thread::spawn(move || scheduler(&st));
    if !opts.fake_embedder {
        let st = state.clone();
        std::thread::spawn(move || load_model(&st));
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
            Err(e) => log_line(&paths, &format!("daemon accept: {e}")),
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
        st.sched.lock().unwrap().running = false;
        st.touch();
    }
}

fn load_model(st: &State) {
    let paths = &st.ctx.paths;
    let _ = std::fs::create_dir_all(paths.models());
    match E5Embedder::load(&paths.models()) {
        Ok(e) => {
            *st.ctx.embedder.write().unwrap() = Some(Arc::new(e));
            st.request_sync();
        }
        Err(e) => log_line(paths, &format!("model load failed: {e:#}")),
    }
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
