use crate::daemon::{Hello, Status};
use crate::db::{meta_get, open_readonly};
use crate::paths::{Paths, SourceRoot, VERSION, candidate_roots_from_env};
use rusqlite::Connection;
use std::fmt;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

const STATUS_TIMEOUT: Duration = Duration::from_secs(2);
const SUPPORTED: [(&str, &str); 3] = [
    ("macos", "aarch64"),
    ("linux", "x86_64"),
    ("linux", "aarch64"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Ok,
    Warn,
    Fail,
}

#[derive(Debug, Clone)]
pub struct Check {
    pub name: &'static str,
    pub level: Level,
    pub detail: String,
}

impl fmt::Display for Check {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let tag = match self.level {
            Level::Ok => "ok",
            Level::Warn => "warn",
            Level::Fail => "fail",
        };
        write!(f, "[{tag}] {}: {}", self.name, self.detail)
    }
}

fn check(name: &'static str, level: Level, detail: impl Into<String>) -> Check {
    Check {
        name,
        level,
        detail: detail.into(),
    }
}

/// Asks a running daemon for its status. Never spawns one.
fn query_status(paths: &Paths) -> Option<Status> {
    let mut s = UnixStream::connect(paths.daemon_socket()).ok()?;
    s.set_read_timeout(Some(STATUS_TIMEOUT)).ok()?;
    s.set_write_timeout(Some(STATUS_TIMEOUT)).ok()?;
    s.write_all(Hello::Status.line().as_bytes()).ok()?;
    let mut line = String::new();
    BufReader::new(s).read_line(&mut line).ok()?;
    parse_status(&line)
}

fn parse_status(line: &str) -> Option<Status> {
    serde_json::from_str(line.trim()).ok()
}

fn binary_check(os: &str, arch: &str, exe: Option<PathBuf>) -> Check {
    let exe = exe.map_or("unknown".to_string(), |p| p.display().to_string());
    let detail = format!("v{VERSION} at {exe} ({arch}-{os})");
    if SUPPORTED.contains(&(os, arch)) {
        check("binary", Level::Ok, detail)
    } else {
        check(
            "binary",
            Level::Warn,
            format!("{detail}, unsupported platform"),
        )
    }
}

fn daemon_check(status: Option<&Status>) -> Check {
    match status {
        None => check(
            "daemon",
            Level::Warn,
            "not running (starts with the next session)",
        ),
        Some(s) if s.version != VERSION => check(
            "daemon",
            Level::Warn,
            format!("version {} differs from binary {}", s.version, VERSION),
        ),
        Some(s) => check(
            "daemon",
            Level::Ok,
            format!(
                "v{}, {} client(s), sync {}",
                s.version,
                s.clients,
                if s.sync_running { "running" } else { "idle" }
            ),
        ),
    }
}

fn model_check(status: Option<&Status>) -> Check {
    match status.map(|s| s.model.as_str()) {
        None => check("model", Level::Warn, "unknown (daemon not running)"),
        Some("ready") => check("model", Level::Ok, "loaded"),
        Some("loading") => check("model", Level::Warn, "downloading or loading"),
        Some("failed") => check("model", Level::Fail, "load failed (see the log)"),
        Some(other) => check("model", Level::Warn, format!("unknown state {other}")),
    }
}

fn roots_check(roots: &[(SourceRoot, bool)]) -> Check {
    let detail = roots
        .iter()
        .map(|(r, exists)| {
            format!(
                "{} {} ({})",
                r.kind.as_str(),
                r.root.display(),
                if *exists { "found" } else { "missing" }
            )
        })
        .collect::<Vec<_>>()
        .join("; ");
    let level = if roots.iter().any(|(_, e)| *e) {
        Level::Ok
    } else {
        Level::Fail
    };
    check("source-roots", level, detail)
}

fn sync_check(last_sync: Option<&str>, last_error: Option<&str>) -> Check {
    if let Some(err) = last_error.filter(|e| !e.is_empty()) {
        return check("last-sync", Level::Warn, format!("last error: {err}"));
    }
    match last_sync.filter(|s| !s.is_empty()) {
        None => check("last-sync", Level::Warn, "never"),
        Some(t) => check("last-sync", Level::Ok, t),
    }
}

