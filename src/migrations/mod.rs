//! Data dir migrations: one script per revision, run in order by `run` under `sync.lock`.
//!
//! The applied revision is `meta.revision` in the DB, written in the same transaction as the
//! revision's script, so a crash leaves either both or neither. A revision script gets that
//! transaction (`Migration::tx`) and the data dir (`Migration::paths`), so it can change the
//! schema, rewrite rows, and move files. File work is not undone by a rollback, so a script
//! must be safe to run again after a crash part way through.
//!
//! Adding a revision: a new `rNNNN_<name>.rs` with `NAME` and `up`, then one line in
//! `REVISIONS`. A fresh DB is created from `db::SCHEMA`, which must already match every
//! revision's schema, and is stamped with `HEAD` without running any script.

use crate::db::meta_set;
use crate::paths::{Paths, VERSION};
use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension, Transaction};
use std::fs;

mod r0001_file_meta_and_reparse_columns;
mod r0002_relative_archive_paths;
mod r0003_relative_archive_paths_again;

pub struct Migration<'a> {
    paths: &'a Paths,
    tx: &'a Transaction<'a>,
}

impl Migration<'_> {
    pub fn paths(&self) -> &Paths {
        self.paths
    }

    pub fn tx(&self) -> &Transaction<'_> {
        self.tx
    }

    pub fn sql(&self, sql: &str) -> Result<()> {
        Ok(self.tx.execute_batch(sql)?)
    }
}

struct Revision {
    id: i64,
    name: &'static str,
    up: fn(&Migration) -> Result<()>,
}

const REVISIONS: &[Revision] = &[
    Revision {
        id: 1,
        name: r0001_file_meta_and_reparse_columns::NAME,
        up: r0001_file_meta_and_reparse_columns::up,
    },
    Revision {
        id: 2,
        name: r0002_relative_archive_paths::NAME,
        up: r0002_relative_archive_paths::up,
    },
    Revision {
        id: 3,
        name: r0003_relative_archive_paths_again::NAME,
        up: r0003_relative_archive_paths_again::up,
    },
];

pub const HEAD: i64 = REVISIONS[REVISIONS.len() - 1].id;

/// Fences binaries older than the data dir off writing it. Every `files` insert or update, new
/// exchange and `meta` write first compares `em_revision()`, this binary's `HEAD`, with
/// `meta.revision`. Binaries from before revisions do not define the function at all, so their
/// statements fail to prepare ("no such function"); a newer data dir aborts a binary with an
/// older `HEAD`. Either way the file's transaction rolls back before it registers a file or
/// starts a generation under a layout it does not know, and reads still work. Revision 2 installs
/// it before converting paths, and `db::open` adds it to a fresh DB.
pub const FENCE: &str = "
CREATE TRIGGER IF NOT EXISTS fence_files_insert BEFORE INSERT ON files
  WHEN em_revision() < CAST((SELECT value FROM meta WHERE key = 'revision') AS INTEGER)
BEGIN SELECT RAISE(ABORT, 'episodic-memory is older than this data dir; restart this session'); END;
CREATE TRIGGER IF NOT EXISTS fence_files_update BEFORE UPDATE ON files
  WHEN em_revision() < CAST((SELECT value FROM meta WHERE key = 'revision') AS INTEGER)
BEGIN SELECT RAISE(ABORT, 'episodic-memory is older than this data dir; restart this session'); END;
CREATE TRIGGER IF NOT EXISTS fence_exchanges_insert BEFORE INSERT ON exchanges
  WHEN em_revision() < CAST((SELECT value FROM meta WHERE key = 'revision') AS INTEGER)
BEGIN SELECT RAISE(ABORT, 'episodic-memory is older than this data dir; restart this session'); END;
CREATE TRIGGER IF NOT EXISTS fence_meta_insert BEFORE INSERT ON meta
  WHEN em_revision() < CAST((SELECT value FROM meta WHERE key = 'revision') AS INTEGER)
