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

use crate::db::{meta_get, meta_set};
use crate::paths::{Paths, VERSION};
use anyhow::{Context, Result, bail};
use rusqlite::{Connection, Transaction};
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

/// `user_version` of every DB that tracks `meta.revision`. Binaries from before that refuse
/// it in `db::open` (4.0.7 rejects 2 and 3; 4.0.6 fails migrating 2 to 3), so they cannot
/// write a layout they do not know.
pub const USER_VERSION: i64 = 2;

/// Records `revision` as applied, in `tx`.
pub fn stamp(tx: &Transaction, revision: i64) -> Result<()> {
    meta_set(tx, "revision", &revision.to_string())?;
    tx.execute_batch(&format!("PRAGMA user_version = {USER_VERSION}"))?;
    Ok(())
}

fn meta_revision(c: &Connection) -> Result<Option<i64>> {
    meta_get(c, "revision")
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

/// The revision of the DB behind `c`: `meta.revision`, else the v4.1.0 `REVISION` file, else
/// the `user_version` before either: 1 (up to v4.0.5) is revision 0, 4 is revision 1.
pub fn current(paths: &Paths, c: &Connection) -> Result<i64> {
    if let Some(r) = meta_revision(c)? {
        return Ok(r);
    }
    // A v4.1.0 file that cannot be read is treated as absent: user_version is still right.
    if let Ok(Some(r)) = revision_file(paths) {
        return Ok(r);
    }
    match c.query_row("PRAGMA user_version", [], |r| r.get(0))? {
        1 => Ok(0),
        4 => Ok(1),
        v => bail!("unsupported schema version {v}; delete the DB to rebuild it"),
    }
}

/// Brings the data dir to `HEAD`. The caller holds `sync.lock`. Returns the revisions applied.
pub fn run(paths: &Paths) -> Result<Vec<i64>> {
    fs::create_dir_all(&paths.data)?;
    let mut conn = crate::db::open(&paths.db())?;
    let from = current(paths, &conn)?;
    if from > HEAD {
        bail!(
            "data dir is at revision {from}, newer than this binary ({VERSION}, revision {HEAD})"
        );
    }
    if meta_revision(&conn)?.is_none() {
        // Stamp first so older binaries refuse the DB before any revision changes the layout.
        let tx = conn.transaction()?;
        stamp(&tx, from)?;
        tx.commit()?;
    }
    // Without the v4.1.0 file, a v4.1.0 binary falls back to user_version and refuses the DB
    // instead of trusting a revision that later ones moved past.
    match fs::remove_file(paths.revision_file()) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
        _ => {}
    }
    let mut applied = Vec::new();
    for r in REVISIONS.iter().filter(|r| r.id > from) {
        let tx = conn.transaction()?;
        (r.up)(&Migration { paths, tx: &tx })
            .with_context(|| format!("revision {} ({})", r.id, r.name))?;
        stamp(&tx, r.id)?;
        tx.commit()?;
        applied.push(r.id);
    }
    Ok(applied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::{FileMeta, ReparsePoint};
    use std::path::PathBuf;

    /// Every table's columns (sorted by name) and every index, as `PRAGMA` reports them.
    fn schema(c: &Connection) -> Vec<String> {
        let mut out: Vec<String> = c
            .prepare(
                "SELECT m.type || ' ' || m.name || ': ' || ifnull(p.name, '') || ' ' ||
                        ifnull(p.type, '') || ' ' || ifnull(p.\"notnull\", '') || ' ' ||
                        ifnull(p.dflt_value, '') || ' ' || ifnull(p.pk, '')
                 FROM sqlite_master m LEFT JOIN pragma_table_info(m.name) p
                 WHERE m.type IN ('table', 'index')",
            )
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
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
            drop(crate::db::open(&t.path().join("vec.db")).unwrap()); // loads sqlite-vec
            let c = Connection::open(paths.db()).unwrap();
            c.execute_batch(V1).unwrap();
            c
        } else {
            let c = crate::db::open(&paths.db()).unwrap();
            c.execute_batch("DELETE FROM meta WHERE key = 'revision'; PRAGMA user_version = 4;")
                .unwrap();
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

    fn revision(paths: &Paths) -> i64 {
        current(paths, &crate::db::open(&paths.db()).unwrap()).unwrap()
    }

    fn user_version(paths: &Paths) -> i64 {
        crate::db::open(&paths.db())
            .unwrap()
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap()
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
        assert_eq!(run(&paths).unwrap(), Vec::<i64>::new());
        assert_eq!(revision(&paths), HEAD);
        // MCP search or the embed worker may open the DB before the first sync.
        let t = tempfile::tempdir().unwrap();
        let paths = Paths::new(t.path().to_path_buf());
        drop(crate::db::open(&paths.db()).unwrap());
        assert_eq!(revision(&paths), HEAD);
        assert_eq!(run(&paths).unwrap(), Vec::<i64>::new());
        assert_eq!(user_version(&paths), USER_VERSION);
    }

    #[test]
    fn every_released_version_reaches_the_fresh_schema() {
        let t = tempfile::tempdir().unwrap();
        let fresh = crate::db::open(&t.path().join("fresh.db")).unwrap();
        for (version, from) in [(1, 0), (4, 1)] {
            let (_t, paths) = legacy(version);
            assert_eq!(revision(&paths), from);
            let applied = run(&paths).unwrap();
            assert_eq!(applied, (from + 1..=HEAD).collect::<Vec<_>>(), "v{version}");
            assert_eq!(revision(&paths), HEAD);
            assert_eq!(user_version(&paths), USER_VERSION, "v{version}");
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
        assert_eq!(run(&paths).unwrap(), (3..=HEAD).collect::<Vec<_>>());
        assert_eq!(revision(&paths), HEAD);
        assert_eq!(user_version(&paths), USER_VERSION);
        assert!(!paths.revision_file().exists());
    }

    #[test]
    fn an_unreadable_revision_file_falls_back_to_user_version() {
        let (_t, paths) = legacy(4);
        fs::write(paths.revision_file(), "").unwrap();
        assert_eq!(run(&paths).unwrap(), (2..=HEAD).collect::<Vec<_>>());
        assert!(!paths.revision_file().exists());
    }

    #[test]
    fn an_unreleased_schema_version_is_refused() {
        let (_t, paths) = legacy(4);
        crate::db::open(&paths.db())
            .unwrap()
            .execute_batch("PRAGMA user_version = 3")
            .unwrap();
        let err = run(&paths).unwrap_err().to_string();
        assert!(err.contains("schema version 3"), "{err}");
    }

    #[test]
    fn archive_paths_become_relative_to_the_data_dir() {
        let (_t, paths) = legacy(4);
        add_absolute_rows(&paths, &format!("{}/", paths.data.display()));
        assert_eq!(run(&paths).unwrap(), (2..=HEAD).collect::<Vec<_>>());
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
        assert_eq!(run(&paths).unwrap(), vec![3]);
        assert_relative(&paths);
    }

    #[test]
    fn run_at_head_does_nothing() {
        let (_t, paths) = legacy(1);
        run(&paths).unwrap();
        assert_eq!(run(&paths).unwrap(), Vec::<i64>::new());
    }

    #[test]
    fn a_failed_revision_rolls_back_and_runs_again() {
        let (_t, paths) = legacy(1);
        // Revision 1 fails part way: the last column it adds is already there.
        crate::db::open(&paths.db())
            .unwrap()
            .execute_batch("ALTER TABLE files ADD COLUMN reparse_offset_line INTEGER")
            .unwrap();
        assert!(run(&paths).is_err());
        // Stamped at revision 0 already, so older binaries refuse the DB from here on.
        assert_eq!(revision(&paths), 0);
        assert_eq!(user_version(&paths), USER_VERSION);
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
        assert_eq!(run(&paths).unwrap(), (1..=HEAD).collect::<Vec<_>>());
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
        let err = run(&paths).unwrap_err().to_string();
        assert!(err.contains("newer than this binary"), "{err}");
    }
}
