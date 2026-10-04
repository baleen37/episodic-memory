use crate::archive::{append_tail, archive_path_for, generation_stem, tails_match};
use crate::db::{
    FileRow, NewExchange, delete_exchanges_from, get_file, insert_exchange, meta_get, meta_set,
    upsert_file,
};
use crate::log::log_line;
use crate::parse::{ReparsePoint, initial_meta, parse_from};
use crate::paths::{Paths, SourceKind, SourceRoot, candidate_roots_from_env, try_lock};
use crate::project::{ProjectCache, UNKNOWN_PROJECT};
use crate::terms::to_terms;
use anyhow::Result;
use rusqlite::{Connection, Transaction};
use std::collections::HashSet;
use std::fs;
use std::io;
use std::os::unix::fs::MetadataExt;
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

/// Bumped when parsing or project resolution changes what an indexed file should contain;
/// a database indexed under an older version is reindexed once (`reindex_all`).
const INDEX_VERSION: &str = "3";

/// Exchanges larger than this (either message, UTF-8 bytes) are not indexed (obra#139).
const MAX_MESSAGE_BYTES: usize = 262_144;

#[derive(Debug, Default, PartialEq, Eq)]
struct IndexStats {
    inserted: usize,
    oversize: usize,
    bad_lines: usize,
}