BEGIN SELECT RAISE(ABORT, 'episodic-memory is older than this data dir; restart this session'); END;
CREATE TRIGGER IF NOT EXISTS fence_meta_update BEFORE UPDATE ON meta
  WHEN em_revision() < CAST((SELECT value FROM meta WHERE key = 'revision') AS INTEGER)
BEGIN SELECT RAISE(ABORT, 'episodic-memory is older than this data dir; restart this session'); END;
";

/// Defines `em_revision()` (this binary's `HEAD`) on `c`, which `FENCE` requires to write.
pub fn register_revision_fn(c: &Connection) -> rusqlite::Result<()> {
    c.create_scalar_function(
        "em_revision",
        0,
        rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |_| Ok(HEAD),
    )
}

/// Records `revision` as applied, in `tx`.
pub fn stamp(tx: &Transaction, revision: i64) -> Result<()> {
    meta_set(tx, "revision", &revision.to_string())
}

fn meta_revision(c: &Connection) -> Result<Option<i64>> {
    c.query_row("SELECT value FROM meta WHERE key = 'revision'", [], |r| {
        r.get::<_, String>(0)
    })
    .optional()?
    .map(|v| v.parse().context("meta.revision is not a number"))
    .transpose()
}

/// `<data>/REVISION`, where v4.1.0 kept the revision.
fn revision_file(paths: &Paths) -> Result<Option<i64>> {
    let file = paths.revision_file();
    match fs::read_to_string(&file) {
        Ok(s) => Ok(Some(s.trim().parse().with_context(|| {
            format!("{}: not a revision number", file.display())
        })?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// The revision of the DB behind `c`, and whether `meta.revision` records it. Without it, the
/// DB's `user_version` decides: 1 (up to v4.0.5) is revision 0; 4 is revision 1, or whatever
/// the v4.1.0 `REVISION` file says. The file is ignored when unreadable or beside a version 1
/// schema, which it cannot describe.
pub fn current(paths: &Paths, c: &Connection) -> Result<(i64, bool)> {
    if let Some(r) = meta_revision(c)? {
        return Ok((r, true));
    }
    let r = match c.query_row("PRAGMA user_version", [], |r| r.get(0))? {
        1 => 0,
        // Revision 1 is what made user_version 4, and v4.1.0 knew no revision past 2.
        4 => match revision_file(paths) {
            Ok(Some(r)) => r.clamp(1, 2),
            _ => 1,
        },
        v => bail!("unsupported schema version {v}"),
    };
    Ok((r, false))
}

/// Brings the DB behind `conn` and the data dir to `HEAD`. The caller holds `sync.lock`.
/// Returns the revisions applied.
pub fn run(paths: &Paths, conn: &mut Connection) -> Result<Vec<i64>> {
    let (from, recorded) = current(paths, conn)?;
    if from > HEAD {
        bail!(
            "data dir is at revision {from}, newer than this binary ({VERSION}, revision {HEAD})"
        );
    }
    // Recorded only together with a revision's own changes: a stamp committed alone ahead of a
    // failing revision 1 would outlive an older binary migrating the schema in between. Without
    // meta.revision, `from` is below HEAD, so a revision always runs.
    let mut applied = Vec::new();
    for r in REVISIONS.iter().filter(|r| r.id > from) {
        let tx = conn.transaction()?;
        (r.up)(&Migration { paths, tx: &tx })
            .with_context(|| format!("revision {} ({})", r.id, r.name))?;
        stamp(&tx, r.id)?;
        tx.commit()?;
        applied.push(r.id);
    }
    // meta.revision supersedes the v4.1.0 file, which the fence keeps v4.1.0 from rewriting.
    if !recorded {
        match fs::remove_file(paths.revision_file()) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
    }
    Ok(applied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::{FileMeta, ReparsePoint};
    use std::path::PathBuf;

    /// Every table's columns (sorted by name), every index and every trigger.
    fn schema(c: &Connection) -> Vec<String> {
        let mut out: Vec<String> = c
            .prepare(
                "SELECT m.type || ' ' || m.name || ': ' || ifnull(p.name, '') || ' ' ||
                        ifnull(p.type, '') || ' ' || ifnull(p.\"notnull\", '') || ' ' ||
                        ifnull(p.dflt_value, '') || ' ' || ifnull(p.pk, '')
                 FROM sqlite_master m LEFT JOIN pragma_table_info(m.name) p
                 WHERE m.type IN ('table', 'index')
                 UNION ALL
                 SELECT 'trigger ' || name || ': ' || sql FROM sqlite_master WHERE type = 'trigger'",
            )
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            // Trigger SQL keeps its source formatting.
            .map(|s: String| s.split_whitespace().collect::<Vec<_>>().join(" "))
            .collect();
        out.sort();
        out
    }

    /// The schema shipped up to v4.0.5 (DB `user_version` 1).
    const V1: &str = r#"
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

    /// A data dir as a binary before `meta.revision` left it, with DB `user_version` 1 or 4.
    fn legacy(version: i64) -> (tempfile::TempDir, Paths) {
        let t = tempfile::tempdir().unwrap();
        let paths = Paths::new(t.path().to_path_buf());
        let c = if version == 1 {
            let c = older_binary(&paths);
            c.execute_batch(V1).unwrap();
            c
        } else {
            let c = crate::db::open(&paths.db()).unwrap();
            c.execute("DELETE FROM meta WHERE key = 'revision'", [])
                .unwrap();
            let triggers: Vec<String> = c
                .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            for t in triggers {
                c.execute_batch(&format!("DROP TRIGGER {t}")).unwrap();
            }
            c.execute_batch("PRAGMA user_version = 4").unwrap();
            c
        };
        c.execute(
            "INSERT INTO files(source_path, source_kind, archive_path, \"offset\", reparse_line)
               VALUES ('/src/a.jsonl', 'codex-sessions', 'a.jsonl', 10, 7)",
            [],
        )
        .unwrap();
        (t, paths)
    }

    /// What `run_sync` does before indexing.
    fn migrate(paths: &Paths) -> Result<Vec<i64>> {
        fs::create_dir_all(&paths.data)?;
        run(paths, &mut crate::db::open(&paths.db())?)
    }

    fn revision(paths: &Paths) -> i64 {
        current(paths, &crate::db::open(&paths.db()).unwrap())
            .unwrap()
            .0
    }

    /// Exchanges at `archive_path`s, as absolute paths under `data` were stored before revision 2.
    fn add_absolute_rows(paths: &Paths, data: &str) {
        let c = crate::db::open(&paths.db()).unwrap();
        let a = format!("{data}conversation-archive/codex-sessions/a.jsonl");
        c.execute("UPDATE files SET archive_path = ?1", [&a])
            .unwrap();
        c.execute(
            "INSERT INTO files(source_path, source_kind, archive_path)
               VALUES ('/src/b.jsonl', 'codex-sessions', '/elsewhere/b.jsonl')",
            [],
        )
        .unwrap();
        c.execute(
            "INSERT INTO exchanges(archive_path, line_start, line_end, project, harness, ts,
                                   user_message, assistant_message)
               VALUES (?1, 1, 2, 'p', 'codex', 0, 'u', 'a')",
            [&a],
        )
        .unwrap();
    }

    fn assert_relative(paths: &Paths) {
        let c = crate::db::open(&paths.db()).unwrap();
        let get = |sql: &str| -> String { c.query_row(sql, [], |r| r.get(0)).unwrap() };
        let key = "conversation-archive/codex-sessions/a.jsonl";
        assert_eq!(
            get("SELECT archive_path FROM files WHERE source_path = '/src/a.jsonl'"),
            key
        );
        assert_eq!(get("SELECT archive_path FROM exchanges"), key);
        assert!(paths.archive_file(key).starts_with(&paths.data));
        assert_eq!(
            get("SELECT archive_path FROM files WHERE source_path = '/src/b.jsonl'"),
            "/elsewhere/b.jsonl"
        );
    }

    #[test]
    fn a_fresh_db_is_at_head_whoever_creates_it() {
        let t = tempfile::tempdir().unwrap();
        let paths = Paths::new(t.path().join("d"));
        assert_eq!(migrate(&paths).unwrap(), Vec::<i64>::new());
        assert_eq!(revision(&paths), HEAD);
        // MCP search or the embed worker may open the DB before the first sync.
        let t = tempfile::tempdir().unwrap();
        let paths = Paths::new(t.path().to_path_buf());
        drop(crate::db::open(&paths.db()).unwrap());
        assert_eq!(revision(&paths), HEAD);
        assert_eq!(migrate(&paths).unwrap(), Vec::<i64>::new());
    }

    #[test]
    fn every_released_version_reaches_the_fresh_schema() {
        let t = tempfile::tempdir().unwrap();
        let fresh = crate::db::open(&t.path().join("fresh.db")).unwrap();
        for (version, from) in [(1, 0), (4, 1)] {
            let (_t, paths) = legacy(version);
            assert_eq!(revision(&paths), from);
            let applied = migrate(&paths).unwrap();
            assert_eq!(applied, (from + 1..=HEAD).collect::<Vec<_>>(), "v{version}");
            assert_eq!(revision(&paths), HEAD);
            let c = crate::db::open(&paths.db()).unwrap();
            assert_eq!(schema(&c), schema(&fresh), "v{version}");
            let got = crate::db::get_file(&c, "/src/a.jsonl").unwrap().unwrap();
            assert_eq!((got.offset, got.meta_offset), (10, 0), "v{version}");
            assert_eq!(got.meta, FileMeta::default(), "v{version}");
            // The reparse line is kept; its byte position is unknown and found by counting.
            assert_eq!(
                got.reparse,
                ReparsePoint {
                    line: 7,
                    byte: None
                },
                "v{version}"
            );
        }
    }

    #[test]
    fn a_v4_1_0_data_dir_continues_from_its_revision_file() {
        let (_t, paths) = legacy(4);
        fs::write(paths.revision_file(), "2\n").unwrap();
        assert_eq!(revision(&paths), 2);
        assert_eq!(migrate(&paths).unwrap(), (3..=HEAD).collect::<Vec<_>>());
        assert_eq!(revision(&paths), HEAD);
        assert!(!paths.revision_file().exists());
    }

    #[test]
    fn an_unreadable_revision_file_falls_back_to_user_version() {
        let (_t, paths) = legacy(4);
        fs::write(paths.revision_file(), "").unwrap();
        assert_eq!(migrate(&paths).unwrap(), (2..=HEAD).collect::<Vec<_>>());
        assert!(!paths.revision_file().exists());
    }

    #[test]
    fn an_unreleased_schema_version_is_refused() {
        let (_t, paths) = legacy(4);
        crate::db::open(&paths.db())
            .unwrap()
            .execute_batch("PRAGMA user_version = 3")
            .unwrap();
        let err = migrate(&paths).unwrap_err().to_string();
        assert!(err.contains("schema version 3"), "{err}");
    }

    #[test]
    fn archive_paths_become_relative_to_the_data_dir() {
        let (_t, paths) = legacy(4);
        add_absolute_rows(&paths, &format!("{}/", paths.data.display()));
        assert_eq!(migrate(&paths).unwrap(), (2..=HEAD).collect::<Vec<_>>());
        assert_relative(&paths);
    }

    #[test]
    fn a_data_dir_ending_in_a_separator_is_converted_too() {
        let (t, _) = legacy(4);
        // EPISODIC_MEMORY_DIR=/x/d/: paths were joined as /x/d/conversation-archive/...
        let paths = Paths::new(PathBuf::from(format!("{}/", t.path().display())));
        add_absolute_rows(&paths, &paths.data.to_string_lossy());
        // v4.1.0 already ran revision 2 with the wrong prefix, converting nothing.
        fs::write(paths.revision_file(), "2\n").unwrap();
        assert_eq!(migrate(&paths).unwrap(), vec![3]);
        assert_relative(&paths);
    }

    #[test]
    fn a_revision_file_beside_a_version_1_schema_is_ignored() {
        let (_t, paths) = legacy(1);
        fs::write(paths.revision_file(), "2\n").unwrap();
        assert_eq!(revision(&paths), 0);
        assert_eq!(migrate(&paths).unwrap(), (1..=HEAD).collect::<Vec<_>>());
    }

    /// A connection as an older binary opens it: sqlite-vec loaded, no `em_revision()`.
    fn older_binary(paths: &Paths) -> Connection {
        drop(crate::db::open(&paths.data.join("vec.db")).unwrap()); // loads sqlite-vec
        Connection::open(paths.db()).unwrap()
    }

    #[test]
    fn older_binaries_can_read_but_not_write() {
        let (_t, paths) = legacy(4);
        migrate(&paths).unwrap();
        let old = older_binary(&paths);
        let n: i64 = old
            .query_row("SELECT count(*) FROM files", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
        for sql in [
            "INSERT INTO files(source_path, source_kind, archive_path)
               VALUES ('/src/c.jsonl', 'codex-sessions', '/d/c.jsonl')",
            "UPDATE files SET \"offset\" = 20",
            "INSERT INTO meta(key, value) VALUES ('last_sync', 'x')",
            "UPDATE meta SET value = 'x' WHERE key = 'revision'",
            "INSERT INTO exchanges(archive_path, line_start, line_end, project, harness, ts,
                                   user_message, assistant_message)
               VALUES ('a.jsonl', 1, 2, 'p', 'codex', 0, 'u', 'a')",
        ] {
            let err = old.execute(sql, []).unwrap_err().to_string();
            assert!(err.contains("em_revision"), "{err}");
        }
        // This binary writes as before.
        crate::db::open(&paths.db())
            .unwrap()
            .execute("UPDATE files SET \"offset\" = 20", [])
            .unwrap();
    }

    #[test]
    fn an_older_binary_migrating_after_a_failed_revision_1_does_not_strand_the_db() {
        let (_t, paths) = legacy(1);
        crate::db::open(&paths.db())
            .unwrap()
            .execute_batch("ALTER TABLE files ADD COLUMN reparse_offset_line INTEGER")
            .unwrap();
        assert!(migrate(&paths).is_err());
        // Meanwhile a 4.0.7 opens the version 1 DB and migrates it to version 4 itself.
        older_binary(&paths)
            .execute_batch(
                "ALTER TABLE files ADD COLUMN sidechain_known INTEGER NOT NULL DEFAULT 0;
                 ALTER TABLE files ADD COLUMN agent_path TEXT;
                 ALTER TABLE files ADD COLUMN meta_offset INTEGER NOT NULL DEFAULT 0;
                 ALTER TABLE files ADD COLUMN meta_settled INTEGER NOT NULL DEFAULT 0;
                 ALTER TABLE files ADD COLUMN reparse_offset INTEGER NOT NULL DEFAULT 0;
                 PRAGMA user_version = 4;",
            )
            .unwrap();
        assert_eq!(migrate(&paths).unwrap(), (2..=HEAD).collect::<Vec<_>>());
    }

    #[test]
    fn absolute_paths_written_after_v4_1_0_are_converted() {
        let (_t, paths) = legacy(4);
        // v4.1.0 ran revision 2 (unfenced); a 4.0.7 daemon then registered a new file.
        add_absolute_rows(&paths, &format!("{}/", paths.data.display()));
        fs::write(paths.revision_file(), "2\n").unwrap();
        assert_eq!(migrate(&paths).unwrap(), vec![3]);
        assert_relative(&paths);
    }

    #[test]
    fn a_revision_file_is_clamped_to_what_v4_1_0_could_write() {
        let (_t, paths) = legacy(4);
        fs::write(paths.revision_file(), "0\n").unwrap();
        assert_eq!(revision(&paths), 1);
        fs::write(paths.revision_file(), "3\n").unwrap();
        assert_eq!(revision(&paths), 2);
    }

    #[test]
    fn a_binary_behind_the_data_dir_cannot_write() {
        let (_t, paths) = legacy(4);
        migrate(&paths).unwrap();
        let c = crate::db::open(&paths.db()).unwrap();
        crate::db::meta_set(&c, "revision", &(HEAD + 1).to_string()).unwrap();
        let err = c
            .execute("UPDATE files SET \"offset\" = 20", [])
            .unwrap_err()
            .to_string();
        assert!(err.contains("older than this data dir"), "{err}");
    }

    #[test]
    fn a_file_registered_twice_keeps_its_absolute_path() {
        let (_t, paths) = legacy(4);
        let key = "conversation-archive/codex-sessions/a.jsonl";
        let abs = format!("{}/{key}", paths.data.display());
        let c = crate::db::open(&paths.db()).unwrap();
        c.execute("UPDATE files SET archive_path = ?1", [key])
            .unwrap();
        c.execute(
            "INSERT INTO files(source_path, source_kind, archive_path)
               VALUES ('/link/a.jsonl', 'codex-sessions', ?1)",
            [&abs],
        )
        .unwrap();
        c.execute(
            "INSERT INTO exchanges(archive_path, line_start, line_end, project, harness, ts,
                                   user_message, assistant_message)
               VALUES (?1, 1, 2, 'p', 'codex', 0, 'u', 'a')",
            [&abs],
        )
        .unwrap();
        drop(c);
        assert_eq!(migrate(&paths).unwrap(), (2..=HEAD).collect::<Vec<_>>());
        let c = crate::db::open(&paths.db()).unwrap();
        let get = |sql: &str| -> String { c.query_row(sql, [], |r| r.get(0)).unwrap() };
        assert_eq!(
            get("SELECT archive_path FROM files WHERE source_path = '/link/a.jsonl'"),
            abs
        );
        assert_eq!(get("SELECT archive_path FROM exchanges"), abs);
    }

    #[test]
    fn run_at_head_does_nothing() {
        let (_t, paths) = legacy(1);
        migrate(&paths).unwrap();
        assert_eq!(migrate(&paths).unwrap(), Vec::<i64>::new());
    }

    #[test]
    fn a_failed_revision_rolls_back_and_runs_again() {
        let (_t, paths) = legacy(1);
        // Revision 1 fails part way: the last column it adds is already there.
        crate::db::open(&paths.db())
            .unwrap()
            .execute_batch("ALTER TABLE files ADD COLUMN reparse_offset_line INTEGER")
            .unwrap();
        assert!(migrate(&paths).is_err());
        // Nothing recorded: older binaries still use the DB as before.
        assert_eq!(revision(&paths), 0);
        let v: i64 = crate::db::open(&paths.db())
            .unwrap()
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, 1);
        let c = crate::db::open(&paths.db()).unwrap();
        // Rolled back: none of the earlier columns of revision 1 were kept.
        let n: i64 = c
            .query_row(
                "SELECT count(*) FROM pragma_table_info('files') WHERE name = 'agent_path'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0);
        c.execute_batch("ALTER TABLE files DROP COLUMN reparse_offset_line")
            .unwrap();
        assert_eq!(migrate(&paths).unwrap(), (1..=HEAD).collect::<Vec<_>>());
        assert_eq!(revision(&paths), HEAD);
    }

    #[test]
    fn a_newer_revision_is_refused() {
        let (_t, paths) = legacy(4);
        crate::db::meta_set(
            &crate::db::open(&paths.db()).unwrap(),
            "revision",
            &(HEAD + 1).to_string(),
        )
        .unwrap();
        let err = migrate(&paths).unwrap_err().to_string();
        assert!(err.contains("newer than this binary"), "{err}");
    }
}
