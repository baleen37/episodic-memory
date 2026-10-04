use fs2::FileExt;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::thread;
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_episodic-memory");
const VER: &str = env!("CARGO_PKG_VERSION");
/// Short idle timeout so a leaked daemon cleans itself up.
const IDLE: &str = "5";

static SEQ: AtomicUsize = AtomicUsize::new(0);

struct Env {
    root: PathBuf,
    data: PathBuf,
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        std::fs::copy(e.path(), to.join(e.file_name())).unwrap();
    }
}

impl Env {
    /// `/tmp/em-<pid>-<n>` with fixture copies; `data_name` lets a test lengthen the data path.
    fn with_data(data_name: &str) -> Env {
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let root = PathBuf::from(format!("/tmp/em-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        copy_dir(&fixtures.join("claude"), &root.join("c/projects/demo"));
        copy_dir(&fixtures.join("codex"), &root.join("x/sessions/2026/01/02"));
        let data = root.join(data_name);
        Env { root, data }
    }

    fn new() -> Env {
        Env::with_data("d")
    }

    fn cmd(&self, args: &[&str]) -> Command {
        let mut c = Command::new(BIN);
        c.args(args)
            .env("EPISODIC_MEMORY_DIR", &self.data)
            .env("CLAUDE_CONFIG_DIR", self.root.join("c"))
            .env("CODEX_HOME", self.root.join("x"))
            .env_remove("EPISODIC_MEMORY_DISABLE")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        c
    }

    /// `sub` plus the hidden test flags.
    fn fast(&self, sub: &str) -> Command {
        self.cmd(&[sub, "--fake-embedder", "--idle-secs", IDLE])
    }

    fn socket(&self) -> PathBuf {
        self.data.join(format!("daemon-{VER}.sock"))
    }

    fn run_sync_hook(&self) {
        let t = Instant::now();
        let st = self.fast("sync").status().unwrap();
        assert!(st.success());
        assert!(t.elapsed() < Duration::from_secs(2), "sync hook blocked");
    }

    fn meta(&self, key: &str) -> Option<String> {
        let db = self.data.join("episodic.db");
        if !db.exists() {
            return None;
        }
        let c = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
        c.busy_timeout(Duration::from_secs(5)).ok()?;
        c.query_row("SELECT value FROM meta WHERE key = ?", [key], |r| r.get(0))
            .ok()
    }

    fn sync_count(&self) -> i64 {
        self.meta("sync_count")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0)
    }

    /// The daemon's `{"client":"status"}` reply, if it answers.
    fn status(&self) -> Option<Value> {
        let mut s = UnixStream::connect(self.socket()).ok()?;
        s.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
        s.write_all(b"{\"client\":\"status\"}\n").ok()?;
        let mut line = String::new();
        BufReader::new(s).read_line(&mut line).ok()?;
        serde_json::from_str(&line).ok()
    }

    /// Waits until `sync_count` has not changed for one second; with `model_ready`, also until
    /// the daemon reports the model ready and no sync running or pending (the startup sync and
    /// the model loader's sync can otherwise land after a caller's baseline).
    fn settle(&self, model_ready: bool) -> bool {
        let mut last = self.sync_count();
        let mut stable_since = Instant::now();
        wait_until(Duration::from_secs(15), || {
            let c = self.sync_count();
            if c != last {
                last = c;
                stable_since = Instant::now();
            }
            let idle = !model_ready
                || self
                    .status()
                    .is_some_and(|v| v["model"] == "ready" && v["sync_running"] == false);
            if !idle {
                stable_since = Instant::now();
            }
            stable_since.elapsed() >= Duration::from_secs(1)
        })
    }

    /// A started and initialized `mcp` client.
    fn mcp(&self) -> Mcp {
        let mut m = self.spawn_mcp();
        let id = m.send_initialize();
        m.check_initialize(id);
        m
    }

    /// An `mcp` process with nothing sent yet.
    fn spawn_mcp(&self) -> Mcp {
        let mut child = self
            .fast("mcp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Mcp {
            child,
            stdin,
            rx,
            next_id: 1,
        }
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        // The daemon writes its pid into the daemon lock file.
        if let Ok(pid) = std::fs::read_to_string(self.data.join(format!("daemon-{VER}.lock"))) {
            let pid = pid.trim();
            if !pid.is_empty() {
                let _ = Command::new("kill").arg(pid).stderr(Stdio::null()).status();
            }
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

struct Mcp {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<String>,
    next_id: i64,
}

impl Mcp {
    fn send(&mut self, method: &str, params: &Value) -> i64 {
        let id = self.next_id;
        self.next_id += 1;
        let msg = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        writeln!(self.stdin, "{msg}").unwrap();
        id
    }

    fn send_initialize(&mut self) -> i64 {
        self.send(
            "initialize",
            &json!({"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}),
        )
    }

    fn check_initialize(&mut self, id: i64) {
        let init = self.recv(id);
        assert_eq!(init["result"]["serverInfo"]["name"], "episodic-memory");
    }

    fn request(&mut self, method: &str, params: &Value) -> Value {
        let id = self.send(method, params);
        self.recv(id)
    }

    fn recv(&mut self, id: i64) -> Value {
        let line = self
            .rx
            .recv_timeout(Duration::from_secs(15))
            .expect("no MCP response");
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["id"], id);
        v
    }

    fn search(&mut self, query: &str) -> (bool, String) {
        let r = self.request(
            "tools/call",
            &json!({"name":"search","arguments":{"query":query}}),
        );
        let text = r["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_string();
        (r["result"]["isError"] == true, text)
    }
}

impl Drop for Mcp {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn wait_until(limit: Duration, mut f: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + limit;
    loop {
        if f() {
            return true;
        }
        if Instant::now() >= end {
            return false;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn wait_child(c: &mut Child, limit: Duration) -> Option<std::process::ExitStatus> {
    let end = Instant::now() + limit;
    loop {
        if let Some(st) = c.try_wait().unwrap() {
            return Some(st);
        }
        if Instant::now() >= end {
            let _ = c.kill();
            return None;
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn three_mcp_clients_one_daemon() {
    let env = Env::new();
    // All three race to find (or spawn) the daemon before any of them talks to it.
    let mut clients: Vec<Mcp> = (0..3).map(|_| env.spawn_mcp()).collect();
    let ids: Vec<i64> = clients.iter_mut().map(Mcp::send_initialize).collect();
    for (m, id) in clients.iter_mut().zip(ids) {
        m.check_initialize(id);
    }
    let handles: Vec<_> = clients
        .into_iter()
        .map(|mut m| {
            let r = m.request("tools/list", &json!({}));
            let names: Vec<String> = r["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t["name"].as_str().unwrap().to_string())
                .collect();
            assert_eq!(names, ["search", "read"]);
            m
        })
        .collect();

    let mut second = env.fast("daemon").spawn().unwrap();
    let st = wait_child(&mut second, Duration::from_secs(1)).expect("second daemon kept running");
    assert!(st.success());
    drop(handles);
}

#[test]
fn sync_hook_triggers_indexing() {
    let env = Env::new();
    env.run_sync_hook();
    let mut m = env.mcp();
    let found = wait_until(Duration::from_secs(2), || {
        let (err, text) = m.search("list files");
        assert!(!err, "{text}");
        text.contains("main.jsonl:")
    });
    assert!(found, "search never returned the synced exchange");
}

#[test]
fn sync_wait_returns_after_the_triggered_sync_commits() {
    let env = Env::new();
    // No daemon yet: --wait spawns it and still waits for the indexed state.
    let st = env.fast("sync").arg("--wait").status().unwrap();
    assert!(st.success());
    let mut m = env.mcp();
    let (err, text) = m.search("list files");
    assert!(!err && text.contains("main.jsonl:"), "{text}");

    // Daemon running: a transcript written now is searchable as soon as --wait returns.
    std::fs::write(
        env.root.join("c/projects/demo/fresh.jsonl"),
        "{\"type\":\"user\",\"sessionId\":\"fresh\",\"cwd\":\"/work/demo\",\"timestamp\":\"2026-01-04T00:00:00.000Z\",\"message\":{\"role\":\"user\",\"content\":\"how do I calibrate the zeppelin\"}}\n\
         {\"type\":\"assistant\",\"sessionId\":\"fresh\",\"timestamp\":\"2026-01-04T00:00:01.000Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"zeppelin calibrated\"}]}}\n",
    )
    .unwrap();
    let st = env.fast("sync").arg("--wait").status().unwrap();
    assert!(st.success());
    let (err, text) = m.search("zeppelin");
    assert!(!err && text.contains("fresh.jsonl:"), "{text}");
}

#[test]
fn sync_requests_coalesce() {
    let env = Env::new();
    env.run_sync_hook();
    assert!(wait_until(Duration::from_secs(10), || env.sync_count() >= 1));
    assert!(env.settle(true), "daemon never settled");
    let base = env.sync_count();
    // Back-to-back requests (what ten hooks firing at once look like to the daemon); a hook
    // process takes longer to start than a no-op sync, so spawning ten would not overlap.
    for _ in 0..10 {
        let mut s = UnixStream::connect(env.socket()).unwrap();
        s.write_all(b"{\"client\":\"sync\"}\n").unwrap();
    }
    assert!(wait_until(Duration::from_secs(10), || env.sync_count() > base));
    assert!(env.settle(false));
    let delta = env.sync_count() - base;
    assert!((1..=2).contains(&delta), "10 requests ran {delta} syncs");
}

#[test]
fn different_version_daemons_share_sync_lock() {
    let env = Env::new();
    std::fs::create_dir_all(&env.data).unwrap();
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(env.data.join("sync.lock"))
        .unwrap();
    lock.lock_exclusive().unwrap();

    env.run_sync_hook();
    assert!(wait_until(Duration::from_secs(5), || UnixStream::connect(
        env.socket()
    )
    .is_ok()));
    env.run_sync_hook();
    thread::sleep(Duration::from_secs(1));
    assert_eq!(env.meta("last_sync"), None, "sync ran without sync.lock");

    lock.unlock().unwrap();
    env.run_sync_hook();
    assert!(
        wait_until(Duration::from_secs(5), || env.meta("last_sync").is_some()),
        "sync did not run after the lock was released"
    );
}

#[test]
fn idle_exit() {
    let env = Env::new();
    let mut d = env
        .cmd(&["daemon", "--fake-embedder", "--idle-secs", "2"])
        .spawn()
        .unwrap();
    assert!(wait_until(Duration::from_secs(5), || UnixStream::connect(
        env.socket()
    )
    .is_ok()));
    let up = Instant::now();
    let st = wait_child(&mut d, Duration::from_secs(4)).expect("daemon did not exit when idle");
    assert!(st.success());
    assert!(up.elapsed() >= Duration::from_secs(1), "exited too early");
    assert!(UnixStream::connect(env.socket()).is_err());
}

#[test]
#[allow(clippy::case_sensitive_file_extension_comparisons)]
fn search_during_sync_sees_committed_state() {
    use std::fmt::Write as _;
    let env = Env::new();
    // A large synthetic transcript so the first sync takes a while.
    let mut big = String::new();
    for i in 0..3000 {
        let _ = write!(
            big,
            "{{\"type\":\"user\",\"sessionId\":\"big\",\"cwd\":\"/work/big\",\"timestamp\":\"2026-01-03T00:00:00.000Z\",\"message\":{{\"role\":\"user\",\"content\":\"bulk question {i} about widgets\"}}}}\n\
             {{\"type\":\"assistant\",\"sessionId\":\"big\",\"timestamp\":\"2026-01-03T00:00:01.000Z\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"bulk answer {i} widgets ok\"}}]}}}}\n"
        );
    }
    std::fs::write(env.root.join("c/projects/demo/big.jsonl"), big).unwrap();

    let mut m = env.mcp();
    let mut seen: Vec<(String, i64, i64)> = Vec::new();
    let mut rounds = 0;
    let done = wait_until(Duration::from_secs(120), || {
        let finished = env.sync_count() >= 1;
        let (err, text) = m.search("bulk widgets");
        assert!(!err, "{text}");
        for line in text.lines() {
            let Some((path, range)) = line.trim().rsplit_once(':') else {
                continue;
            };
            let Some((s, e)) = range.split_once('-') else {
                continue;
            };
            if let (Ok(s), Ok(e)) = (s.parse(), e.parse())
                && path.ends_with(".jsonl")
            {
                seen.push((path.to_string(), s, e));
            }
        }
        rounds += 1;
        finished
    });
    assert!(done, "sync never finished");
    assert!(rounds >= 2);
    assert!(!seen.is_empty());
    let c = Connection::open_with_flags(
        env.data.join("episodic.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    for (path, s, e) in &seen {
        let n: i64 = c
            .query_row(
                "SELECT count(*) FROM exchanges WHERE archive_path = ? AND line_start = ? AND line_end = ?",
                rusqlite::params![path, s, e],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "{path}:{s}-{e} not in DB");
    }
}

#[test]
fn long_socket_path_fails_cleanly() {
    let prefix_len = format!("/tmp/em-{}-00/", std::process::id()).len();
    let env = Env::with_data(&"a".repeat(120 - prefix_len));
    assert!(env.data.as_os_str().len() >= 119, "{}", env.data.display());
    let mut m = env.fast("mcp").stdin(Stdio::piped()).spawn().unwrap();
    let st = wait_child(&mut m, Duration::from_secs(10)).expect("mcp hung");
    assert!(!st.success());
    let log = std::fs::read_to_string(env.data.join("logs/episodic-memory.log")).unwrap();
    assert!(log.contains("socket path too long"), "{log}");
}

#[test]
fn disable_env_short_circuits() {
    let env = Env::new();
    let st = env
        .fast("sync")
        .env("EPISODIC_MEMORY_DISABLE", "1")
        .status()
        .unwrap();
    assert!(st.success());
    thread::sleep(Duration::from_millis(500));
    assert!(!env.data.exists(), "disabled sync touched the data dir");
}

struct Doctor {
    code: i32,
    out: String,
}

impl Doctor {
    fn line(&self, name: &str) -> &str {
        let key = format!("] {name}: ");
        self.out
            .lines()
            .find(|l| l.contains(&key))
            .unwrap_or_else(|| panic!("no {name} line in:\n{}", self.out))
    }
}

impl Env {
    fn doctor(&self) -> Doctor {
        let o = self
            .cmd(&["doctor"])
            .stdout(Stdio::piped())
            .output()
            .unwrap();
        Doctor {
            code: o.status.code().unwrap(),
            out: String::from_utf8(o.stdout).unwrap(),
        }
    }
}

#[test]
fn doctor_on_empty_data_dir_does_not_create_anything() {
    let env = Env::new();
    let none = env.root.join("none");
    let o = env
        .cmd(&["doctor"])
        .env("CLAUDE_CONFIG_DIR", &none)
        .env("CODEX_HOME", &none)
        .stdout(Stdio::piped())
        .output()
        .unwrap();
    let out = String::from_utf8(o.stdout).unwrap();
    assert_eq!(o.status.code(), Some(1), "{out}");
    let line = |name: &str| {
        let key = format!("] {name}: ");
        out.lines().find(|l| l.contains(&key)).unwrap().to_string()
    };
    assert!(line("db").starts_with("[warn]"), "{out}");
    assert!(line("daemon").starts_with("[warn]"), "{out}");
    assert!(line("model").starts_with("[warn]"), "{out}");
    assert!(line("source-roots").starts_with("[fail]"), "{out}");
    assert!(!env.data.exists(), "doctor created the data dir");
}

#[test]
fn doctor_does_not_spawn_a_daemon() {
    let env = Env::new();
    let d = env.doctor();
    assert!(d.line("daemon").starts_with("[warn]"), "{}", d.out);
    thread::sleep(Duration::from_millis(500));
    assert!(!env.socket().exists());
    assert!(!env.data.exists());
}

#[test]
fn doctor_after_sync_reports_running_daemon() {
    let env = Env::new();
    env.run_sync_hook();
    assert!(wait_until(Duration::from_secs(10), || env.sync_count() >= 1));
    let mut d = env.doctor();
    assert!(
        wait_until(Duration::from_secs(10), || {
            d = env.doctor();
            d.line("daemon").contains("sync idle") && d.line("embeddings").starts_with("[ok]")
        }),
        "{}",
        d.out
    );
    assert_eq!(d.code, 0, "{}", d.out);
    let daemon = d.line("daemon");
    assert!(daemon.starts_with("[ok]") && daemon.contains(&format!("v{VER}")));
    assert!(daemon.contains("0 client(s)"), "status counted as a client");
    assert!(d.line("model").starts_with("[ok]"));
    let db = d.line("db");
    assert!(
        db.starts_with("[ok]") && db.contains("user_version 2"),
        "{db}"
    );
    let n: i64 = db
        .split(", ")
        .find_map(|p| p.strip_suffix(" exchanges")?.parse().ok())
        .unwrap_or_else(|| panic!("no exchange count in {db}"));
    assert!(n > 0, "{db}");
    assert!(d.line("last-sync").starts_with("[ok]"), "{}", d.out);
    assert!(d.line("source-roots").starts_with("[ok]"));
    // A real MCP client is counted; the earlier status connections were not.
    let _m = env.mcp();
    assert!(env.doctor().line("daemon").contains("1 client(s)"));
}

#[test]
fn doctor_warns_on_last_error() {
    let env = Env::new();
    env.run_sync_hook();
    assert!(wait_until(Duration::from_secs(10), || env
        .doctor()
        .line("daemon")
        .contains("sync idle")
        && env.sync_count() >= 1));
    {
        let c = Connection::open(env.data.join("episodic.db")).unwrap();
        c.busy_timeout(Duration::from_secs(5)).unwrap();
        c.execute(
            "INSERT INTO meta(key, value) VALUES ('last_error', 'synthetic failure')
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [],
        )
        .unwrap();
    }
    let d = env.doctor();
    let l = d.line("last-sync");
    assert!(
        l.starts_with("[warn]") && l.contains("synthetic failure"),
        "{}",
        d.out
    );
}

#[test]
fn symlink_to_ancestor_does_not_loop_discovery() {
    let env = Env::new();
    let projects = env.root.join("c/projects");
    let demo = projects.join("demo");
    // One link back to the source root and one to its own directory: following either without
    // loop detection revisits the transcripts, and two links make the walk exponential.
    std::os::unix::fs::symlink(&projects, demo.join("up")).unwrap();
    std::os::unix::fs::symlink(&demo, demo.join("self")).unwrap();
    env.run_sync_hook();
    assert!(
        wait_until(Duration::from_secs(15), || env.sync_count() >= 1),
        "sync never finished"
    );
    let c = Connection::open_with_flags(
        env.data.join("episodic.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    c.busy_timeout(Duration::from_secs(5)).unwrap();
    let mut stmt = c
        .prepare(
            "SELECT source_path FROM files WHERE source_kind = 'claude-code-projects' \
             ORDER BY source_path",
        )
        .unwrap();
    let paths: Vec<String> = stmt
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    let expected: Vec<String> = ["main.jsonl", "noise.jsonl", "subagent.jsonl"]
        .iter()
        .map(|n| demo.join(n).to_string_lossy().into_owned())
        .collect();
    assert_eq!(paths, expected);
}

#[test]
fn connection_without_hello_is_closed() {
    let env = Env::new();
    // A long idle timeout so an idle exit cannot be mistaken for the hello timeout.
    let mut d = env
        .cmd(&["daemon", "--fake-embedder", "--idle-secs", "60"])
        .spawn()
        .unwrap();
    assert!(wait_until(Duration::from_secs(5), || UnixStream::connect(
        env.socket()
    )
    .is_ok()));
    let mut s = UnixStream::connect(env.socket()).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(15))).unwrap();
    let start = Instant::now();
    let mut buf = [0u8; 1];
    let n = std::io::Read::read(&mut s, &mut buf).expect("daemon never closed the connection");
    let waited = start.elapsed();
    assert_eq!(n, 0);
    assert!(
        (Duration::from_secs(4)..Duration::from_secs(10)).contains(&waited),
        "closed after {waited:?}"
    );
    assert!(d.try_wait().unwrap().is_none(), "daemon exited");
    let _ = d.kill();
    let _ = d.wait();
}

#[test]
fn mcp_client_idle_past_hello_timeout_still_served() {
    let env = Env::new();
    let mut m = env.mcp();
    thread::sleep(Duration::from_secs(7));
    let r = m.request("tools/list", &json!({}));
    assert_eq!(r["result"]["tools"].as_array().map(Vec::len), Some(2));
}