/// Spec §5 steps 6–9.
fn index_file(
    tx: &Transaction,
    paths: &Paths,
    row: &mut FileRow,
    projects: &mut ProjectCache,
) -> Result<IndexStats> {
    let kind = row.source_kind;
    let mut stats = IndexStats::default();
    if row.skipped {
        return Ok(stats);
    }
    let archive = paths.archive_file(&row.archive_path);

    // File meta is learned only from the archive bytes appended since it was last observed
    // (`meta_offset`), until the provider reports it settled, in the same pass that parses them.
    // The project follows the `cwd`: transcripts often open with lines lacking one (`mode`,
    // `last-prompt`, ...).
    let old_meta = row.meta.clone();
    if row.meta_offset == 0 {
        // Every line is observed again, so the pass must start at line 1.
        row.meta = initial_meta(kind, &row.archive_path);
        row.meta_settled = false;
        row.reparse = ReparsePoint::START;
    }
    // ADR 0001: a file meta change can make every exchange already indexed wrong (boundaries,
    // session, project or sidechain flag), so the pass restarts from line 1. File meta only
    // grows, so this ends; lines observed again change nothing.
    let mut observe_from = (!row.meta_settled).then_some(row.meta_offset);
    let out = loop {
        let out = parse_from(kind, &archive, row.reparse, &mut row.meta, observe_from)?;
        row.meta_settled |= out.meta_settled;
        if !out.restart {
            break out;
        }
        row.reparse = ReparsePoint::START;
        if row.meta_settled {
            observe_from = None;
        }
    };
    row.meta_offset = row.offset;
    if row.harness.is_none() || row.meta.cwd != old_meta.cwd {
        row.harness = Some(kind.harness().to_string());
        row.project = Some(projects.resolve(row.meta.cwd.as_deref()));
    }
    let project = row
        .project
        .clone()
        .unwrap_or_else(|| UNKNOWN_PROJECT.into());

    delete_exchanges_from(tx, &row.archive_path, row.reparse.line)?;
    stats.bad_lines = out.bad_lines;
    if out.do_not_index {
        row.skipped = true;
        delete_exchanges_from(tx, &row.archive_path, 1)?;
        return Ok(stats);
    }

    if let Some(last) = out.exchanges.last() {
        row.reparse = ReparsePoint {
            line: last.line_start,
            byte: Some(last.byte_start),
        };
    }
    for e in out.exchanges {
        if e.user_message.len() > MAX_MESSAGE_BYTES || e.assistant_message.len() > MAX_MESSAGE_BYTES
        {
            stats.oversize += 1;
            continue;
        }
        // Same as terms of "user\nassistant": a newline always ends a term.
        let terms = format!(
            "{}\n{}",
            to_terms(&e.user_message),
            to_terms(&e.assistant_message)
        );
        let new = NewExchange {
            archive_path: row.archive_path.clone(),
            line_start: e.line_start,
            line_end: e.line_end,
            session_id: row.meta.session_id.clone(),
            project: project.clone(),
            harness: kind.harness().to_string(),
            is_sidechain: row.meta.is_sidechain,
            ts: e.ts,
            user_message: e.user_message,
            assistant_message: e.assistant_message,
            tool_names: e.tool_names.join(","),
        };
        insert_exchange(tx, &new, &terms)?;
        stats.inserted += 1;
    }
    Ok(stats)
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

/// Size of the archive file at `path`; `None` when absent. A non-regular entry (e.g. a directory,
/// whose reported size is platform dependent) is an error, never an archive.
fn archive_len(path: &Path) -> io::Result<Option<u64>> {
    match fs::metadata(path) {
        Ok(m) if m.is_file() => Ok(Some(m.len())),
        Ok(_) => Err(io::Error::other(format!(
            "archive path is not a regular file: {}",
            path.display()
        ))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
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
    let Some(archive_len) = archive_len(&archive)? else {
        return Ok((0, 0));
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
fn reconcile_archive(paths: &Paths, row: &FileRow) -> Result<bool> {
    let path = paths.archive_file(&row.archive_path);
    let offset = row.offset as u64;
    match archive_len(&path)? {
        Some(len) if len > offset => {
            let f = fs::OpenOptions::new().write(true).open(&path)?;
            f.set_len(offset)?;
            f.sync_all()?;
            Ok(false)
        }
        Some(len) => Ok(len < offset),
        None => Ok(offset > 0),
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
    row.archive_path = paths.archive_key(&archive_path_for(paths, f.kind, &f.rel, generation));
    row.offset = 0;
    row.reset_index();
    upsert_file(&tx, row)?;
    tx.commit()?;
    Ok(())
}

fn register_new(conn: &mut Connection, paths: &Paths, f: &DiscoveredFile) -> Result<FileRow> {
    let (generation, offset) = adopt_existing_archive(paths, f.kind, &f.rel, &f.source_path)?;
    let row = FileRow::new(
        path_str(&f.source_path),
        f.kind,
        paths.archive_key(&archive_path_for(paths, f.kind, &f.rel, generation)),
        generation,
        offset as i64,
    );
    // Committed before any append so a crash cannot strand an unregistered archive file.
    let tx = conn.transaction()?;
    upsert_file(&tx, &row)?;
    tx.commit()?;
    Ok(row)
}

/// Spec §5 "파일 하나 처리": mirrors the source's new complete lines into the archive
/// (append-only, never overwriting), then indexes them in one transaction.
pub fn sync_file(
    conn: &mut Connection,
    paths: &Paths,
    f: &DiscoveredFile,
    projects: &mut ProjectCache,
) -> Result<FileOutcome> {
    let source_key = path_str(&f.source_path);
    let mut row = match get_file(conn, &source_key)? {
        Some(row) if row.offset as u64 == f.size => return Ok(FileOutcome::Unchanged),
        Some(row) => row,
        None => register_new(conn, paths, f)?,
    };

    let source_len = fs::metadata(&f.source_path)?.len();
    let offset = row.offset as u64;
    let rewritten = reconcile_archive(paths, &row)?
        || (offset > 0
            && (source_len < offset
                || !tails_match(
                    &f.source_path,
                    &paths.archive_file(&row.archive_path),
                    offset,
                )?));
    if rewritten {
        start_new_generation(conn, paths, f, &mut row)?;
        reconcile_archive(paths, &row)?;
    }

    let old_offset = row.offset;
    let new_offset = append_tail(
        &f.source_path,
        &paths.archive_file(&row.archive_path),
        row.offset as u64,
    )?;

    let tx = conn.transaction()?;
    row.offset = new_offset as i64;
    // Nothing new to parse unless the append moved the offset or the first parse is pending.
    // An archive with no complete line yet does not exist, so there is nothing to parse.
    let stats = if row.offset != old_offset || (row.harness.is_none() && row.offset > 0) {
        index_file(&tx, paths, &mut row, projects)?
    } else {
        IndexStats::default()
    };
    upsert_file(&tx, &row)?;
    tx.commit()?;
    if stats.bad_lines > 0 || stats.oversize > 0 {
        log_line(
            paths,
            &format!(
                "index {}: {} unparsable line(s), {} oversize exchange(s) skipped",
                paths.archive_file(&row.archive_path).display(),
                stats.bad_lines,
                stats.oversize
            ),
        );
    }
    let new_exchanges = stats.inserted;

    Ok(if row.skipped {
        FileOutcome::Skipped
    } else {
        FileOutcome::Synced { new_exchanges }
    })
}

// ---- Task 9: discovery, archive import, sync orchestration ----

/// Recursively collects `*.jsonl` (not `*.gen-<N>.jsonl`) under `root`, following symlinks.
/// Broken links and unreadable entries are skipped, and each directory is entered once (by
/// device and inode) so a link to an ancestor cannot loop. Returns `(path relative to root, size)`.
// Hosts write lowercase `.jsonl`; matching stays exact.
#[allow(clippy::case_sensitive_file_extension_comparisons)]
fn walk_jsonl(root: &Path) -> Vec<(PathBuf, u64)> {
    let mut out = Vec::new();
    let Ok(meta) = fs::metadata(root) else {
        return out;
    };
    // Directories are marked when pushed, from the metadata already read for their entry.
    let mut visited = HashSet::from([(meta.dev(), meta.ino())]);
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            if meta.is_dir() {
                if visited.insert((meta.dev(), meta.ino())) {
                    stack.push(path);
                }
            } else if meta.is_file() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.ends_with(".jsonl")
                    && generation_stem(&name).is_none()
                    && let Ok(rel) = path.strip_prefix(root)
                {
                    out.push((rel.to_path_buf(), meta.len()));
                }
            }
        }
    }
    out.sort();
    out
}

pub fn discover_in(roots: &[SourceRoot]) -> Vec<DiscoveredFile> {
    let mut out = Vec::new();
    for r in roots {
        for (rel, size) in walk_jsonl(&r.root) {
            out.push(DiscoveredFile {
                kind: r.kind,
                source_path: r.root.join(&rel),
                rel,
                size,
            });
        }
    }
    out
}

/// Spec §5 "기존 아카이브 들여오기". `candidates` supplies the (possibly missing) source root
/// per kind. Returns the number of files registered and of exchanges they indexed; sets
/// `meta.imported` only when no file failed.
pub fn import_archive_with_roots(
    conn: &mut Connection,
    paths: &Paths,
    candidates: &[SourceRoot],
    projects: &mut ProjectCache,
) -> Result<(usize, usize)> {
    let (mut registered, mut inserted) = (0, 0);
    let mut failures = 0;
    for kind in SourceKind::ALL {
        let Some(root) = candidates.iter().find(|r| r.kind == kind) else {
            continue;
        };
        let archive_dir = paths.archive_root().join(kind.as_str());
        for (rel, _) in walk_jsonl(&archive_dir) {
            match import_one(conn, paths, kind, &root.root, &rel, projects) {
                Ok(Some(n)) => {
                    registered += 1;
                    inserted += n;
                }
                Ok(None) => {}
                Err(e) => {
                    failures += 1;
                    log_line(
                        paths,
                        &format!("import {}/{}: {e:#}", kind.as_str(), rel.display()),
                    );
                }
            }
        }
    }
    if failures == 0 {
        meta_set(conn, "imported", "1")?;
        meta_set(conn, "index_version", INDEX_VERSION)?;
    }
    Ok((registered, inserted))
}

/// Rebuilds every indexed file's exchanges and session info (project included) from its
/// archive. A file that fails is logged and left as it was. Returns the exchanges indexed.
fn reindex_all(conn: &mut Connection, paths: &Paths, projects: &mut ProjectCache) -> Result<usize> {
    let mut inserted = 0;
    let sources: Vec<String> = conn
        .prepare(r#"SELECT source_path FROM files WHERE "offset" > 0 AND skipped = 0"#)?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for source in sources {
        let result = (|| -> Result<usize> {
            let Some(mut row) = get_file(conn, &source)? else {
                return Ok(0);
            };
            row.reset_index();
            let tx = conn.transaction()?;
            let stats = index_file(&tx, paths, &mut row, projects)?;
            upsert_file(&tx, &row)?;
            tx.commit()?;
            Ok(stats.inserted)
        })();
        match result {
            Ok(n) => inserted += n,
            Err(e) => log_line(paths, &format!("reindex {source}: {e:#}")),
        }
    }
    meta_set(conn, "index_version", INDEX_VERSION)?;
    Ok(inserted)
}

/// Registers one archive file and returns the exchanges it indexed; None if it already has a
/// `files` row.
fn import_one(
    conn: &mut Connection,
    paths: &Paths,
    kind: SourceKind,
    root: &Path,
    rel: &Path,
    projects: &mut ProjectCache,
) -> Result<Option<usize>> {
    let archive0 = archive_path_for(paths, kind, rel, 0);
    let source = root.join(rel);
    let source_key = path_str(&source);
    let known: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM files WHERE archive_path = ?1 OR source_path = ?2)",
        [&paths.archive_key(&archive0), &source_key],
        |r| r.get(0),
    )?;
    if known {
        return Ok(None);
    }
    let (generation, offset) = if source.exists() {
        adopt_existing_archive(paths, kind, rel, &source)?
    } else {
        (0, fs::metadata(&archive0)?.len())
    };
    let mut row = FileRow::new(
        source_key,
        kind,
        paths.archive_key(&archive_path_for(paths, kind, rel, generation)),
        generation,
        offset as i64,
    );
    let tx = conn.transaction()?;
    upsert_file(&tx, &row)?;
    let mut inserted = 0;
    if row.offset > 0 {
        inserted = index_file(&tx, paths, &mut row, projects)?.inserted;
        upsert_file(&tx, &row)?;
    }
    tx.commit()?;
    Ok(Some(inserted))
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct SyncStats {
    pub skipped: bool,
    /// Data dir revisions applied before indexing.
    pub migrated: usize,
    pub files_synced: usize,
    pub new_exchanges: usize,
    pub errors: usize,
}

impl SyncStats {
    pub fn skipped() -> SyncStats {
        SyncStats {
            skipped: true,
            ..SyncStats::default()
        }
    }
}

pub fn run_sync(paths: &Paths) -> Result<SyncStats> {
    run_sync_with_roots(paths, &candidate_roots_from_env())
}

/// Indexes new transcript bytes under the sync lock. Embedding is not part of sync: the
/// daemon's embedding worker picks up `embedded = 0` exchanges afterwards.
/// `roots` are the candidate roots per kind; missing ones are ignored for discovery.
pub fn run_sync_with_roots(paths: &Paths, roots: &[SourceRoot]) -> Result<SyncStats> {
    let Some(lock) = try_lock(&paths.sync_lock())? else {
        return Ok(SyncStats::skipped());
    };
    let mut stats = SyncStats::default();
    for id in crate::migrations::run(paths)? {
        log_line(paths, &format!("migrated to revision {id}"));
        stats.migrated += 1;
    }
    let mut conn = crate::db::open(&paths.db())?;
    let mut projects = ProjectCache::default();
    if meta_get(&conn, "imported").is_none() {
        stats.new_exchanges += import_archive_with_roots(&mut conn, paths, roots, &mut projects)?.1;
    }
    if meta_get(&conn, "index_version").as_deref() != Some(INDEX_VERSION) {
        stats.new_exchanges += reindex_all(&mut conn, paths, &mut projects)?;
    }

    let mut last_error = String::new();
    for f in discover_in(roots) {
        match sync_file(&mut conn, paths, &f, &mut projects) {
            Ok(FileOutcome::Synced { new_exchanges }) => {
                stats.files_synced += 1;
                stats.new_exchanges += new_exchanges;
            }
            Ok(FileOutcome::Unchanged | FileOutcome::Skipped) => {}
            Err(e) => {
                stats.errors += 1;
                last_error = format!("{}: {e:#}", f.source_path.display());
                log_line(paths, &format!("sync {last_error}"));
            }
        }
    }
    meta_set(&conn, "last_sync", &chrono::Utc::now().to_rfc3339())?;
    let count: i64 = meta_get(&conn, "sync_count")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    meta_set(&conn, "sync_count", &(count + 1).to_string())?;
    meta_set(&conn, "last_error", &last_error)?;
    drop(lock);
    Ok(stats)
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
        env_for(SourceKind::ClaudeCodeProjects, "proj/s1.jsonl")
    }

    fn env_for(kind: SourceKind, rel: &str) -> Env {
        let t = tempfile::tempdir().unwrap();
        let paths = Paths::new(t.path().join("data"));
        fs::create_dir_all(&paths.data).unwrap();
        let conn = crate::db::open(&paths.db()).unwrap();
        let root = t.path().join("src-root");
        let src = root.join(rel);
        fs::create_dir_all(src.parent().unwrap()).unwrap();
        let f = DiscoveredFile {
            kind,
            source_path: src.clone(),
            rel: PathBuf::from(rel),
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
            sync_file(
                &mut self.conn,
                &self.paths,
                &self.f,
                &mut ProjectCache::default(),
            )
            .unwrap()
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
        assert_eq!(
            row.archive_path,
            "conversation-archive/claude-code-projects/proj/s1.jsonl"
        );
        assert_eq!(row.source_kind, SourceKind::ClaudeCodeProjects);
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
        assert_eq!(row.reparse, ReparsePoint::START);
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
        row.archive_path = e.paths.archive_key(&e.gen_path(1));
        row.offset = 0;
        row.reparse = ReparsePoint::START;
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
        assert!(sync_file(&mut e.conn, &e.paths, &e.f, &mut ProjectCache::default()).is_err());
        assert_eq!(e.archive(0), lines(0..1));
    }

    // ---- Task 8: indexing ----

    /// A Claude Code user line with the given file meta fields (`sessionId`, `cwd`, ...).
    fn user_with(text: &str, meta: serde_json::Value) -> String {
        let mut v = serde_json::json!({"type":"user","timestamp":"2026-01-02T03:04:05Z",
            "message":{"role":"user","content":text}});
        if let (Some(v), serde_json::Value::Object(meta)) = (v.as_object_mut(), meta) {
            v.extend(meta);
        }
        format!("{v}\n")
    }

    fn user(text: &str) -> String {
        user_with(
            text,
            serde_json::json!({"sessionId":"s1","cwd":"/nonexistent/demo","isSidechain":false}),
        )
    }

    fn assistant(text: &str) -> String {
        format!(
            "{}\n",
            serde_json::json!({"type":"assistant","message":{"role":"assistant",
                "content":[{"type":"text","text":text}]}})
        )
    }

    pub(super) fn exchange_lines(q: &str, a: &str) -> String {
        user(q) + &assistant(a)
    }

    impl Env {
        fn exchanges(&self) -> Vec<(i64, i64, String)> {
            self.conn
                .prepare("SELECT id, line_start, user_message FROM exchanges ORDER BY line_start")
                .unwrap()
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .map(|r| r.unwrap())
                .collect()
        }
        fn fts_hits(&self, term: &str) -> i64 {
            self.conn
                .query_row(
                    "SELECT count(*) FROM fts_exchanges WHERE fts_exchanges MATCH ?",
                    [term],
                    |r| r.get(0),
                )
                .unwrap()
        }
    }

    // ---- Incremental file meta ----

    type Indexed = (
        i64,
        i64,
        Option<String>,
        String,
        String,
        bool,
        i64,
        String,
        String,
        String,
    );

    impl Env {
        /// Every exchange column a search or `read` can observe, in archive order.
        fn indexed(&self) -> Vec<Indexed> {
            self.conn
                .prepare(
                    "SELECT line_start, line_end, session_id, project, harness, is_sidechain, ts,
                            user_message, assistant_message, tool_names
                     FROM exchanges ORDER BY line_start",
                )
                .unwrap()
                .query_map([], |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                        r.get(9)?,
                    ))
                })
                .unwrap()
                .map(|r| r.unwrap())
                .collect()
        }
    }

    fn fixture(provider: &str, name: &str) -> String {
        fs::read_to_string(crate::parse::tests::fixture(provider, name)).unwrap()
    }

    /// Syncs `body` once, and again in appends of `chunk` bytes with a sync after each, then
    /// requires both to index the same exchanges and file meta.
    fn assert_incremental_matches_one_shot(kind: SourceKind, rel: &str, body: &str, chunk: usize) {
        let mut once = env_for(kind, rel);
        once.write(body);
        once.sync();
        let mut steps = env_for(kind, rel);
        steps.write("");
        for piece in body.as_bytes().chunks(chunk) {
            steps.append(std::str::from_utf8(piece).unwrap());
            steps.sync();
        }
        assert!(!once.indexed().is_empty(), "{rel}: fixture indexes nothing");
        assert_eq!(
            steps.indexed(),
            once.indexed(),
            "{rel} in {chunk}-byte appends"
        );
        let (a, b) = (steps.row(), once.row());
        assert_eq!(a.meta, b.meta, "{rel} in {chunk}-byte appends");
        assert_eq!(a.project, b.project);
    }

    #[test]
    fn incremental_sync_matches_one_shot_for_every_fixture() {
        let cases = [
            (
                SourceKind::ClaudeCodeProjects,
                "claude",
                "main",
                "p/main.jsonl",
            ),
            (
                SourceKind::ClaudeCodeProjects,
                "claude",
                "noise",
                "p/noise.jsonl",
            ),
            (
                SourceKind::ClaudeCodeProjects,
                "claude",
                "subagent",
                "p/s/subagents/agent-1.jsonl",
            ),
            (
                SourceKind::CodexSessions,
                "codex",
                "modern",
                "2026/01/02/modern.jsonl",
            ),
            (
                SourceKind::CodexSessions,
                "codex",
                "legacy",
                "2026/01/02/legacy.jsonl",
            ),
            (
                SourceKind::CodexSessions,
                "codex",
                "subagent",
                "2026/01/02/sub.jsonl",
            ),
            (
                SourceKind::CodexSessions,
                "codex",
                "fork",
                "2026/01/02/fork.jsonl",
            ),
        ];
        for (kind, provider, name, rel) in cases {
            let body = fixture(provider, name);
            let line_len = body.lines().map(str::len).max().unwrap() + 1;
            for chunk in [37, line_len, body.len()] {
                assert_incremental_matches_one_shot(kind, rel, &body, chunk);
            }
        }
    }

    fn codex_line(v: &serde_json::Value) -> String {
        format!("{v}\n")
    }

    fn codex_exchange(q: &str, a: &str) -> String {
        codex_line(
            &serde_json::json!({"timestamp":"2026-01-02T03:04:05Z","type":"event_msg",
            "payload":{"type":"user_message","message":q}}),
        ) + &codex_line(&serde_json::json!({"timestamp":"2026-01-02T03:04:05Z",
                "type":"response_item","payload":{"type":"message","role":"assistant",
                "content":[{"type":"output_text","text":a}]}}))
    }

    #[test]
    fn codex_archive_whose_user_signal_flips_matches_one_shot() {
        // Two exchanges known only from `user_message` events, then a client that also records
        // `item_completed`: from then on the archive's user signal is `item_completed`.
        let item_completed = |q: &str| {
            codex_line(&serde_json::json!({"timestamp":"2026-01-02T03:04:05Z",
                "type":"event_msg","payload":{"type":"item_completed",
                "item":{"type":"UserMessage","content":[{"type":"text","text":q}]}}}))
        };
        let body = codex_line(&serde_json::json!({"type":"session_meta",
            "payload":{"id":"x","cwd":"/nonexistent/demo"}}))
            + &codex_exchange("old one", "first answer")
            + &codex_exchange("old two", "second answer")
            + &item_completed("new three")
            + &codex_exchange("new three", "third answer")
            + &codex_exchange("old four", "fourth answer");
        let line_len = body.lines().map(str::len).max().unwrap() + 1;
        for chunk in [37, line_len] {
            assert_incremental_matches_one_shot(
                SourceKind::CodexSessions,
                "2026/01/02/flip.jsonl",
                &body,
                chunk,
            );
        }
    }

    #[test]
    fn appended_codex_lines_are_observed_without_rereading_the_head() {
        let mut e = env_for(SourceKind::CodexSessions, "2026/01/02/r.jsonl");
        // The head holds a line that only differs from an `item_completed` user message in one
        // byte, followed by more than the 4096 tail bytes compared against the source.
        let decoy = codex_line(&serde_json::json!({"type":"event_msg","payload":{
            "type":"xtem_completed","item":{"type":"UserMessage",
            "content":[{"type":"text","text":"decoy"}]}}}));
        let head = codex_line(&serde_json::json!({"type":"session_meta",
            "payload":{"id":"x","cwd":"/nonexistent/demo"}}))
            + &decoy;
        let mut body = head.clone();
        for i in 0..60 {
            body += &codex_exchange(&format!("q{i}"), "padding answer padding answer");
        }
        e.write(&body);
        e.sync();
        assert_eq!(
            e.row().meta.user_signal,
            Some(crate::parse::UserSignal::UserMessage)
        );
        // Turn the decoy into an `item_completed` event in the archive only. A sync that reread
        // the head would switch the user signal and stop indexing `user_message` exchanges.
        let archive = e.gen_path(0);
        let text = fs::read_to_string(&archive).unwrap();
        fs::write(
            &archive,
            text.replacen("xtem_completed", "item_completed", 1),
        )
        .unwrap();
        e.append(&codex_exchange("fresh question", "fresh answer"));
        e.sync();
        assert_eq!(
            e.row().meta.user_signal,
            Some(crate::parse::UserSignal::UserMessage)
        );
        let users: Vec<String> = e.exchanges().into_iter().map(|x| x.2).collect();
        assert_eq!(users.len(), 61);
        assert_eq!(users.last().unwrap(), "fresh question");
    }

    /// One exchange per provider: a user message, then an answer (two archive lines).
    fn provider_exchange(kind: SourceKind, q: &str, a: &str) -> String {
        match kind {
            SourceKind::CodexSessions => codex_exchange(q, a),
            _ => exchange_lines(q, a),
        }
    }

    const PROVIDERS: [(SourceKind, &str); 2] = [
        (SourceKind::ClaudeCodeProjects, "p/r.jsonl"),
        (SourceKind::CodexSessions, "2026/01/02/r.jsonl"),
    ];

    #[test]
    fn sync_resumes_at_the_reparse_point_without_rereading_the_head() {
        for (kind, rel) in PROVIDERS {
            let mut e = env_for(kind, rel);
            // The long answer keeps the head out of the 4096 tail bytes compared with the source.
            e.write(
                &(provider_exchange(kind, "q1 x", "a1")
                    + &provider_exchange(kind, "q2", &"long answer ".repeat(500))
                    + &provider_exchange(kind, "q3", "a3")),
            );
            e.sync();
            // Split archive line 1 in two, keeping its byte length. A sync that counted lines
            // from byte 0 to reach the reparse point would see every later line shifted by one.
            let archive = e.gen_path(0);
            let text = fs::read_to_string(&archive).unwrap();
            fs::write(&archive, text.replacen("q1 x", "q1\nx", 1)).unwrap();
            e.append(&provider_exchange(kind, "q4", "a4"));
            e.sync();
            assert_eq!(e.row().generation, 0);
            let got: Vec<(i64, String)> = e.exchanges().into_iter().map(|x| (x.1, x.2)).collect();
            assert_eq!(
                got[2..],
                [(5, "q3".to_string()), (7, "q4".to_string())],
                "{kind:?}"
            );
        }
    }

    /// Indexed exchanges of a fresh sync of `body`, for comparison with an incremental one.
    fn one_shot(kind: SourceKind, rel: &str, body: &str) -> Vec<Indexed> {
        let mut once = env_for(kind, rel);
        once.write(body);
        once.sync();
        once.indexed()
    }

    #[test]
    fn new_generation_indexes_like_a_fresh_sync() {
        for (kind, rel) in PROVIDERS {
            let mut e = env_for(kind, rel);
            e.write(&(provider_exchange(kind, "q1", "a1") + &provider_exchange(kind, "q2", "a2")));
            e.sync();
            // Rewritten source: shorter, so it starts generation 1 from line 1.
            let body = provider_exchange(kind, "fresh", "answer");
            e.write(&body);
            e.sync();
            e.append(&provider_exchange(kind, "next", "answer"));
            e.sync();
            assert_eq!(e.row().generation, 1);
            let body = body + &provider_exchange(kind, "next", "answer");
            assert_eq!(e.indexed(), one_shot(kind, rel, &body), "{kind:?}");
        }
    }

    #[test]
    fn crash_repair_truncation_indexes_like_a_fresh_sync() {
        for (kind, rel) in PROVIDERS {
            let mut e = env_for(kind, rel);
            let mut body =
                provider_exchange(kind, "q1", "a1") + &provider_exchange(kind, "q2", "a2");
            e.write(&body);
            e.sync();
            // An append that reached the archive but was never committed.
            let mut h = OpenOptions::new().append(true).open(e.gen_path(0)).unwrap();
            h.write_all(provider_exchange(kind, "lost lost", "gone").as_bytes())
                .unwrap();
            h.write_all(b"{\"partial").unwrap();
            let more = provider_exchange(kind, "q3", "a3");
            e.append(&more);
            body += &more;
            e.sync();
            assert_eq!(e.archive(0), body);
            assert_eq!(e.indexed(), one_shot(kind, rel, &body), "{kind:?}");
        }
    }

    #[test]
    fn reparse_point_without_a_byte_position_is_located_by_line() {
        // Rows from schema version 2 store only the reparse line.
        for (kind, rel) in PROVIDERS {
            let mut e = env_for(kind, rel);
            let mut body =
                provider_exchange(kind, "q1", "a1") + &provider_exchange(kind, "q2", "a2");
            e.write(&body);
            e.sync();
            let mut row = e.row();
            assert!(row.reparse.line > 1);
            row.reparse.byte = None;
            let tx = e.conn.transaction().unwrap();
            upsert_file(&tx, &row).unwrap();
            tx.commit().unwrap();
            let more = provider_exchange(kind, "q3", "a3");
            e.append(&more);
            body += &more;
            e.sync();
            assert_eq!(e.indexed(), one_shot(kind, rel, &body), "{kind:?}");
            assert!(e.row().reparse.byte.is_some());
        }
    }

    #[test]
    fn reparse_line_moved_by_an_older_binary_is_located_by_line() {
        // Binaries before the byte position existed update `reparse_line` only, leaving the
        // stored byte position pointing at an earlier line.
        for (kind, rel) in PROVIDERS {
            let mut e = env_for(kind, rel);
            let mut body = (1..=3)
                .map(|i| provider_exchange(kind, &format!("q{i}"), "a"))
                .collect::<String>();
            e.write(&body);
            e.sync();
            let row = e.row();
            assert_eq!(row.reparse.line, 5);
            e.conn
                .execute(
                    "UPDATE files SET reparse_line = 7 WHERE source_path = ?",
                    [&row.source_path],
                )
                .unwrap();
            let more = provider_exchange(kind, "q4", "a");
            e.append(&more);
            body += &more;
            e.sync();
            assert_eq!(e.indexed(), one_shot(kind, rel, &body), "{kind:?}");
        }
    }

    impl Env {
        /// `vec_exchanges` metadata in archive order, after embedding every pending exchange.
        fn vec_meta(&mut self) -> Vec<(i64, String, i64, bool)> {
            crate::embed::embed_pending(&mut self.conn, &crate::embed::FakeEmbedder).unwrap();
            self.conn
                .prepare(
                    "SELECT x.line_start, v.project, v.ts, v.is_sidechain FROM vec_exchanges v
                     JOIN exchanges x ON x.id = v.rowid ORDER BY x.line_start",
                )
                .unwrap()
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        }
    }

    #[test]
    fn file_meta_learned_late_reaches_exchanges_indexed_earlier() {
        // The first lines carry no sessionId, cwd or isSidechain; a later line does.
        let bare = |q: &str| user_with(q, serde_json::json!({})) + &assistant("a");
        let late = user_with(
            "q3",
            serde_json::json!({"sessionId":"s1","cwd":"/nonexistent/demo","isSidechain":true}),
        ) + &assistant("a");
        let first =
            "{\"type\":\"mode\",\"mode\":\"default\"}\n".to_string() + &bare("q1") + &bare("q2");
        let (kind, rel) = (SourceKind::ClaudeCodeProjects, "p/r.jsonl");
        let mut e = env_for(kind, rel);
        e.write(&first);
        e.sync();
        e.vec_meta();
        e.append(&late);
        e.sync();
        let mut once = env_for(kind, rel);
        once.write(&(first + &late));
        once.sync();
        assert_eq!(e.indexed(), once.indexed());
        let want = once.vec_meta();
        assert_eq!(want.len(), 3);
        assert!(want.iter().all(|v| v.1 == "demo" && v.3), "{want:?}");
        assert_eq!(e.vec_meta(), want);
    }

    #[test]
    fn indexes_fresh_file_and_fills_session_info() {
        let mut e = env();
        e.write(
            &(exchange_lines("alpha question", "alpha answer")
                + &exchange_lines("beta q", "beta a")),
        );
        assert_eq!(e.sync(), FileOutcome::Synced { new_exchanges: 2 });
        let row = e.row();
        assert_eq!(row.meta.session_id.as_deref(), Some("s1"));
        assert_eq!(row.meta.cwd.as_deref(), Some("/nonexistent/demo"));
        assert_eq!(row.project.as_deref(), Some("demo"));
        assert_eq!(row.harness.as_deref(), Some("claude"));
        assert!(row.meta.sidechain_known && !row.meta.is_sidechain);
        assert_eq!(row.reparse.line, 3);
        assert_eq!(e.exchanges().len(), 2);
    }

    #[test]
    fn open_turn_is_indexed_once_answered() {
        let mut e = env();
        e.write(&(exchange_lines("q1", "a1") + &user("still thinking")));
        assert_eq!(e.sync(), FileOutcome::Synced { new_exchanges: 1 });
        e.append(&assistant("now answered"));
        e.sync();
        let users: Vec<String> = e.exchanges().into_iter().map(|x| x.2).collect();
        assert_eq!(users, ["q1", "still thinking"]);
    }

    #[test]
    fn session_info_reread_until_cwd_known() {
        let mut e = env();
        e.write("{\"type\":\"mode\",\"mode\":\"default\",\"sessionId\":\"s1\"}\n");
        e.sync();
        let row = e.row();
        assert!(row.meta.cwd.is_none());
        assert_eq!(row.project.as_deref(), Some(UNKNOWN_PROJECT));
        e.append(&exchange_lines("q1", "a1"));
        assert_eq!(e.sync(), FileOutcome::Synced { new_exchanges: 1 });
        let row = e.row();
        assert_eq!(row.meta.cwd.as_deref(), Some("/nonexistent/demo"));
        assert_eq!(row.project.as_deref(), Some("demo"));
        let project: String = e
            .conn
            .query_row("SELECT project FROM exchanges", [], |r| r.get(0))
            .unwrap();
        assert_eq!(project, "demo");
    }

    #[test]
    fn reindexes_only_last_exchange() {
        let mut e = env();
        e.write(
            &(exchange_lines("q1", "a1")
                + &exchange_lines("q2", "a2")
                + &exchange_lines("q3", "a3")),
        );
        e.sync();
        let before = e.exchanges();
        assert_eq!(before.len(), 3);
        e.append(&exchange_lines("q4", "a4"));
        assert_eq!(e.sync(), FileOutcome::Synced { new_exchanges: 2 });
        let after = e.exchanges();
        assert_eq!(after.len(), 4);
        assert_eq!(after[0], before[0]);
        assert_eq!(after[1], before[1]);
        assert_ne!(after[2].0, before[2].0);
        assert_eq!(after[2].2, "q3");
        assert_eq!(after[3].2, "q4");
    }

    #[test]
    fn do_not_index_skips_and_purges() {
        let mut e = env();
        e.write(&(exchange_lines("q1", "a1") + &exchange_lines("q2", "a2")));
        e.sync();
        assert_eq!(e.exchanges().len(), 2);
        e.append(&exchange_lines(crate::parse::DO_NOT_INDEX, "ok"));
        assert_eq!(e.sync(), FileOutcome::Skipped);
        assert_eq!(e.exchanges().len(), 0);
        assert_eq!(e.fts_hits("q1"), 0);
        assert!(e.row().skipped);
        e.append(&exchange_lines("q5", "a5"));
        assert_eq!(e.sync(), FileOutcome::Skipped);
        assert_eq!(e.exchanges().len(), 0);
        assert!(e.archive(0).contains("q5"));
    }

    #[test]
    fn oversize_exchange_skipped() {
        let mut e = env();
        let big = "x".repeat(300 * 1024);
        e.write(
            &(exchange_lines("small one", "a1")
                + &exchange_lines(&big, "a2")
                + &exchange_lines("small two", "a3")),
        );
        assert_eq!(e.sync(), FileOutcome::Synced { new_exchanges: 2 });
        let users: Vec<String> = e.exchanges().into_iter().map(|x| x.2).collect();
        assert_eq!(users, vec!["small one", "small two"]);
        let log = fs::read_to_string(e.paths.logs().join("episodic-memory.log")).unwrap();
        assert!(log.contains("1 oversize"));
    }

    #[test]
    fn fts_row_per_exchange() {
        let mut e = env();
        e.write(
            &(exchange_lines("alpha", "one")
                + &exchange_lines("bravo", "two")
                + &exchange_lines("charlie", "three")),
        );
        e.sync();
        for w in ["alpha", "bravo", "charlie"] {
            assert_eq!(e.fts_hits(w), 1, "{w}");
        }
        let n: i64 = e
            .conn
            .query_row("SELECT count(*) FROM fts_exchanges", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 3);
    }

    #[test]
    fn bad_line_does_not_abort() {
        let mut e = env();
        e.write(&(exchange_lines("q1", "a1") + "{not json\n" + &exchange_lines("q2", "a2")));
        assert_eq!(e.sync(), FileOutcome::Synced { new_exchanges: 2 });
        assert_eq!(e.exchanges().len(), 2);
        let log = fs::read_to_string(e.paths.logs().join("episodic-memory.log")).unwrap();
        assert!(log.contains("1 unparsable"));
    }

    #[test]
    fn incomplete_tail_does_not_reparse() {
        let mut e = env();
        e.write(&exchange_lines("q1", "a1"));
        e.sync();
        let before = e.exchanges();
        e.append("{\"type\":\"user\",\"mess");
        e.sync();
        assert_eq!(e.exchanges(), before);
    }

    #[test]
    fn directory_at_archive_path_is_an_error_not_an_archive() {
        let e = env();
        let gen0 = archive_path_for(&e.paths, e.f.kind, &e.f.rel, 0);
        fs::create_dir_all(&gen0).unwrap();
        // Both a source smaller and larger than any directory size must fail the same way.
        for body in ["x\n".to_string(), "x\n".repeat(10_000)] {
            fs::write(&e.src, body).unwrap();
            let err = adopt_existing_archive(&e.paths, e.f.kind, &e.f.rel, &e.src).unwrap_err();
            assert!(err.to_string().contains("not a regular file"), "{err}");
        }
        let err = archive_len(&gen0).unwrap_err();
        assert!(err.to_string().contains("not a regular file"), "{err}");
        let row = FileRow::new(path_str(&e.src), e.f.kind, path_str(&gen0), 0, 0);
        assert!(reconcile_archive(&e.paths, &row).is_err());
        assert!(!archive_path_for(&e.paths, e.f.kind, &e.f.rel, 1).exists());
    }
}

