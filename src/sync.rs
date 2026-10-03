#![allow(dead_code)] // not yet used by main; wired in later tasks

use crate::archive::{append_tail, archive_path_for, tails_match};
use crate::db::{delete_exchanges_from, get_file, upsert_file, FileRow};
use crate::paths::{Paths, SourceKind};
use anyhow::Result;
use rusqlite::{Connection, Transaction};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub struct DiscoveredFile {
    pub kind: SourceKind,
    pub source_path: PathBuf,
    /// Path relative to the source root.
    pub rel: PathBuf,
    pub size: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum FileOutcome {
    Unchanged,
    Synced { new_exchanges: usize },
    Skipped,
}

/// Spec §5 steps 6–9. Placeholder until Task 8: indexes nothing.
pub fn index_file(_tx: &Transaction, _row: &mut FileRow, _kind: SourceKind) -> Result<usize> {
    Ok(0)
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Smallest generation >= `from` whose archive file does not exist yet, so a new
/// generation never truncates or appends to a file left by an earlier database.
fn free_generation(paths: &Paths, kind: SourceKind, rel: &Path, from: i64) -> i64 {
    let mut generation = from.max(1);
    while archive_path_for(paths, kind, rel, generation).exists() {
        generation += 1;
    }
    generation
}

/// Import rule (spec §5 "기존 아카이브 들여오기", bullet 2) for a source with no `files` row.
/// Returns `(generation, offset)`: the gen-0 archive is adopted (offset = its size) when the
/// source is at least as large and their last 4096 bytes match; otherwise the old archive is
/// left as is and a fresh generation starts at offset 0. No gen-0 archive → `(0, 0)`.
pub fn adopt_existing_archive(
    paths: &Paths,
    kind: SourceKind,
    rel: &Path,
    source: &Path,
) -> io::Result<(i64, u64)> {
    let archive = archive_path_for(paths, kind, rel, 0);
    let archive_len = match fs::metadata(&archive) {
        Ok(m) => m.len(),
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok((0, 0)),
        Err(e) => return Err(e),
    };
    let source_len = fs::metadata(source)?.len();
    if source_len >= archive_len && tails_match(source, &archive, archive_len)? {
        Ok((0, archive_len))
    } else {
        Ok((free_generation(paths, kind, rel, 1), 0))
    }
}

/// Step 2: archive longer than `offset` (uncommitted append) is truncated back.
/// Returns true when the archive is shorter than `offset` or missing (needs a new generation).
fn reconcile_archive(row: &FileRow) -> Result<bool> {
    let path = Path::new(&row.archive_path);
    let offset = row.offset as u64;
    match fs::metadata(path) {
        Ok(m) if m.len() > offset => {
            let f = fs::OpenOptions::new().write(true).open(path)?;
            f.set_len(offset)?;
            f.sync_all()?;
            Ok(false)
        }
        Ok(m) => Ok(m.len() < offset),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(offset > 0),
        Err(e) => Err(e.into()),
    }
}

/// Step 3 new generation, committed on its own. The old archive file is never touched.
fn start_new_generation(
    conn: &mut Connection,
    paths: &Paths,
    f: &DiscoveredFile,
    row: &mut FileRow,
) -> Result<()> {
    let generation = free_generation(paths, f.kind, &f.rel, row.generation + 1);
    let tx = conn.transaction()?;
    delete_exchanges_from(&tx, &row.archive_path, 1)?;
    row.generation = generation;
    row.archive_path = path_str(&archive_path_for(paths, f.kind, &f.rel, generation));
    row.offset = 0;
    row.reparse_line = 1;
    upsert_file(&tx, row)?;
    tx.commit()?;
    Ok(())
}

fn register_new(conn: &mut Connection, paths: &Paths, f: &DiscoveredFile) -> Result<FileRow> {
    let (generation, offset) = adopt_existing_archive(paths, f.kind, &f.rel, &f.source_path)?;
    let row = FileRow {
        source_path: path_str(&f.source_path),
        source_kind: f.kind.as_str().into(),
        archive_path: path_str(&archive_path_for(paths, f.kind, &f.rel, generation)),
        generation,
        offset: offset as i64,
        reparse_line: 1,
        session_id: None,
        cwd: None,
        project: None,
        harness: None,
        is_sidechain: None,
        user_signal: None,
        skipped: false,
    };
    // Committed before any append so a crash cannot strand an unregistered archive file.
    let tx = conn.transaction()?;
    upsert_file(&tx, &row)?;
    tx.commit()?;
    Ok(row)
}

/// Spec §5 "파일 하나 처리": mirrors the source's new complete lines into the archive
/// (append-only, never overwriting), then indexes them in one transaction.
pub fn sync_file(conn: &mut Connection, paths: &Paths, f: &DiscoveredFile) -> Result<FileOutcome> {
    let source_key = path_str(&f.source_path);
    let mut row = match get_file(conn, &source_key)? {
        Some(row) if row.offset as u64 == f.size => return Ok(FileOutcome::Unchanged),
        Some(row) => row,
        None => register_new(conn, paths, f)?,
    };

    let source_len = fs::metadata(&f.source_path)?.len();
    let offset = row.offset as u64;
    let rewritten = reconcile_archive(&row)?
        || (offset > 0
            && (source_len < offset
                || !tails_match(&f.source_path, Path::new(&row.archive_path), offset)?));
    if rewritten {
        start_new_generation(conn, paths, f, &mut row)?;
        reconcile_archive(&row)?;
    }

    let new_offset = append_tail(
        &f.source_path,
        Path::new(&row.archive_path),
        row.offset as u64,
    )?;

    let tx = conn.transaction()?;
    row.offset = new_offset as i64;
    let new_exchanges = index_file(&tx, &mut row, f.kind)?;
    upsert_file(&tx, &row)?;
    tx.commit()?;

    Ok(if row.skipped {
        FileOutcome::Skipped
    } else {
        FileOutcome::Synced { new_exchanges }
    })
}

#[cfg(test)]
mod mirror {
    use super::*;
    use std::fs::OpenOptions;
    use std::io::Write;
    use std::os::unix::fs::MetadataExt;

    struct Env {
        _t: tempfile::TempDir,
        paths: Paths,
        conn: Connection,
        src: PathBuf,
        f: DiscoveredFile,
    }

    fn env() -> Env {
        let t = tempfile::tempdir().unwrap();
        let paths = Paths::new(t.path().join("data"));
        fs::create_dir_all(&paths.data).unwrap();
        let conn = crate::db::open(&paths.db()).unwrap();
        let root = t.path().join("src-root");
        let src = root.join("proj/s1.jsonl");
        fs::create_dir_all(src.parent().unwrap()).unwrap();
        let f = DiscoveredFile {
            kind: SourceKind::ClaudeCodeProjects,
            source_path: src.clone(),
            rel: PathBuf::from("proj/s1.jsonl"),
            size: 0,
        };
        Env {
            _t: t,
            paths,
            conn,
            src,
            f,
        }
    }

    impl Env {
        fn write(&mut self, body: &str) {
            fs::write(&self.src, body).unwrap();
        }
        fn append(&mut self, body: &str) {
            let mut h = OpenOptions::new().append(true).open(&self.src).unwrap();
            h.write_all(body.as_bytes()).unwrap();
        }
        fn sync(&mut self) -> FileOutcome {
            self.f.size = fs::metadata(&self.src).unwrap().len();
            sync_file(&mut self.conn, &self.paths, &self.f).unwrap()
        }
        fn row(&self) -> FileRow {
            get_file(&self.conn, self.src.to_str().unwrap())
                .unwrap()
                .unwrap()
        }
        fn gen_path(&self, generation: i64) -> PathBuf {
            archive_path_for(&self.paths, self.f.kind, &self.f.rel, generation)
        }
        fn archive(&self, generation: i64) -> String {
            fs::read_to_string(self.gen_path(generation)).unwrap()
        }
    }

    fn line(n: usize) -> String {
        format!("{{\"n\":{n}}}\n")
    }

    fn lines(range: std::ops::Range<usize>) -> String {
        range.map(line).collect()
    }

    #[test]
    fn appends_only_tail() {
        let mut e = env();
        e.write(&lines(0..2));
        assert_eq!(e.sync(), FileOutcome::Synced { new_exchanges: 0 });
        assert_eq!(e.archive(0), lines(0..2));
        let ino = fs::metadata(e.gen_path(0)).unwrap().ino();
        e.append(&line(2));
        e.sync();
        assert_eq!(e.archive(0), lines(0..3));
        assert_eq!(fs::metadata(e.gen_path(0)).unwrap().ino(), ino);
        let row = e.row();
        assert_eq!(row.offset as usize, lines(0..3).len());
        assert_eq!(row.generation, 0);
        assert_eq!(row.archive_path, e.gen_path(0).to_str().unwrap());
        assert_eq!(row.source_kind, "claude-code-projects");
    }

    #[test]
    fn holds_incomplete_last_line() {
        let mut e = env();
        e.write(&format!("{}{{\"n\":", lines(0..1)));
        e.sync();
        assert_eq!(e.archive(0), lines(0..1));
        assert_eq!(e.row().offset as usize, line(0).len());
        e.append("1}\n");
        e.sync();
        assert_eq!(e.archive(0), lines(0..2));
    }

    #[test]
    fn unchanged_size_skips() {
        let mut e = env();
        e.write(&lines(0..2));
        e.sync();
        // Junk past the committed offset would be truncated by a real sync;
        // an unchanged source must not touch the archive at all.
        let mut h = OpenOptions::new().append(true).open(e.gen_path(0)).unwrap();
        h.write_all(b"junk").unwrap();
        assert_eq!(e.sync(), FileOutcome::Unchanged);
        assert_eq!(e.archive(0), format!("{}junk", lines(0..2)));
    }

    #[test]
    fn truncates_crashed_append() {
        let mut e = env();
        e.write(&lines(0..2));
        e.sync();
        let mut h = OpenOptions::new().append(true).open(e.gen_path(0)).unwrap();
        h.write_all(line(2).as_bytes()).unwrap(); // appended but never committed
        h.write_all(b"{\"partial").unwrap();
        e.append(&line(2));
        e.sync();
        assert_eq!(e.archive(0), lines(0..3));
        assert_eq!(e.row().generation, 0);
    }

    #[test]
    fn shrunk_source_starts_new_generation() {
        let mut e = env();
        e.write(&lines(0..5));
        e.sync();
        e.write(&lines(100..102));
        e.sync();
        assert_eq!(e.archive(0), lines(0..5));
        assert_eq!(e.archive(1), lines(100..102));
        let row = e.row();
        assert_eq!(row.generation, 1);
        assert!(row.archive_path.ends_with("proj/s1.gen-1.jsonl"));
        assert_eq!(row.offset as usize, lines(100..102).len());
        assert_eq!(row.reparse_line, 1);
    }

    #[test]
    fn rewritten_tail_starts_new_generation() {
        let mut e = env();
        e.write(&lines(0..5));
        e.sync();
        e.write(&lines(10..20)); // larger, but different content
        e.sync();
        assert_eq!(e.archive(0), lines(0..5));
        assert_eq!(e.archive(1), lines(10..20));
        assert_eq!(e.row().generation, 1);
    }

    #[test]
    fn new_generation_deletes_old_exchanges_only() {
        let mut e = env();
        e.write(&lines(0..5));
        e.sync();
        let old = e.row().archive_path;
        let tx = e.conn.transaction().unwrap();
        for (path, start) in [(old.as_str(), 1), (old.as_str(), 3), ("other.jsonl", 1)] {
            let ex = crate::db::NewExchange {
                archive_path: path.into(),
                line_start: start,
                line_end: start,
                session_id: None,
                project: "p".into(),
                harness: "claude".into(),
                is_sidechain: false,
                ts: 0,
                user_message: "u".into(),
                assistant_message: "a".into(),
                tool_names: String::new(),
            };
            crate::db::insert_exchange(&tx, &ex, "t").unwrap();
        }
        tx.commit().unwrap();
        e.write(&lines(100..101));
        e.sync();
        let left: Vec<String> = e
            .conn
            .prepare("SELECT archive_path FROM exchanges")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(left, vec!["other.jsonl".to_string()]);
    }

    #[test]
    fn crash_after_generation_commit_recovers() {
        let mut e = env();
        e.write(&lines(0..5));
        e.sync();
        // Simulate: generation 1 committed, then a partial append before the crash.
        let mut row = e.row();
        row.generation = 1;
        row.archive_path = e.gen_path(1).to_str().unwrap().into();
        row.offset = 0;
        row.reparse_line = 1;
        let tx = e.conn.transaction().unwrap();
        upsert_file(&tx, &row).unwrap();
        tx.commit().unwrap();
        e.write(&lines(100..103));
        fs::write(e.gen_path(1), format!("{}{{\"part", line(100))).unwrap();
        e.sync();
        assert_eq!(e.archive(1), lines(100..103));
        assert_eq!(e.archive(0), lines(0..5));
        assert_eq!(e.row().generation, 1);
        assert_eq!(e.row().offset as usize, lines(100..103).len());
    }

    #[test]
    fn archive_deleted_externally_recovers() {
        let mut e = env();
        e.write(&lines(0..2));
        e.sync();
        fs::remove_file(e.gen_path(0)).unwrap();
        e.append(&line(2));
        e.sync();
        assert!(!e.gen_path(0).exists());
        assert_eq!(e.archive(1), lines(0..3));
        assert_eq!(e.row().generation, 1);
    }

    #[test]
    fn new_generation_never_reuses_existing_file() {
        let mut e = env();
        e.write(&lines(0..3));
        e.sync();
        // A gen-1 file left by an earlier database must not be overwritten.
        fs::write(e.gen_path(1), lines(50..52)).unwrap();
        e.write(&lines(100..101));
        e.sync();
        assert_eq!(e.archive(1), lines(50..52));
        assert_eq!(e.archive(2), lines(100..101));
        assert_eq!(e.row().generation, 2);
    }

    #[test]
    fn new_source_adopts_matching_archive() {
        let mut e = env();
        fs::create_dir_all(e.gen_path(0).parent().unwrap()).unwrap();
        fs::write(e.gen_path(0), lines(0..3)).unwrap();
        e.write(&lines(0..5));
        e.sync();
        assert_eq!(e.archive(0), lines(0..5));
        assert_eq!(e.row().generation, 0);
        assert!(!e.gen_path(1).exists());
    }

    #[test]
    fn new_source_with_mismatched_archive_starts_generation() {
        let mut e = env();
        fs::create_dir_all(e.gen_path(0).parent().unwrap()).unwrap();
        fs::write(e.gen_path(0), lines(0..3)).unwrap();
        e.write(&lines(10..20));
        e.sync();
        assert_eq!(e.archive(0), lines(0..3));
        assert_eq!(e.archive(1), lines(10..20));
        assert_eq!(e.row().generation, 1);
    }

    #[test]
    fn new_source_smaller_than_archive_starts_generation() {
        let mut e = env();
        fs::create_dir_all(e.gen_path(0).parent().unwrap()).unwrap();
        fs::write(e.gen_path(0), lines(0..3)).unwrap();
        e.write(&lines(0..1));
        e.sync();
        assert_eq!(e.archive(0), lines(0..3));
        assert_eq!(e.archive(1), lines(0..1));
    }

    #[test]
    fn skipped_file_is_still_mirrored() {
        let mut e = env();
        e.write(&lines(0..1));
        e.sync();
        let mut row = e.row();
        row.skipped = true;
        let tx = e.conn.transaction().unwrap();
        upsert_file(&tx, &row).unwrap();
        tx.commit().unwrap();
        e.append(&line(1));
        assert_eq!(e.sync(), FileOutcome::Skipped);
        assert_eq!(e.archive(0), lines(0..2));
    }

    #[test]
    fn vanished_source_is_an_error() {
        let mut e = env();
        e.write(&lines(0..1));
        e.sync();
        fs::remove_file(&e.src).unwrap();
        e.f.size = 999;
        assert!(sync_file(&mut e.conn, &e.paths, &e.f).is_err());
        assert_eq!(e.archive(0), lines(0..1));
    }
}