fn pending_check(pending: i64) -> Check {
    if pending > 0 {
        check(
            "embeddings",
            Level::Warn,
            format!("{pending} exchange(s) waiting for embedding"),
        )
    } else {
        check("embeddings", Level::Ok, "none pending")
    }
}

struct Counts {
    version: i64,
    files: i64,
    exchanges: i64,
    pending: i64,
    skipped: i64,
}

fn counts(c: &Connection) -> rusqlite::Result<Counts> {
    let n = |sql: &str| c.query_row(sql, [], |r| r.get::<_, i64>(0));
    Ok(Counts {
        version: n("PRAGMA user_version")?,
        files: n("SELECT COUNT(*) FROM files")?,
        exchanges: n("SELECT COUNT(*) FROM exchanges")?,
        pending: n("SELECT COUNT(*) FROM exchanges WHERE embedded = 0")?,
        skipped: n("SELECT COUNT(*) FROM files WHERE skipped = 1")?,
    })
}

/// The DB check plus the checks that read from it. Never creates the DB.
fn db_checks(paths: &Paths, daemon_up: bool) -> Vec<Check> {
    let db = paths.db();
    if !db.exists() {
        return vec![
            check(
                "db",
                Level::Warn,
                format!("{} not created yet (no sync has run)", db.display()),
            ),
            sync_check(None, None),
        ];
    }
    // immutable is unsafe against a concurrent writer; without a daemon nobody writes.
    let c = match open_readonly(&db, !daemon_up) {
        Ok(c) => c,
        Err(e) => {
            return vec![check("db", Level::Fail, format!("{}: {e}", db.display()))];
        }
    };
    let sync = sync_check(
        meta_get(&c, "last_sync").as_deref(),
        meta_get(&c, "last_error").as_deref(),
    );
    match counts(&c) {
        Err(e) => vec![
            check("db", Level::Fail, format!("{}: {e}", db.display())),
            sync,
        ],
        Ok(n) => vec![
            check(
                "db",
                Level::Ok,
                format!(
                    "{} (user_version {}, {} files, {} exchanges, {} skipped)",
                    db.display(),
                    n.version,
                    n.files,
                    n.exchanges,
                    n.skipped
                ),
            ),
            pending_check(n.pending),
            sync,
        ],
    }
}

