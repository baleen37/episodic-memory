//! Data dir migrations: one script per revision, run in order by `run` under `sync.lock`.
//!
//! The applied revision is stored in `<data>/REVISION`, outside the DB, because the DB's own
//! location and name are things a revision may change. A revision script gets one DB
//! transaction (`Migration::tx`) and the data dir (`Migration::paths`), so it can change the
//! schema, rewrite rows, and move files. It must be safe to run again after a crash part way
//! through: `REVISION` is written only after the script's transaction commits.
//!
//! Adding a revision: a new `rNNNN_<name>.rs` with `NAME` and `up`, then one line in
//! `REVISIONS`. A fresh DB is created from `db::SCHEMA`, which must already match every
//! revision's schema, and is stamped with `HEAD` without running any script.

use crate::paths::{Paths, VERSION, try_lock};
use anyhow::{Context, Result, bail};
use rusqlite::{Connection, Transaction};
use std::fs;

mod r0001_file_meta_columns;
mod r0002_reparse_offset;
mod r0003_reparse_offset_line;
mod r0004_relative_archive_paths;

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
        name: r0001_file_meta_columns::NAME,
        up: r0001_file_meta_columns::up,
    },
    Revision {
        id: 2,
        name: r0002_reparse_offset::NAME,
        up: r0002_reparse_offset::up,
    },
    Revision {
        id: 3,
        name: r0003_reparse_offset_line::NAME,
        up: r0003_reparse_offset_line::up,
    },
    Revision {
        id: 4,
        name: r0004_relative_archive_paths::NAME,
        up: r0004_relative_archive_paths::up,
    },
];

pub const HEAD: i64 = REVISIONS[REVISIONS.len() - 1].id;

