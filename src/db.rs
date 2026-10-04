use crate::paths::SourceKind;
use anyhow::Result;
use rusqlite::ffi::sqlite3_auto_extension;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use sqlite_vec::sqlite3_vec_init;
use std::fmt::Write as _;
use std::path::Path;
use std::sync::Once;

pub struct FileRow {
    pub source_path: String,
    pub source_kind: SourceKind,
    pub archive_path: String,
    pub generation: i64,
    pub offset: i64,
    pub reparse_line: i64,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub project: Option<String>,
    pub harness: Option<String>,
    pub is_sidechain: Option<bool>,
    pub user_signal: Option<String>,
    pub skipped: bool,
}

impl FileRow {
    /// A freshly registered file: nothing parsed yet, session fields unknown.
    pub fn new(
        source_path: String,
        source_kind: SourceKind,
        archive_path: String,
        generation: i64,
        offset: i64,
    ) -> Self {
        FileRow {
            source_path,
            source_kind,
            archive_path,
            generation,
            offset,
            reparse_line: 1,
            session_id: None,
            cwd: None,
            project: None,
            harness: None,
            is_sidechain: None,
            user_signal: None,
            skipped: false,
        }
    }
}

pub struct NewExchange {
    pub archive_path: String,
    pub line_start: i64,
    pub line_end: i64,
    pub session_id: Option<String>,
    pub project: String,
    pub harness: String,
    pub is_sidechain: bool,
    pub ts: i64,
    pub user_message: String,
    pub assistant_message: String,
    pub tool_names: String,
}

const SCHEMA: &str = r#"
CREATE TABLE files(
  source_path TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  archive_path TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL DEFAULT 0,
  "offset" INTEGER NOT NULL DEFAULT 0,
  reparse_line INTEGER NOT NULL DEFAULT 1,
  session_id TEXT, cwd TEXT, project TEXT,
  harness TEXT, is_sidechain INTEGER,
  user_signal TEXT,
  skipped INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE exchanges(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_path TEXT NOT NULL,
  line_start INTEGER NOT NULL, line_end INTEGER NOT NULL,
  session_id TEXT,
  project TEXT NOT NULL,
  harness TEXT NOT NULL,
  is_sidechain INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL,
  user_message TEXT NOT NULL,
  assistant_message TEXT NOT NULL,
  tool_names TEXT NOT NULL DEFAULT '',
  embedded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX exchanges_file ON exchanges(archive_path, line_start);
CREATE INDEX exchanges_pending ON exchanges(id) WHERE embedded = 0;
CREATE VIRTUAL TABLE fts_exchanges USING fts5(terms, content='', contentless_delete=1,
  tokenize='porter unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE vec_exchanges USING vec0(
  embedding float[384],
  project TEXT, ts INTEGER, is_sidechain INTEGER);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE VIRTUAL TABLE fts_vocab USING fts5vocab(fts_exchanges, row);
PRAGMA user_version = 1;
"#;

fn register_vec() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        sqlite3_auto_extension(Some(std::mem::transmute::<
            *const (),
            unsafe extern "C" fn(
                *mut rusqlite::ffi::sqlite3,
                *mut *mut std::os::raw::c_char,
                *const rusqlite::ffi::sqlite3_api_routines,
            ) -> std::os::raw::c_int,
        >(sqlite3_vec_init as *const ())));
    });
}

pub fn open(path: &Path) -> Result<Connection> {
    register_vec();
    let mut c = Connection::open(path)?;
    c.execute_batch(
        "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;",
    )?;
    let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version == 0 {
        // IMMEDIATE so two processes opening a fresh DB don't both create the schema.
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let version: i64 = tx.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version == 0 {
            tx.execute_batch(SCHEMA)?;
        }
        tx.commit()?;
    }
    Ok(c)
}

/// Opens an existing DB without creating or migrating anything. With `immutable` (only safe
/// when no process is writing) SQLite touches no `-wal`/`-shm` sidecars.
pub fn open_readonly(path: &Path, immutable: bool) -> Result<Connection> {
    register_vec();
    let c = if immutable {
        let mut uri = String::from("file:");
        for &b in std::os::unix::ffi::OsStrExt::as_bytes(path.as_os_str()) {
            match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                    uri.push(b as char);
                }
                _ => {
                    let _ = write!(uri, "%{b:02X}");
                }
            }
        }
        uri.push_str("?immutable=1");
        Connection::open_with_flags(
            uri,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )?
    } else {
        Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?
    };
    c.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(c)
}