pub fn run_checks(paths: &Paths) -> Vec<Check> {
    let status = query_status(paths);
    let roots: Vec<(SourceRoot, bool)> = candidate_roots_from_env()
        .into_iter()
        .map(|r| {
            let exists = r.root.is_dir();
            (r, exists)
        })
        .collect();
    let mut out = vec![
        binary_check(
            std::env::consts::OS,
            std::env::consts::ARCH,
            std::env::current_exe().ok(),
        ),
        daemon_check(status.as_ref()),
    ];
    out.extend(db_checks(paths, status.is_some()));
    out.push(model_check(status.as_ref()));
    out.push(roots_check(&roots));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::SourceKind;

    fn status(model: &str) -> Status {
        Status {
            version: VERSION.into(),
            clients: 2,
            sync_running: false,
            model: model.into(),
        }
    }

    fn root(exists: bool) -> (SourceRoot, bool) {
        (
            SourceRoot {
                kind: SourceKind::CodexSessions,
                root: "/x".into(),
            },
            exists,
        )
    }

    #[test]
    fn daemon_levels() {
        assert_eq!(daemon_check(None).level, Level::Warn);
        assert_eq!(daemon_check(Some(&status("ready"))).level, Level::Ok);
        let mut old = status("ready");
        old.version = "0.0.0".into();
        assert_eq!(daemon_check(Some(&old)).level, Level::Warn);
    }

    #[test]
    fn model_levels() {
        assert_eq!(model_check(None).level, Level::Warn);
        assert_eq!(model_check(Some(&status("ready"))).level, Level::Ok);
        assert_eq!(model_check(Some(&status("loading"))).level, Level::Warn);
        assert_eq!(model_check(Some(&status("failed"))).level, Level::Fail);
    }

    #[test]
    fn roots_fail_only_when_none_exist() {
        assert_eq!(roots_check(&[root(false), root(false)]).level, Level::Fail);
        assert_eq!(roots_check(&[root(false), root(true)]).level, Level::Ok);
    }

    #[test]
    fn sync_levels() {
        assert_eq!(sync_check(None, None).level, Level::Warn);
        assert_eq!(sync_check(Some("t"), Some("")).level, Level::Ok);
        let c = sync_check(Some("t"), Some("boom"));
        assert_eq!(c.level, Level::Warn);
        assert!(c.detail.contains("boom"));
    }

    #[test]
    fn pending_levels() {
        assert_eq!(pending_check(0).level, Level::Ok);
        assert_eq!(pending_check(3).level, Level::Warn);
    }

    #[test]
    fn platform_levels() {
        assert_eq!(binary_check("macos", "aarch64", None).level, Level::Ok);
        assert_eq!(binary_check("linux", "x86_64", None).level, Level::Ok);
        assert_eq!(binary_check("macos", "x86_64", None).level, Level::Warn);
    }

    #[test]
    fn parses_status_line() {
        let s =
            parse_status(r#"{"version":"1.2.3","clients":1,"sync_running":true,"model":"ready"}"#)
                .unwrap();
        assert_eq!(s.clients, 1);
        assert!(s.sync_running);
        assert!(parse_status("garbage").is_none());
    }

    #[test]
    fn missing_db_warns_and_is_not_created() {
        let t = tempfile::tempdir().unwrap();
        let paths = Paths::new(t.path().join("data"));
        let checks = db_checks(&paths, false);
        assert_eq!(checks[0].level, Level::Warn);
        assert!(!paths.db().exists());
        assert!(!paths.data.exists());
    }

    fn untouched_dir_check(dir_name: &str) {
        let t = tempfile::tempdir().unwrap();
        let dir = t.path().join(dir_name);
        std::fs::create_dir_all(&dir).unwrap();
        let paths = Paths::new(dir.clone());
        {
            let c = crate::db::open(&paths.db()).unwrap();
            c.execute(
                "INSERT INTO files(source_path, source_kind, archive_path) VALUES ('a','b','c')",
                [],
            )
            .unwrap();
            crate::db::meta_set(&c, "last_sync", "2026-01-01T00:00:00Z").unwrap();
        }
        let listing = || {
            let mut v: Vec<_> = std::fs::read_dir(&dir)
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .collect();
            v.sort();
            v
        };
        let before = listing();
        let checks = db_checks(&paths, false);
        assert_eq!(listing(), before, "doctor wrote to the data dir");
        assert_eq!(checks[0].level, Level::Ok, "{}", checks[0].detail);
        assert!(checks[0].detail.contains("1 files"), "{}", checks[0].detail);
        assert_eq!(checks[2].level, Level::Ok);
    }

    #[test]
    fn no_daemon_doctor_leaves_the_data_dir_untouched() {
        untouched_dir_check("data");
    }

    #[test]
    fn no_daemon_doctor_handles_non_ascii_and_special_paths() {
        untouched_dir_check("한글 경로 100% a?b#c");
    }

    #[test]
    fn corrupt_db_fails() {
        let t = tempfile::tempdir().unwrap();
        let paths = Paths::new(t.path().to_path_buf());
        std::fs::write(paths.db(), b"not a database, just text").unwrap();
        assert_eq!(db_checks(&paths, false)[0].level, Level::Fail);
    }

    #[test]
    fn db_counts_and_last_error() {
        let t = tempfile::tempdir().unwrap();
        let paths = Paths::new(t.path().to_path_buf());
        {
            let c = crate::db::open(&paths.db()).unwrap();
            crate::db::meta_set(&c, "last_sync", "2026-01-01T00:00:00Z").unwrap();
            crate::db::meta_set(&c, "last_error", "bad file").unwrap();
        }
        let checks = db_checks(&paths, false);
        assert_eq!(checks[0].level, Level::Ok);
        assert!(checks[0].detail.contains("user_version 1"));
        assert_eq!(checks[1].level, Level::Ok);
        assert_eq!(checks[2].level, Level::Warn);
        assert!(checks[2].detail.contains("bad file"));
    }
}