/// The revision in `REVISION`; `None` when the file does not exist.
pub fn stored(paths: &Paths) -> Result<Option<i64>> {
    let file = paths.revision_file();
    match fs::read_to_string(&file) {
        Ok(s) => Ok(Some(s.trim().parse().with_context(|| {
            format!("{}: not a revision number", file.display())
        })?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// The revision of a data dir from before `REVISION` existed. The DB's `user_version` tracked
/// the same schema steps: `user_version` N is revision N - 1. 0 means no schema was created
/// yet (`db::open` creates the latest one).
pub fn from_user_version(version: i64) -> Option<i64> {
    (version > 0).then_some(version - 1)
}

/// The applied revision. `None` for a data dir that has no DB yet.
pub fn current(paths: &Paths) -> Result<Option<i64>> {
    if let Some(r) = stored(paths)? {
        return Ok(Some(r));
    }
    if !paths.db().exists() {
        return Ok(None);
    }
    let c = crate::db::open_readonly(&paths.db(), false)?;
    Ok(from_user_version(c.query_row(
        "PRAGMA user_version",
        [],
        |r| r.get(0),
    )?))
}

fn write_revision(paths: &Paths, id: i64) -> Result<()> {
    let file = paths.revision_file();
    let tmp = file.with_extension("tmp");
    fs::write(&tmp, format!("{id}\n"))?;
    fs::rename(&tmp, &file)?;
    Ok(())
}

/// A daemon of another version still running may write the old layout after a revision moved
/// it, so revisions wait until it exits. Its lock file stays behind after it exits.
fn other_daemon_running(paths: &Paths) -> Result<Option<String>> {
    let own = paths.daemon_lock();
    for entry in fs::read_dir(&paths.data)? {
        let path = entry?.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        if name.starts_with("daemon-")
            && name.ends_with(".lock")
            && path != own
            && try_lock(&path)?.is_none()
        {
            return Ok(Some(name.into_owned()));
        }
    }
    Ok(None)
}

/// Brings the data dir to `HEAD`. The caller holds `sync.lock`. Returns the revisions applied.
pub fn run(paths: &Paths) -> Result<Vec<i64>> {
    let Some(from) = current(paths)? else {
        fs::create_dir_all(&paths.data)?;
        drop(crate::db::open(&paths.db())?);
        write_revision(paths, HEAD)?;
        return Ok(Vec::new());
    };
    if from > HEAD {
        bail!(
            "data dir is at revision {from}, newer than this binary ({VERSION}, revision {HEAD})"
        );
    }
    if from == HEAD {
        return Ok(Vec::new());
    }
    if let Some(lock) = other_daemon_running(paths)? {
        bail!("revision {from} -> {HEAD} waits for the daemon holding {lock} to exit");
    }
    let mut conn: Connection = crate::db::open(&paths.db())?;
    let mut applied = Vec::new();
    for r in REVISIONS.iter().filter(|r| r.id > from) {
        let tx = conn.transaction()?;
        (r.up)(&Migration { paths, tx: &tx })
            .with_context(|| format!("revision {} ({})", r.id, r.name))?;
        tx.commit()?;
        write_revision(paths, r.id)?;
        applied.push(r.id);
    }
    Ok(applied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fs2::FileExt;

    fn columns(c: &Connection, table: &str) -> Vec<String> {
        let mut v: Vec<String> = c
            .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        v.sort();
        v
    }

    /// A data dir as a binary with DB `user_version` `version` left it: no `REVISION` file and
    /// the columns later versions added dropped.
    fn legacy(version: i64) -> (tempfile::TempDir, Paths) {
        let t = tempfile::tempdir().unwrap();
        let paths = Paths::new(t.path().to_path_buf());
        let c = crate::db::open(&paths.db()).unwrap();
        let drops: &[&str] = match version {
            1 => &[
                "sidechain_known",
                "agent_path",
                "meta_offset",
                "meta_settled",
                "reparse_offset",
                "reparse_offset_line",
            ],
            2 => &["reparse_offset", "reparse_offset_line"],
            3 => &["reparse_offset_line"],
            _ => &[],
        };
        for col in drops {
            c.execute_batch(&format!("ALTER TABLE files DROP COLUMN {col}"))
                .unwrap();
        }
        c.execute_batch(&format!(
            "INSERT INTO files(source_path, source_kind, archive_path, \"offset\", reparse_line)
               VALUES ('/src/a.jsonl', 'codex-sessions', 'a.jsonl', 900, 7);
             PRAGMA user_version = {version};"
        ))
        .unwrap();
        if version >= 3 {
            // A version 3 byte position may be stale: older binaries moved `reparse_line` alone.
            c.execute("UPDATE files SET reparse_offset = 300", [])
                .unwrap();
        }
        (t, paths)
    }

    #[test]
    fn fresh_data_dir_is_created_at_head_without_running_scripts() {
        let t = tempfile::tempdir().unwrap();
        let paths = Paths::new(t.path().join("d"));
        assert_eq!(current(&paths).unwrap(), None);
        assert_eq!(run(&paths).unwrap(), Vec::<i64>::new());
        assert_eq!(current(&paths).unwrap(), Some(HEAD));
        assert!(paths.db().exists());
    }

    #[test]
    fn every_legacy_version_reaches_the_fresh_schema() {
        let fresh = tempfile::tempdir().unwrap();
        let fresh = crate::db::open(&fresh.path().join("f.db")).unwrap();
        for version in 1..=4 {
            let (_t, paths) = legacy(version);
            assert_eq!(current(&paths).unwrap(), Some(version - 1));
            let applied = run(&paths).unwrap();
            assert_eq!(
                applied,
                ((version)..=HEAD).collect::<Vec<_>>(),
                "v{version}"
            );
            assert_eq!(current(&paths).unwrap(), Some(HEAD));
            let c = crate::db::open(&paths.db()).unwrap();
            assert_eq!(columns(&c, "files"), columns(&fresh, "files"), "v{version}");
            let got = crate::db::get_file(&c, "/src/a.jsonl").unwrap().unwrap();
            assert_eq!((got.offset, got.meta_offset), (900, 0), "v{version}");
            assert_eq!(got.meta, crate::parse::FileMeta::default(), "v{version}");
            // The reparse line is kept; its byte position is unknown and found by counting.
            assert_eq!(
                got.reparse,
                crate::parse::ReparsePoint {
                    line: 7,
                    byte: None
                },
                "v{version}"
            );
        }
    }

    #[test]
    fn archive_paths_become_relative_to_the_data_dir() {
        let (_t, paths) = legacy(4);
        let inside = paths.archive_root().join("codex-sessions/a.jsonl");
        let inside = inside.to_str().unwrap();
        let c = crate::db::open(&paths.db()).unwrap();
        c.execute("UPDATE files SET archive_path = ?1", [inside])
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
            [inside],
        )
        .unwrap();
        drop(c);
        assert_eq!(run(&paths).unwrap(), vec![4]);
        let c = crate::db::open(&paths.db()).unwrap();
        let get = |sql: &str| -> String { c.query_row(sql, [], |r| r.get(0)).unwrap() };
        let key = "conversation-archive/codex-sessions/a.jsonl";
        assert_eq!(
            get("SELECT archive_path FROM files WHERE source_path = '/src/a.jsonl'"),
            key
        );
        assert_eq!(get("SELECT archive_path FROM exchanges"), key);
        assert_eq!(paths.archive_file(key).to_str().unwrap(), inside);
        assert_eq!(
            get("SELECT archive_path FROM files WHERE source_path = '/src/b.jsonl'"),
            "/elsewhere/b.jsonl"
        );
    }

    #[test]
    fn run_at_head_does_nothing() {
        let (_t, paths) = legacy(1);
        run(&paths).unwrap();
        assert_eq!(run(&paths).unwrap(), Vec::<i64>::new());
    }

    #[test]
    fn a_failed_revision_rolls_back_and_runs_again() {
        let (_t, paths) = legacy(3);
        // Revision 3 fails: the column it adds is already there.
        crate::db::open(&paths.db())
            .unwrap()
            .execute_batch("ALTER TABLE files ADD COLUMN reparse_offset_line INTEGER")
            .unwrap();
        assert!(run(&paths).is_err());
        assert_eq!(current(&paths).unwrap(), Some(2));
        crate::db::open(&paths.db())
            .unwrap()
            .execute_batch("ALTER TABLE files DROP COLUMN reparse_offset_line")
            .unwrap();
        assert_eq!(run(&paths).unwrap(), (3..=HEAD).collect::<Vec<_>>());
        assert_eq!(current(&paths).unwrap(), Some(HEAD));
    }

    #[test]
    fn a_newer_revision_is_refused() {
        let (_t, paths) = legacy(4);
        write_revision(&paths, HEAD + 1).unwrap();
        let err = run(&paths).unwrap_err().to_string();
        assert!(err.contains("newer than this binary"), "{err}");
    }

    #[test]
    fn waits_while_a_daemon_of_another_version_runs() {
        let (_t, paths) = legacy(1);
        let other = fs::File::create(paths.data.join("daemon-0.0.1.lock")).unwrap();
        other.lock_exclusive().unwrap();
        // Our own daemon's lock does not block.
        let _own = try_lock(&paths.daemon_lock()).unwrap().unwrap();
        let err = run(&paths).unwrap_err().to_string();
        assert!(err.contains("daemon-0.0.1.lock"), "{err}");
        assert_eq!(current(&paths).unwrap(), Some(0));
        other.unlock().unwrap();
        assert_eq!(run(&paths).unwrap(), (1..=HEAD).collect::<Vec<_>>());
    }
}