pub fn get_file(c: &Connection, source_path: &str) -> Result<Option<FileRow>> {
    Ok(c.prepare_cached(
        r#"SELECT source_path, source_kind, archive_path, generation, "offset", reparse_line,
                  session_id, cwd, project, harness, is_sidechain, user_signal, skipped
           FROM files WHERE source_path = ?"#,
    )?
    .query_row([source_path], |r| {
        let kind: String = r.get(1)?;
        Ok(FileRow {
            source_path: r.get(0)?,
            source_kind: SourceKind::parse(&kind).ok_or_else(|| {
                rusqlite::Error::FromSqlConversionFailure(
                    1,
                    rusqlite::types::Type::Text,
                    format!("unknown source_kind {kind:?}").into(),
                )
            })?,
            archive_path: r.get(2)?,
            generation: r.get(3)?,
            offset: r.get(4)?,
            reparse_line: r.get(5)?,
            session_id: r.get(6)?,
            cwd: r.get(7)?,
            project: r.get(8)?,
            harness: r.get(9)?,
            is_sidechain: r.get(10)?,
            user_signal: r.get(11)?,
            skipped: r.get(12)?,
        })
    })
    .optional()?)
}

pub fn upsert_file(tx: &Transaction, f: &FileRow) -> Result<()> {
    tx.prepare_cached(
        r#"INSERT INTO files(source_path, source_kind, archive_path, generation, "offset",
                             reparse_line, session_id, cwd, project, harness, is_sidechain,
                             user_signal, skipped)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
           ON CONFLICT(source_path) DO UPDATE SET
             source_kind = excluded.source_kind, archive_path = excluded.archive_path,
             generation = excluded.generation, "offset" = excluded."offset",
             reparse_line = excluded.reparse_line, session_id = excluded.session_id,
             cwd = excluded.cwd, project = excluded.project, harness = excluded.harness,
             is_sidechain = excluded.is_sidechain, user_signal = excluded.user_signal,
             skipped = excluded.skipped"#,
    )?
    .execute(params![
        f.source_path,
        f.source_kind.as_str(),
        f.archive_path,
        f.generation,
        f.offset,
        f.reparse_line,
        f.session_id,
        f.cwd,
        f.project,
        f.harness,
        f.is_sidechain,
        f.user_signal,
        f.skipped
    ])?;
    Ok(())
}

pub fn insert_exchange(tx: &Transaction, e: &NewExchange, terms: &str) -> Result<i64> {
    tx.prepare_cached(
        "INSERT INTO exchanges(archive_path, line_start, line_end, session_id, project, harness,
                               is_sidechain, ts, user_message, assistant_message, tool_names)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )?
    .execute(params![
        e.archive_path,
        e.line_start,
        e.line_end,
        e.session_id,
        e.project,
        e.harness,
        e.is_sidechain,
        e.ts,
        e.user_message,
        e.assistant_message,
        e.tool_names
    ])?;
    let id = tx.last_insert_rowid();
    tx.prepare_cached("INSERT INTO fts_exchanges(rowid, terms) VALUES (?, ?)")?
        .execute(params![id, terms])?;
    Ok(id)
}

