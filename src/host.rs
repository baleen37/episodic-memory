//! Which conversation a host process (Claude Code or Codex) is running, so search can leave
//! out the session that is asking.

use crate::paths::{candidate_roots_from_env, SourceKind};
use rusqlite::{Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Session id of the conversation host `pid` is running, when it can be determined.
/// Resolved per call: `/clear` or `/new` switches the session without restarting the host.
pub fn session_of(conn: &Connection, pid: u32) -> Option<String> {
    claude_dir()
        .and_then(|dir| claude_session(&dir, pid))
        .or_else(|| open_transcript_session(conn, pid))
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
