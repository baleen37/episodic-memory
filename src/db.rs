use crate::parse::{FileMeta, ReparsePoint, UserSignal};
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
    pub reparse: ReparsePoint,
    /// File meta learned from the archive's first `meta_offset` bytes.
    pub meta: FileMeta,
    /// Archive bytes observed into `meta`; 0 means `meta` starts over from the provider's
    /// initial meta.
    pub meta_offset: i64,
    /// No later line can change `meta`, so appended lines are not observed.
    pub meta_settled: bool,
    pub project: Option<String>,
    pub harness: Option<String>,
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
            reparse: ReparsePoint::START,
            meta: FileMeta::default(),
            meta_offset: 0,
            meta_settled: false,
            project: None,
            harness: None,
            skipped: false,
        }
    }

    /// Makes the next index pass start over: parse from line 1, learn file meta and the project
    /// again.
    pub fn reset_index(&mut self) {
        self.reparse = ReparsePoint::START;
        self.meta_offset = 0;
        self.harness = None;
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

/// The latest schema, for a fresh DB, which `open` completes with `migrations::FENCE` and stamps
/// with `migrations::HEAD`. Existing DBs reach it through `migrations`; a schema change goes in
/// both.
const SCHEMA: &str = r#"
CREATE TABLE files(
  source_path TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  archive_path TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL DEFAULT 0,
  "offset" INTEGER NOT NULL DEFAULT 0,
  reparse_line INTEGER NOT NULL DEFAULT 1,
  reparse_offset INTEGER NOT NULL DEFAULT 0,
  reparse_offset_line INTEGER,
  session_id TEXT, cwd TEXT, project TEXT,
  harness TEXT, is_sidechain INTEGER,
  user_signal TEXT,
  skipped INTEGER NOT NULL DEFAULT 0,
  sidechain_known INTEGER NOT NULL DEFAULT 0,
  agent_path TEXT,
  meta_offset INTEGER NOT NULL DEFAULT 0,
  meta_settled INTEGER NOT NULL DEFAULT 0
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
PRAGMA user_version = 4;
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
    crate::migrations::register_revision_fn(&c)?;
    c.execute_batch(
        "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;",
    )?;
    // mmap_size 256 MiB: reads come straight from the OS page cache, shared by every connection,
    // instead of being copied into each connection's private cache.
    // cache_size -32768 (KiB, so 32 MiB): the 2 MiB default thrashes on FTS and vector pages;
    // per connection, and the daemon keeps one per MCP client, so kept moderate.
    // temp_store MEMORY: sorts and temp b-trees for ORDER BY / GROUP BY in search skip temp files.
    c.execute_batch(
        "PRAGMA mmap_size=268435456; PRAGMA cache_size=-32768; PRAGMA temp_store=MEMORY;",
    )?;
    // Every write transaction starts IMMEDIATE: a deferred one that reads first fails its
    // upgrade to write with SQLITE_BUSY at once in WAL mode, ignoring busy_timeout.
    c.set_transaction_behavior(TransactionBehavior::Immediate);
    let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version == 0 {
        // IMMEDIATE so two processes opening a fresh DB don't both create the schema.
        let tx = c.transaction()?;
        let version: i64 = tx.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version == 0 {
            tx.execute_batch(SCHEMA)?;
            tx.execute_batch(crate::migrations::FENCE)?;
            crate::migrations::stamp(&tx, crate::migrations::HEAD)?;
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
                  session_id, cwd, project, harness, is_sidechain, user_signal, skipped,
                  sidechain_known, agent_path, meta_offset, meta_settled, reparse_offset,
                  reparse_offset_line
           FROM files WHERE source_path = ?"#,
    )?
    .query_row([source_path], |r| {
        let kind: String = r.get(1)?;
        let line: i64 = r.get(5)?;
        // The byte position is trusted only for the line it was stored with.
        let byte_line: Option<i64> = r.get(18)?;
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
            reparse: ReparsePoint {
                line,
                byte: if byte_line == Some(line) {
                    Some(r.get(17)?)
                } else {
                    None
                },
            },
            meta: FileMeta {
                session_id: r.get(6)?,
                cwd: r.get(7)?,
                is_sidechain: r.get::<_, Option<bool>>(10)?.unwrap_or(false),
                sidechain_known: r.get(13)?,
                agent_path: r.get(14)?,
                user_signal: r
                    .get::<_, Option<String>>(11)?
                    .as_deref()
                    .and_then(UserSignal::parse),
            },
            meta_offset: r.get(15)?,
            meta_settled: r.get(16)?,
            project: r.get(8)?,
            harness: r.get(9)?,
            skipped: r.get(12)?,
        })
    })
    .optional()?)
}