/// The only path that deletes exchanges. The virtual tables have no FK support,
/// so their rows go first, then the `exchanges` rows.
pub fn delete_exchanges_from(
    tx: &Transaction,
    archive_path: &str,
    from_line: i64,
) -> Result<usize> {
    let ids: Vec<i64> = tx
        .prepare("SELECT id FROM exchanges WHERE archive_path = ? AND line_start >= ?")?
        .query_map(params![archive_path, from_line], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut fts = tx.prepare_cached("DELETE FROM fts_exchanges WHERE rowid = ?")?;
    let mut vec = tx.prepare_cached("DELETE FROM vec_exchanges WHERE rowid = ?")?;
    let mut ex = tx.prepare_cached("DELETE FROM exchanges WHERE id = ?")?;
    for id in &ids {
        fts.execute([id])?;
        vec.execute([id])?;
        ex.execute([id])?;
    }
    Ok(ids.len())
}

pub fn meta_set(c: &Connection, key: &str, value: &str) -> Result<()> {
    c.execute(
        "INSERT INTO meta(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn meta_get(c: &Connection, key: &str) -> Option<String> {
    c.query_row("SELECT value FROM meta WHERE key = ?", [key], |r| r.get(0))
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vec_bytes(first: f32) -> Vec<u8> {
        let mut v = vec![0.0f32; 384];
        v[0] = first;
        crate::embed::to_blob(&v)
    }

    fn ex(path: &str, line_start: i64, text: &str) -> NewExchange {
        NewExchange {
            archive_path: path.into(),
            line_start,
            line_end: line_start + 1,
            session_id: Some("s1".into()),
            project: "proj".into(),
            harness: "claude".into(),
            is_sidechain: false,
            ts: 1000,
            user_message: text.into(),
            assistant_message: "answer".into(),
            tool_names: "Bash".into(),
        }
    }

    fn add_vec(tx: &Transaction, id: i64) {
        tx.execute(
            "INSERT INTO vec_exchanges(rowid, embedding, project, ts, is_sidechain) VALUES (?, ?, 'proj', 1000, 0)",
            rusqlite::params![id, vec_bytes(1.0)],
        )
        .unwrap();
    }

    fn count(c: &Connection, table: &str) -> i64 {
        c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    fn temp_db() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let c = open(&dir.path().join("episodic.db")).unwrap();
        (dir, c)
    }

    #[test]
    fn open_waits_for_a_locked_db() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("episodic.db");
        let holder = Connection::open(&p).unwrap();
        holder
            .execute_batch("CREATE TABLE t(x); BEGIN EXCLUSIVE; INSERT INTO t VALUES (1);")
            .unwrap();
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            holder.execute_batch("COMMIT").unwrap();
        });
        open(&p).expect("open must wait out the lock, not fail with SQLITE_BUSY");
        release.join().unwrap();
    }

    #[test]
    fn open_creates_schema_once() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("episodic.db");
        drop(open(&p).unwrap());
        let c = open(&p).unwrap();
        let v: i64 = c
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 1);
        let vocab: i64 = c
            .query_row("SELECT count(*) FROM fts_vocab", [], |r| r.get(0))
            .unwrap();
        assert_eq!(vocab, 0);
    }

    #[test]
    fn insert_then_delete_cleans_fts_and_vec() {
        let (_d, mut c) = temp_db();
        let tx = c.transaction().unwrap();
        let a = insert_exchange(&tx, &ex("a.jsonl", 1, "alpha"), "alpha").unwrap();
        let b = insert_exchange(&tx, &ex("a.jsonl", 3, "beta"), "beta").unwrap();
        add_vec(&tx, a);
        add_vec(&tx, b);
        tx.commit().unwrap();
        let hits = |c: &Connection, q: &str| -> i64 {
            c.query_row(
                "SELECT count(*) FROM fts_exchanges WHERE fts_exchanges MATCH ?",
                [q],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(hits(&c, "alpha"), 1);
        assert_eq!(count(&c, "vec_exchanges"), 2);

        let tx = c.transaction().unwrap();
        assert_eq!(delete_exchanges_from(&tx, "a.jsonl", 1).unwrap(), 2);
        tx.commit().unwrap();
        assert_eq!(count(&c, "exchanges"), 0);
        assert_eq!(count(&c, "vec_exchanges"), 0);
        assert_eq!(hits(&c, "alpha"), 0);
        assert_eq!(hits(&c, "beta"), 0);
    }

    #[test]
    fn delete_from_line_keeps_earlier() {
        let (_d, mut c) = temp_db();
        let tx = c.transaction().unwrap();
        insert_exchange(&tx, &ex("a.jsonl", 1, "one"), "one").unwrap();
        insert_exchange(&tx, &ex("a.jsonl", 10, "ten"), "ten").unwrap();
        insert_exchange(&tx, &ex("b.jsonl", 10, "other"), "other").unwrap();
        assert_eq!(delete_exchanges_from(&tx, "a.jsonl", 5).unwrap(), 1);
        tx.commit().unwrap();
        let starts: Vec<i64> = c
            .prepare("SELECT line_start FROM exchanges WHERE archive_path = 'a.jsonl'")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(starts, vec![1]);
        assert_eq!(count(&c, "exchanges"), 2);
    }

    #[test]
    fn autoincrement_does_not_reuse_ids() {
        let (_d, mut c) = temp_db();
        let tx = c.transaction().unwrap();
        let first = insert_exchange(&tx, &ex("a.jsonl", 1, "x"), "x").unwrap();
        delete_exchanges_from(&tx, "a.jsonl", 1).unwrap();
        let second = insert_exchange(&tx, &ex("a.jsonl", 1, "y"), "y").unwrap();
        assert!(second > first);
    }

    #[test]
    fn file_row_roundtrip_and_meta() {
        let (_d, mut c) = temp_db();
        assert!(get_file(&c, "/src/a.jsonl").unwrap().is_none());
        let mut f = FileRow {
            session_id: Some("s".into()),
            project: Some("p".into()),
            harness: Some("codex".into()),
            is_sidechain: Some(false),
            user_signal: Some("user_message".into()),
            ..FileRow::new(
                "/src/a.jsonl".into(),
                SourceKind::CodexSessions,
                "codex-sessions/a.jsonl".into(),
                0,
                10,
            )
        };
        let tx = c.transaction().unwrap();
        upsert_file(&tx, &f).unwrap();
        f.offset = 20;
        f.skipped = true;
        upsert_file(&tx, &f).unwrap();
        tx.commit().unwrap();
        let got = get_file(&c, "/src/a.jsonl").unwrap().unwrap();
        assert_eq!(got.offset, 20);
        assert!(got.skipped);
        assert_eq!(got.is_sidechain, Some(false));
        assert_eq!(got.user_signal.as_deref(), Some("user_message"));
        assert_eq!(count(&c, "files"), 1);

        assert_eq!(meta_get(&c, "k"), None);
        meta_set(&c, "k", "v1").unwrap();
        meta_set(&c, "k", "v2").unwrap();
        assert_eq!(meta_get(&c, "k").as_deref(), Some("v2"));
    }
}