#[cfg(test)]
mod orchestration {
    use super::*;
    use fs2::FileExt;

    struct Env {
        _t: tempfile::TempDir,
        paths: Paths,
        root: PathBuf,
        roots: Vec<SourceRoot>,
    }

    fn env() -> Env {
        let t = tempfile::tempdir().unwrap();
        let paths = Paths::new(t.path().join("data"));
        fs::create_dir_all(&paths.data).unwrap();
        let root = t.path().join("src-root");
        let roots = vec![SourceRoot {
            kind: SourceKind::ClaudeCodeProjects,
            root: root.clone(),
        }];
        Env {
            _t: t,
            paths,
            root,
            roots,
        }
    }

    fn put(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    use super::mirror::exchange_lines;

    impl Env {
        fn archive(&self, kind: SourceKind, rel: &str, generation: i64) -> PathBuf {
            archive_path_for(&self.paths, kind, Path::new(rel), generation)
        }
        fn conn(&self) -> Connection {
            crate::db::open(&self.paths.db()).unwrap()
        }
        fn row(&self, conn: &Connection, rel: &str) -> FileRow {
            get_file(conn, self.root.join(rel).to_str().unwrap())
                .unwrap()
                .unwrap()
        }
        fn import(&self, conn: &mut Connection) -> usize {
            import_archive_with_roots(conn, &self.paths, &self.roots, &mut ProjectCache::default())
                .unwrap()
                .0
        }
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    #[allow(clippy::many_single_char_names)]
    fn import_registers_existing_archive() {
        let e = env();
        let k = SourceKind::ClaudeCodeProjects;
        // Source present, archive is a matching prefix: adopt at archive size, then sync only the tail.
        let first = exchange_lines("q1", "a1");
        put(&e.archive(k, "p/match.jsonl", 0), &first);
        put(
            &e.root.join("p/match.jsonl"),
            &(first.clone() + &exchange_lines("q2", "a2")),
        );
        // Source present, tail differs: old archive kept, new generation.
        put(&e.archive(k, "p/diff.jsonl", 0), &first);
        put(
            &e.root.join("p/diff.jsonl"),
            &exchange_lines("different long question", "different long answer"),
        );
        // Source missing: archive only.
        put(&e.archive(k, "p/gone.jsonl", 0), &first);

        let mut conn = e.conn();
        assert_eq!(e.import(&mut conn), 3);
        assert_eq!(meta_get(&conn, "imported").as_deref(), Some("1"));

        let m = e.row(&conn, "p/match.jsonl");
        assert_eq!((m.generation, m.offset), (0, first.len() as i64));
        assert_eq!(
            count(
                &conn,
                &format!(
                    "SELECT count(*) FROM exchanges WHERE archive_path = '{}'",
                    m.archive_path
                )
            ),
            1
        );

        let d = e.row(&conn, "p/diff.jsonl");
        assert_eq!((d.generation, d.offset), (1, 0));
        assert!(d.archive_path.ends_with("p/diff.gen-1.jsonl"));
        assert_eq!(
            fs::read_to_string(e.archive(k, "p/diff.jsonl", 0)).unwrap(),
            first
        );

        let g = e.row(&conn, "p/gone.jsonl");
        assert_eq!((g.generation, g.offset), (0, first.len() as i64));
        assert_eq!(
            count(
                &conn,
                &format!(
                    "SELECT count(*) FROM exchanges WHERE archive_path = '{}'",
                    g.archive_path
                )
            ),
            1
        );
        assert_eq!(count(&conn, "SELECT count(*) FROM exchanges"), 2);

        // Importing again registers nothing.
        assert_eq!(e.import(&mut conn), 0);

        // A later sync of the matching source appends only the tail.
        let df = discover_in(&e.roots);
        let f = df
            .iter()
            .find(|f| f.rel == Path::new("p/match.jsonl"))
            .unwrap();
        // The last (possibly in-progress) exchange is re-parsed, so q1 is rebuilt along with q2.
        assert_eq!(
            sync_file(&mut conn, &e.paths, f, &mut ProjectCache::default()).unwrap(),
            FileOutcome::Synced { new_exchanges: 2 }
        );
        assert_eq!(
            count(
                &conn,
                &format!(
                    "SELECT count(*) FROM exchanges WHERE archive_path = '{}'",
                    m.archive_path
                )
            ),
            2
        );
        assert_eq!(
            fs::read_to_string(e.archive(k, "p/match.jsonl", 0)).unwrap(),
            first + &exchange_lines("q2", "a2")
        );
        // And the mismatched one mirrors into gen-1.
        let f = df
            .iter()
            .find(|f| f.rel == Path::new("p/diff.jsonl"))
            .unwrap();
        sync_file(&mut conn, &e.paths, f, &mut ProjectCache::default()).unwrap();
        assert_eq!(
            fs::metadata(e.archive(k, "p/diff.jsonl", 1)).unwrap().len(),
            f.size
        );
    }

    #[test]
    fn import_skips_legacy_and_generations() {
        let e = env();
        let body = exchange_lines("q", "a");
        put(
            &e.paths.archive_root().join("claude-projects/a.jsonl"),
            &body,
        );
        put(
            &e.paths
                .archive_root()
                .join("claude-code-projects/b.gen-1.jsonl"),
            &body,
        );
        put(
            &e.paths.archive_root().join("claude-code-projects/c.jsonl"),
            &body,
        );
        let mut conn = e.conn();
        assert_eq!(e.import(&mut conn), 1);
        assert_eq!(count(&conn, "SELECT count(*) FROM files"), 1);
    }

    #[test]
    fn discover_filters_and_sorts() {
        let e = env();
        put(&e.root.join("b/x.jsonl"), "");
        put(&e.root.join("a/y.jsonl"), "");
        put(&e.root.join("a/y.gen-2.jsonl"), "");
        put(&e.root.join("a/note.txt"), "");
        std::os::unix::fs::symlink(e.root.join("nowhere"), e.root.join("a/broken.jsonl")).unwrap();
        let rels: Vec<_> = discover_in(&e.roots)
            .into_iter()
            .map(|f| f.rel.to_string_lossy().into_owned())
            .collect();
        assert_eq!(rels, vec!["a/y.jsonl", "b/x.jsonl"]);
    }

    #[test]
    fn run_sync_respects_sync_lock() {
        let e = env();
        put(&e.root.join("p/s.jsonl"), &exchange_lines("q", "a"));
        let held = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(e.paths.sync_lock())
            .unwrap();
        held.lock_exclusive().unwrap();
        let stats = run_sync_with_roots(&e.paths, &e.roots).unwrap();
        assert_eq!(stats, SyncStats::skipped());
        assert!(!e.paths.db().exists());
        held.unlock().unwrap();
        let stats = run_sync_with_roots(&e.paths, &e.roots).unwrap();
        assert!(!stats.skipped);
        assert_eq!(stats.new_exchanges, 1);
    }

    #[test]
    fn run_sync_indexes_and_leaves_embedding_pending() {
        let e = env();
        put(&e.root.join("p/s.jsonl"), &exchange_lines("q", "a"));
        let stats = run_sync_with_roots(&e.paths, &e.roots).unwrap();
        assert_eq!(
            (stats.files_synced, stats.new_exchanges, stats.errors),
            (1, 1, 0)
        );
        let conn = e.conn();
        assert_eq!(
            count(&conn, "SELECT count(*) FROM exchanges WHERE embedded = 0"),
            1
        );
        assert_eq!(meta_get(&conn, "sync_count").as_deref(), Some("1"));
        assert_eq!(meta_get(&conn, "last_error").as_deref(), Some(""));
        assert!(
            chrono::DateTime::parse_from_rfc3339(&meta_get(&conn, "last_sync").unwrap()).is_ok()
        );
        drop(conn);

        let stats = run_sync_with_roots(&e.paths, &e.roots).unwrap();
        assert_eq!(stats.new_exchanges, 0);
        let conn = e.conn();
        assert_eq!(count(&conn, "SELECT count(*) FROM vec_exchanges"), 0);
        assert_eq!(meta_get(&conn, "sync_count").as_deref(), Some("2"));
    }

    #[test]
    fn run_sync_logs_file_errors_and_continues() {
        let e = env();
        put(&e.root.join("p/a.jsonl"), &exchange_lines("q", "a"));
        // A source whose archive location is blocked by a directory fails; the other still syncs.
        put(&e.root.join("p/b.jsonl"), &exchange_lines("q2", "a2"));
        fs::create_dir_all(e.archive(SourceKind::ClaudeCodeProjects, "p/a.jsonl", 0)).unwrap();
        let stats = run_sync_with_roots(&e.paths, &e.roots).unwrap();
        assert_eq!((stats.errors, stats.files_synced), (1, 1));
        assert!(
            e.archive(SourceKind::ClaudeCodeProjects, "p/a.jsonl", 0)
                .is_dir()
        );
        assert!(
            !e.archive(SourceKind::ClaudeCodeProjects, "p/a.jsonl", 1)
                .exists()
        );
        let conn = e.conn();
        let last = meta_get(&conn, "last_error").unwrap();
        assert!(last.contains("a.jsonl"), "{last}");
        let log = fs::read_to_string(e.paths.logs().join("episodic-memory.log")).unwrap();
        assert!(log.contains("a.jsonl"));
    }

    #[test]
    fn older_index_version_reindexes_once() {
        let e = env();
        put(&e.root.join("p/a.jsonl"), &exchange_lines("q", "a"));
        run_sync_with_roots(&e.paths, &e.roots).unwrap();
        let conn = e.conn();
        assert_eq!(
            meta_get(&conn, "index_version").as_deref(),
            Some(INDEX_VERSION)
        );
        // A database indexed by an older version: stale project, version 1.
        conn.execute_batch(
            "UPDATE files SET project = 'stale'; UPDATE exchanges SET project = 'stale';
             UPDATE meta SET value = '1' WHERE key = 'index_version';",
        )
        .unwrap();
        // Reindexed exchanges count as new: the embedding worker is woken for them.
        let stats = run_sync_with_roots(&e.paths, &e.roots).unwrap();
        assert_eq!(stats.new_exchanges, 1);
        let project = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, String>(0)).unwrap();
        assert_eq!(project("SELECT project FROM files"), "demo");
        assert_eq!(project("SELECT project FROM exchanges"), "demo");
        assert_eq!(count(&conn, "SELECT count(*) FROM exchanges"), 1);
        assert_eq!(
            meta_get(&conn, "index_version").as_deref(),
            Some(INDEX_VERSION)
        );
    }
}
