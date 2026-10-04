use crate::daemon::{DEFAULT_IDLE_SECS, DaemonOpts, Hello, socket_path};
use crate::log::log_line;
use crate::paths::Paths;
use anyhow::{Result, bail};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const FIRST_BACKOFF: Duration = Duration::from_millis(50);
const MAX_BACKOFF: Duration = Duration::from_millis(500);

/// Starts `<this exe> daemon` detached, forwarding non-default hidden flags.
fn spawn_daemon(opts: &DaemonOpts) -> Result<()> {
    let mut cmd = Command::new(std::env::current_exe()?);
    cmd.arg("daemon");
    if opts.idle_secs != DEFAULT_IDLE_SECS {
        cmd.arg("--idle-secs").arg(opts.idle_secs.to_string());
    }
    if opts.fake_embedder {
        cmd.arg("--fake-embedder");
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()?;
    Ok(())
}

/// Connects to the daemon, spawning it on the first failure and retrying with backoff
/// (50ms doubling to 500ms) until `total` elapses.
pub fn connect_or_spawn(paths: &Paths, opts: &DaemonOpts, total: Duration) -> Result<UnixStream> {
    let socket = socket_path(paths)?;
    if let Ok(s) = UnixStream::connect(&socket) {
        return Ok(s);
    }
    spawn_daemon(opts)?;
    let deadline = Instant::now() + total;
    let mut delay = FIRST_BACKOFF;
    loop {
        std::thread::sleep(delay.min(deadline.saturating_duration_since(Instant::now())));
        if let Ok(s) = UnixStream::connect(&socket) {
            return Ok(s);
        }
        if Instant::now() >= deadline {
            bail!("daemon unavailable");
        }
        delay = (delay * 2).min(MAX_BACKOFF);
    }
}

/// Bridges stdio to a daemon MCP connection until either side closes.
pub fn run_mcp(paths: &Paths, opts: &DaemonOpts) -> Result<()> {
    let stream = connect_or_spawn(paths, opts, MCP_CONNECT_TIMEOUT)?;
    let hello = Hello::Mcp {
        host_pid: Some(std::os::unix::process::parent_id()),
    };
    (&stream).write_all(hello.line().as_bytes())?;

    let mut to_daemon = stream.try_clone()?;
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut std::io::stdin().lock(), &mut to_daemon);
        let _ = to_daemon.shutdown(Shutdown::Write);
    });

    let mut from_daemon = stream;
    let mut out = std::io::stdout().lock();
    let mut buf = [0u8; 8192];
    loop {
        let n = from_daemon.read(&mut buf)?;
        if n == 0 {
            return Ok(());
        }
        out.write_all(&buf[..n])?;
        out.flush()?;
    }
}

/// `SessionStart` hook: asks the daemon for a sync, or starts it (it syncs on startup).
/// Never fails and never writes to stdout.
pub fn run_sync_hook(paths: &Paths, opts: &DaemonOpts) {
    if std::env::var("EPISODIC_MEMORY_DISABLE").as_deref() == Ok("1") {
        return;
    }
    if let Err(e) = try_sync_hook(paths, opts) {
        log_line(paths, &format!("sync hook: {e:#}"));
    }
}

fn try_sync_hook(paths: &Paths, opts: &DaemonOpts) -> Result<()> {
    match UnixStream::connect(socket_path(paths)?) {
        Ok(mut s) => s.write_all(Hello::Sync.line().as_bytes())?,
        Err(_) => spawn_daemon(opts)?,
    }
    Ok(())
}

/// `sync --wait`: asks the daemon (spawning it if absent) for a sync and returns once a sync
/// that started after the request has finished indexing. Embedding is not waited for.
pub fn run_sync_wait(paths: &Paths, opts: &DaemonOpts) -> Result<()> {
    if std::env::var("EPISODIC_MEMORY_DISABLE").as_deref() == Ok("1") {
        return Ok(());
    }
    let mut stream = connect_or_spawn(paths, opts, MCP_CONNECT_TIMEOUT)?;
    stream.write_all(Hello::SyncWait.line().as_bytes())?;
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply)?;
    if reply.is_empty() {
        bail!("daemon closed the connection before the sync finished");
    }
    Ok(())
}
