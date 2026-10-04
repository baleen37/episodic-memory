//! Which conversation a host process (Claude Code or Codex) is running, so search can leave
//! out the session that is asking.

use crate::paths::{SourceKind, candidate_roots_from_env};
use rusqlite::{Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// How long an open-file lookup answer is reused. The lookup runs `lsof` on macOS (~60 ms);
/// an agent's back-to-back searches land within a few seconds of each other, while a session
/// switch (`/new`, `/clear`) needs the user to act and type a new prompt before the next
/// search, which rarely takes under 10 s. So 10 s skips most repeat lookups and still picks up
/// a switch by the next search after it.
const OPEN_FILE_CACHE: Duration = Duration::from_secs(10);

/// The conversation host (Claude Code or Codex) behind one MCP connection.
pub struct HostSession {
    pid: u32,
    /// Last open-file lookup answer and when it was made.
    open_file: Option<(Instant, Option<String>)>,
}

impl HostSession {
    pub fn new(pid: u32) -> Self {
        Self {
            pid,
            open_file: None,
        }
    }

    /// Session id the host is running now, when it can be determined. `/clear` or `/new`
    /// switches the session without restarting the host: the Claude session file is read on
    /// every call; the open-file lookup (Codex) is reused for `OPEN_FILE_CACHE`.
    pub fn current(&mut self, conn: &Connection) -> Option<String> {
        self.current_in(conn, claude_dir().as_deref())
    }

    fn current_in(&mut self, conn: &Connection, claude_dir: Option<&Path>) -> Option<String> {
        let pid = self.pid;
        claude_dir
            .and_then(|dir| claude_session(dir, pid))
            .or_else(|| self.cached(Instant::now(), || open_transcript_session(conn, pid)))
    }

    fn cached(&mut self, now: Instant, lookup: impl FnOnce() -> Option<String>) -> Option<String> {
        match &self.open_file {
            Some((at, session)) if now.duration_since(*at) < OPEN_FILE_CACHE => session.clone(),
            _ => {
                let session = lookup();
                self.open_file = Some((now, session.clone()));
                session
            }
        }
    }
}

/// `$CLAUDE_CONFIG_DIR` (default `~/.claude`).
fn claude_dir() -> Option<PathBuf> {
    candidate_roots_from_env()
        .into_iter()
        .find(|r| r.kind == SourceKind::ClaudeCodeProjects)?
        .root
        .parent()
        .map(Path::to_path_buf)
}

/// Claude Code records its current session in `<claude dir>/sessions/<pid>.json`.
fn claude_session(claude_dir: &Path, pid: u32) -> Option<String> {
    let text = std::fs::read_to_string(claude_dir.join(format!("sessions/{pid}.json"))).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v["sessionId"].as_str().map(String::from)
}

/// Codex keeps its rollout file open while it runs; the indexed file row names its session.
fn open_transcript_session(conn: &Connection, pid: u32) -> Option<String> {
    let mut stmt = conn
        .prepare_cached("SELECT session_id FROM files WHERE source_path = ?")
        .ok()?;
    open_files(pid)
        .into_iter()
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .find_map(|p| {
            stmt.query_row([p.to_string_lossy()], |r| r.get::<_, Option<String>>(0))
                .optional()
                .ok()
                .flatten()
                .flatten()
        })
}

/// Paths of the files `pid` has open: `/proc/<pid>/fd` on Linux, `lsof` elsewhere.
fn open_files(pid: u32) -> Vec<PathBuf> {
    if let Ok(fds) = std::fs::read_dir(format!("/proc/{pid}/fd")) {
        return fds
            .flatten()
            .filter_map(|fd| std::fs::read_link(fd.path()).ok())
            .collect();
    }
    Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-Fn"])
        .output()
        .map(|out| lsof_paths(&String::from_utf8_lossy(&out.stdout)))
        .unwrap_or_default()
}

/// `lsof -F n` output: one field per line, file names prefixed with `n`.
fn lsof_paths(out: &str) -> Vec<PathBuf> {
    out.lines()
        .filter_map(|l| l.strip_prefix('n'))
        .map(PathBuf::from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_claude_session_file() {
        let t = tempfile::tempdir().unwrap();
        std::fs::create_dir(t.path().join("sessions")).unwrap();
        std::fs::write(
            t.path().join("sessions/42.json"),
            r#"{"pid":42,"sessionId":"abc","cwd":"/x"}"#,
        )
        .unwrap();
        assert_eq!(claude_session(t.path(), 42).as_deref(), Some("abc"));
        assert_eq!(claude_session(t.path(), 43), None);
    }

    #[test]
    fn open_file_lookup_runs_once_per_cache_window() {
        let mut host = HostSession::new(1);
        let t0 = Instant::now();
        let lookups = std::cell::Cell::new(0);
        let lookup = |s: &str| {
            lookups.set(lookups.get() + 1);
            Some(s.to_string())
        };
        assert_eq!(host.cached(t0, || lookup("a")).as_deref(), Some("a"));
        let within = t0 + OPEN_FILE_CACHE.saturating_sub(Duration::from_millis(1));
        // The host switched sessions, but the cached answer is still used inside the window.
        assert_eq!(host.cached(within, || lookup("b")).as_deref(), Some("a"));
        assert_eq!(lookups.get(), 1);
        // After the window the switch is picked up.
        let after = t0 + OPEN_FILE_CACHE;
        assert_eq!(host.cached(after, || lookup("b")).as_deref(), Some("b"));
        assert_eq!(lookups.get(), 2);
    }

    #[test]
    fn no_session_found_is_cached_too() {
        let mut host = HostSession::new(1);
        let t0 = Instant::now();
        let mut lookups = 0;
        assert_eq!(
            host.cached(t0, || {
                lookups += 1;
                None
            }),
            None
        );
        assert_eq!(
            host.cached(t0 + Duration::from_secs(1), || {
                lookups += 1;
                Some("x".into())
            }),
            None
        );
        assert_eq!(lookups, 1);
    }

    #[test]
    fn claude_session_file_bypasses_the_cache() {
        let t = tempfile::tempdir().unwrap();
        std::fs::create_dir(t.path().join("sessions")).unwrap();
        let file = t.path().join("sessions/42.json");
        let conn = crate::db::open(&t.path().join("db")).unwrap();
        let mut host = HostSession::new(42);
        std::fs::write(&file, r#"{"sessionId":"s1"}"#).unwrap();
        assert_eq!(
            host.current_in(&conn, Some(t.path())).as_deref(),
            Some("s1")
        );
        std::fs::write(&file, r#"{"sessionId":"s2"}"#).unwrap();
        assert_eq!(
            host.current_in(&conn, Some(t.path())).as_deref(),
            Some("s2")
        );
    }

    #[test]
    fn parses_lsof_names() {
        let out = "p123\nfcwd\nn/home/u\nf7\nn/home/u/.codex/sessions/rollout-x.jsonl\n";
        assert_eq!(
            lsof_paths(out),
            [
                PathBuf::from("/home/u"),
                PathBuf::from("/home/u/.codex/sessions/rollout-x.jsonl")
            ]
        );
    }

    #[test]
    fn finds_session_of_open_transcript() {
        let t = tempfile::tempdir().unwrap();
        // lsof reports resolved paths (macOS `/var` -> `/private/var`).
        let src = t.path().canonicalize().unwrap().join("rollout-1.jsonl");
        let _open = std::fs::File::create(&src).unwrap();
        let conn = crate::db::open(&t.path().join("db")).unwrap();
        conn.execute(
            "INSERT INTO files(source_path, source_kind, archive_path, session_id)
             VALUES (?, 'codex-sessions', 'a', 'sess-1')",
            [src.to_string_lossy()],
        )
        .unwrap();
        assert_eq!(
            open_transcript_session(&conn, std::process::id()).as_deref(),
            Some("sess-1")
        );
    }
}