pub fn upsert_file(tx: &Transaction, f: &FileRow) -> Result<()> {
    tx.prepare_cached(
        r#"INSERT INTO files(source_path, source_kind, archive_path, generation, "offset",
                             reparse_line, session_id, cwd, project, harness, is_sidechain,
                             user_signal, skipped, sidechain_known, agent_path, meta_offset,
                             meta_settled, reparse_offset, reparse_offset_line)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                   ?18, ?19)
           ON CONFLICT(source_path) DO UPDATE SET
             source_kind = excluded.source_kind, archive_path = excluded.archive_path,
             generation = excluded.generation, "offset" = excluded."offset",
             reparse_line = excluded.reparse_line, session_id = excluded.session_id,
             cwd = excluded.cwd, project = excluded.project, harness = excluded.harness,
             is_sidechain = excluded.is_sidechain, user_signal = excluded.user_signal,
             skipped = excluded.skipped, sidechain_known = excluded.sidechain_known,
             agent_path = excluded.agent_path, meta_offset = excluded.meta_offset,
             meta_settled = excluded.meta_settled, reparse_offset = excluded.reparse_offset,
             reparse_offset_line = excluded.reparse_offset_line"#,
    )?
    .execute(params![
        f.source_path,
        f.source_kind.as_str(),
        f.archive_path,
        f.generation,
        f.offset,
        f.reparse.line,
        f.meta.session_id,
        f.meta.cwd,
        f.project,
        f.harness,
        f.meta.is_sidechain,
        f.meta.user_signal.map(UserSignal::as_str),
        f.skipped,
        f.meta.sidechain_known,
        f.meta.agent_path,
        f.meta_offset,
        f.meta_settled,
        f.reparse.byte.unwrap_or(0),
        f.reparse.byte.map(|_| f.reparse.line)
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
    fn write_transactions_wait_for_a_concurrent_writer_instead_of_failing() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("episodic.db");
        let mut a = open(&p).unwrap();
        a.execute_batch("CREATE TABLE t(x)").unwrap();
        // A reads, then writes inside one transaction. A deferred transaction would take a
        // read snapshot, let B commit, then fail the upgrade with SQLITE_BUSY at once.
        let tx = a.transaction().unwrap();
        let _: i64 = tx
            .query_row("SELECT count(*) FROM t", [], |r| r.get(0))
            .unwrap();
        let p2 = p.clone();
        let writer = std::thread::spawn(move || {
            let b = open(&p2).unwrap();
            b.execute("INSERT INTO t VALUES (2)", []).unwrap();
        });
        std::thread::sleep(std::time::Duration::from_millis(200));
        tx.execute("INSERT INTO t VALUES (1)", [])
            .expect("write must not fail with SQLITE_BUSY");
        tx.commit().unwrap();
        writer.join().unwrap();
        let n: i64 = a
            .query_row("SELECT count(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 2);
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
        assert_eq!(v, 4);
        let head = crate::migrations::HEAD.to_string();
        assert_eq!(meta_get(&c, "revision"), Some(head));
        let vocab: i64 = c
            .query_row("SELECT count(*) FROM fts_vocab", [], |r| r.get(0))
            .unwrap();
        assert_eq!(vocab, 0);
    }

    /// Openers that read version 0 before another one created the schema must accept the v4
    /// they find under the write lock. (The DB is already WAL so only the version check races.)
    #[test]
    fn concurrent_first_opens_all_succeed() {
        for _ in 0..20 {
            let dir = tempfile::tempdir().unwrap();
            let p = dir.path().join("episodic.db");
            Connection::open(&p)
                .unwrap()
                .execute_batch("PRAGMA journal_mode=WAL;")
                .unwrap();
            let start = std::sync::Barrier::new(8);
            std::thread::scope(|s| {
                let handles: Vec<_> = (0..8)
                    .map(|_| {
                        s.spawn(|| {
                            start.wait();
                            open(&p).map(drop)
                        })
                    })
                    .collect();
                for h in handles {
                    h.join().unwrap().unwrap();
                }
            });
        }
    }

    #[test]
    fn byte_position_is_dropped_once_another_writer_moves_the_reparse_line() {
        let (_d, mut c) = temp_db();
        let f = FileRow {
            reparse: ReparsePoint {
                line: 5,
                byte: Some(120),
            },
            ..FileRow::new(
                "/src/a.jsonl".into(),
                SourceKind::CodexSessions,
                "a.jsonl".into(),
                0,
                200,
            )
        };
        let tx = c.transaction().unwrap();
        upsert_file(&tx, &f).unwrap();
        tx.commit().unwrap();
        c.execute("UPDATE files SET reparse_line = 9", []).unwrap();
        let got = get_file(&c, "/src/a.jsonl").unwrap().unwrap();
        assert_eq!(
            got.reparse,
            ReparsePoint {
                line: 9,
                byte: None
            }
        );
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
        let meta = FileMeta {
            session_id: Some("s".into()),
            cwd: Some("/w".into()),
            is_sidechain: true,
            sidechain_known: true,
            agent_path: Some("/root/a".into()),
            user_signal: Some(UserSignal::UserMessage),
        };
        let mut f = FileRow {
            meta: meta.clone(),
            meta_offset: 10,
            meta_settled: true,
            reparse: ReparsePoint {
                line: 3,
                byte: Some(7),
            },
            project: Some("p".into()),
            harness: Some("codex".into()),
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
        assert_eq!(got.meta, meta);
        assert_eq!((got.meta_offset, got.meta_settled), (10, true));
        assert_eq!(
            got.reparse,
            ReparsePoint {
                line: 3,
                byte: Some(7)
            }
        );
        assert_eq!(count(&c, "files"), 1);

        assert_eq!(meta_get(&c, "k"), None);
        meta_set(&c, "k", "v1").unwrap();
        meta_set(&c, "k", "v2").unwrap();
        assert_eq!(meta_get(&c, "k").as_deref(), Some("v2"));
    }
}
