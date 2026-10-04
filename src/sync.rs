use crate::archive::{append_tail, archive_path_for, tails_match};
use crate::db::{
    FileRow, NewExchange, delete_exchanges_from, get_file, insert_exchange, meta_get, meta_set,
    upsert_file,
};
use crate::embed::{Embedder, embed_pending};
use crate::log::log_line;
use crate::parse::{FileMeta, parse_from, read_meta};
use crate::paths::{Paths, SourceKind, SourceRoot, candidate_roots_from_env, try_lock};
use crate::project::resolve_project;
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
const INDEX_VERSION: &str = "2";

/// Exchanges larger than this (either message, UTF-8 bytes) are not indexed (obra#139).
const MAX_MESSAGE_BYTES: usize = 262_144;

#[derive(Debug, Default, PartialEq, Eq)]
struct IndexStats {
    inserted: usize,
    oversize: usize,
    bad_lines: usize,
}

/// Spec §5 steps 6–9.
fn index_file(tx: &Transaction, row: &mut FileRow) -> Result<IndexStats> {
    let kind = row.source_kind;
    let mut stats = IndexStats::default();
    if row.skipped {
        return Ok(stats);
    }
    let archive = PathBuf::from(&row.archive_path);

    // Session info is read on the first parse of a non-empty archive and persisted. Claude
    // transcripts often open with lines lacking `cwd` (`mode`, `last-prompt`, ...), so it is
    // re-read (and the project recomputed) until a `cwd` is known. A file with a user signal
    // re-reads the head on every call: the signal can change as lines arrive, and `files` does
    // not store `agent_path`. Other files reuse the persisted values. The archive path keeps the
    // source's relative path, so "subagents" detection works on it directly.
    let read_session = row.offset > 0 && (row.harness.is_none() || row.cwd.is_none());
    let meta = if read_session || row.user_signal.is_some() {
        read_meta(kind, &archive, &row.archive_path)?
    } else {
        FileMeta {
            session_id: row.session_id.clone(),
            cwd: row.cwd.clone(),
            is_sidechain: row.is_sidechain.unwrap_or(false),
            sidechain_known: row.is_sidechain.is_some(),
            agent_path: None,
            user_signal: row.user_signal.clone(),
        }
    };
    if read_session {
        row.session_id = meta.session_id.clone();
        row.cwd = meta.cwd.clone();
        row.is_sidechain = Some(meta.is_sidechain);
        row.user_signal = meta.user_signal.clone();
        row.harness = Some(kind.harness().to_string());
        row.project = Some(resolve_project(meta.cwd.as_deref()));
    }

    delete_exchanges_from(tx, &row.archive_path, row.reparse_line)?;
    let out = parse_from(kind, &archive, row.reparse_line, &meta)?;
    stats.bad_lines = out.bad_lines;
    if out.do_not_index {
        row.skipped = true;
        delete_exchanges_from(tx, &row.archive_path, 1)?;
        return Ok(stats);
    }

    let project = row.project.clone().unwrap_or_else(|| "unknown".into());
    if let Some(last) = out.exchanges.last() {
        row.reparse_line = last.line_start;
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
            session_id: row.session_id.clone(),
            project: project.clone(),
            harness: kind.harness().to_string(),
            is_sidechain: row.is_sidechain.unwrap_or(false),
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
fn reconcile_archive(row: &FileRow) -> Result<bool> {
    let path = Path::new(&row.archive_path);
    let offset = row.offset as u64;
    match archive_len(path)? {
        Some(len) if len > offset => {
            let f = fs::OpenOptions::new().write(true).open(path)?;
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
    row.archive_path = path_str(&archive_path_for(paths, f.kind, &f.rel, generation));
    row.offset = 0;
    row.reparse_line = 1;
    upsert_file(&tx, row)?;
    tx.commit()?;
    Ok(())
}

fn register_new(conn: &mut Connection, paths: &Paths, f: &DiscoveredFile) -> Result<FileRow> {
    let (generation, offset) = adopt_existing_archive(paths, f.kind, &f.rel, &f.source_path)?;
    let row = FileRow::new(
        path_str(&f.source_path),
        f.kind,
        path_str(&archive_path_for(paths, f.kind, &f.rel, generation)),
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

    let old_offset = row.offset;
    let new_offset = append_tail(
        &f.source_path,
        Path::new(&row.archive_path),
        row.offset as u64,
    )?;

    let tx = conn.transaction()?;
    row.offset = new_offset as i64;
    // Nothing new to parse unless the append moved the offset or the first parse is pending.
    let stats = if row.offset != old_offset || row.harness.is_none() {
        index_file(&tx, &mut row)?
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
                row.archive_path, stats.bad_lines, stats.oversize
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

pub(crate) fn is_generation_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".jsonl") else {
        return false;
    };
    match stem.rsplit_once(".gen-") {
        Some((_, digits)) => !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()),
        None => false,
    }
}

/// Recursively collects `*.jsonl` (not `*.gen-<N>.jsonl`) under `root`, following symlinks.
/// Broken links and unreadable entries are skipped, and each directory is entered once (by
/// device and inode) so a link to an ancestor cannot loop. Returns `(path relative to root, size)`.
fn walk_jsonl(root: &Path) -> Vec<(PathBuf, u64)> {
    let mut out = Vec::new();
    let mut visited = HashSet::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(meta) = fs::metadata(&dir) else {
            continue;
        };
        if !visited.insert((meta.dev(), meta.ino())) {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.ends_with(".jsonl")
                    && !is_generation_name(&name)
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
/// per kind. Returns the number of files registered; sets `meta.imported` only when no file failed.
pub fn import_archive_with_roots(
    conn: &mut Connection,
    paths: &Paths,
    candidates: &[SourceRoot],
) -> Result<usize> {
    let mut registered = 0;
    let mut failures = 0;
    for kind in SourceKind::ALL {
        let Some(root) = candidates.iter().find(|r| r.kind == kind) else {
            continue;
        };
        let archive_dir = paths.archive_root().join(kind.as_str());
        for (rel, _) in walk_jsonl(&archive_dir) {
            match import_one(conn, paths, kind, &root.root, &rel) {
                Ok(true) => registered += 1,
                Ok(false) => {}
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
    Ok(registered)
}

/// Rebuilds every indexed file's exchanges and session info (project included) from its
/// archive. A file that fails is logged and left as it was.
fn reindex_all(conn: &mut Connection, paths: &Paths) -> Result<()> {
    let sources: Vec<String> = conn
        .prepare(r#"SELECT source_path FROM files WHERE "offset" > 0 AND skipped = 0"#)?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for source in sources {
        let result = (|| -> Result<()> {
            let Some(mut row) = get_file(conn, &source)? else {
                return Ok(());
            };
            row.reparse_line = 1;
            row.harness = None;
            let tx = conn.transaction()?;
            index_file(&tx, &mut row)?;
            upsert_file(&tx, &row)?;
            tx.commit()?;
            Ok(())
        })();
        if let Err(e) = result {
            log_line(paths, &format!("reindex {source}: {e:#}"));
        }
    }
    meta_set(conn, "index_version", INDEX_VERSION)
}

/// Registers one archive file; false if it already has a `files` row.
fn import_one(
    conn: &mut Connection,
    paths: &Paths,
    kind: SourceKind,
    root: &Path,
    rel: &Path,
) -> Result<bool> {
    let archive0 = path_str(&archive_path_for(paths, kind, rel, 0));
    let source = root.join(rel);
    let source_key = path_str(&source);
    let known: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM files WHERE archive_path = ?1 OR source_path = ?2)",
        [&archive0, &source_key],
        |r| r.get(0),
    )?;
    if known {
        return Ok(false);
    }
    let (generation, offset) = if source.exists() {
        adopt_existing_archive(paths, kind, rel, &source)?
    } else {
        (0, fs::metadata(&archive0)?.len())
    };
    let mut row = FileRow::new(
        source_key,
        kind,
        path_str(&archive_path_for(paths, kind, rel, generation)),
        generation,
        offset as i64,
    );
    let tx = conn.transaction()?;
    upsert_file(&tx, &row)?;
    if row.offset > 0 {
        index_file(&tx, &mut row)?;
        upsert_file(&tx, &row)?;
    }
    tx.commit()?;
    Ok(true)
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct SyncStats {
    pub skipped: bool,
    pub files_synced: usize,
    pub new_exchanges: usize,
    pub errors: usize,
    pub embedded: usize,
}

impl SyncStats {
    pub fn skipped() -> SyncStats {
        SyncStats {
            skipped: true,
            ..SyncStats::default()
        }
    }
}

pub fn run_sync(paths: &Paths, embedder: Option<&dyn Embedder>) -> Result<SyncStats> {
    run_sync_with_roots(paths, embedder, &candidate_roots_from_env())
}

/// `roots` are the candidate roots per kind; missing ones are ignored for discovery.
pub fn run_sync_with_roots(
    paths: &Paths,
    embedder: Option<&dyn Embedder>,
    roots: &[SourceRoot],
) -> Result<SyncStats> {
    let Some(lock) = try_lock(&paths.sync_lock())? else {
        return Ok(SyncStats::skipped());
    };
    let mut conn = crate::db::open(&paths.db())?;
    if meta_get(&conn, "imported").is_none() {
        import_archive_with_roots(&mut conn, paths, roots)?;
    }
    if meta_get(&conn, "index_version").as_deref() != Some(INDEX_VERSION) {
        reindex_all(&mut conn, paths)?;
    }

    let mut stats = SyncStats::default();
    let mut last_error = String::new();
    for f in discover_in(roots) {
        match sync_file(&mut conn, paths, &f) {
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
    if let Some(e) = embedder {
        match embed_pending(&mut conn, e) {
            Ok(n) => stats.embedded = n,
            Err(err) => {
                stats.errors += 1;
                last_error = format!("embedding: {err:#}");
                log_line(paths, &last_error);
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

    // ---- Task 8: indexing ----

    fn user(text: &str) -> String {
        format!(
            "{}\n",
            serde_json::json!({"type":"user","sessionId":"s1","cwd":"/nonexistent/demo",
                "isSidechain":false,"timestamp":"2026-01-02T03:04:05Z",
                "message":{"role":"user","content":text}})
        )
    }

    fn assistant(text: &str) -> String {
        format!(
            "{}\n",
            serde_json::json!({"type":"assistant","message":{"role":"assistant",
                "content":[{"type":"text","text":text}]}})
        )
    }

    fn turn(q: &str, a: &str) -> String {
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

    #[test]
    fn indexes_fresh_file_and_fills_session_info() {
        let mut e = env();
        e.write(&(turn("alpha question", "alpha answer") + &turn("beta q", "beta a")));
        assert_eq!(e.sync(), FileOutcome::Synced { new_exchanges: 2 });
        let row = e.row();
        assert_eq!(row.session_id.as_deref(), Some("s1"));
        assert_eq!(row.cwd.as_deref(), Some("/nonexistent/demo"));
        assert_eq!(row.project.as_deref(), Some("demo"));
        assert_eq!(row.harness.as_deref(), Some("claude"));
        assert_eq!(row.is_sidechain, Some(false));
        assert_eq!(row.reparse_line, 3);
        assert_eq!(e.exchanges().len(), 2);
    }

    #[test]
    fn open_turn_is_indexed_once_answered() {
        let mut e = env();
        e.write(&(turn("q1", "a1") + &user("still thinking")));
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
        assert!(row.cwd.is_none());
        assert_eq!(row.project.as_deref(), Some("unknown"));
        e.append(&turn("q1", "a1"));
        assert_eq!(e.sync(), FileOutcome::Synced { new_exchanges: 1 });
        let row = e.row();
        assert_eq!(row.cwd.as_deref(), Some("/nonexistent/demo"));
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
        e.write(&(turn("q1", "a1") + &turn("q2", "a2") + &turn("q3", "a3")));
        e.sync();
        let before = e.exchanges();
        assert_eq!(before.len(), 3);
        e.append(&turn("q4", "a4"));
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
        e.write(&(turn("q1", "a1") + &turn("q2", "a2")));
        e.sync();
        assert_eq!(e.exchanges().len(), 2);
        e.append(&turn(crate::parse::DO_NOT_INDEX, "ok"));
        assert_eq!(e.sync(), FileOutcome::Skipped);
        assert_eq!(e.exchanges().len(), 0);
        assert_eq!(e.fts_hits("q1"), 0);
        assert!(e.row().skipped);
        e.append(&turn("q5", "a5"));
        assert_eq!(e.sync(), FileOutcome::Skipped);
        assert_eq!(e.exchanges().len(), 0);
        assert!(e.archive(0).contains("q5"));
    }

    #[test]
    fn oversize_exchange_skipped() {
        let mut e = env();
        let big = "x".repeat(300 * 1024);
        e.write(&(turn("small one", "a1") + &turn(&big, "a2") + &turn("small two", "a3")));
        assert_eq!(e.sync(), FileOutcome::Synced { new_exchanges: 2 });
        let users: Vec<String> = e.exchanges().into_iter().map(|x| x.2).collect();
        assert_eq!(users, vec!["small one", "small two"]);
        let log = fs::read_to_string(e.paths.logs().join("episodic-memory.log")).unwrap();
        assert!(log.contains("1 oversize"));
    }

    #[test]
    fn fts_row_per_exchange() {
        let mut e = env();
        e.write(&(turn("alpha", "one") + &turn("bravo", "two") + &turn("charlie", "three")));
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
        e.write(&(turn("q1", "a1") + "{not json\n" + &turn("q2", "a2")));
        assert_eq!(e.sync(), FileOutcome::Synced { new_exchanges: 2 });
        assert_eq!(e.exchanges().len(), 2);
        let log = fs::read_to_string(e.paths.logs().join("episodic-memory.log")).unwrap();
        assert!(log.contains("1 unparsable"));
    }

    #[test]
    fn incomplete_tail_does_not_reparse() {
        let mut e = env();
        e.write(&turn("q1", "a1"));
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
        assert!(reconcile_archive(&row).is_err());
        assert!(!archive_path_for(&e.paths, e.f.kind, &e.f.rel, 1).exists());
    }
}

#[cfg(test)]
mod orchestration {
    use super::*;
    use crate::embed::FakeEmbedder;
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

    fn turn(q: &str, a: &str) -> String {
        format!(
            "{}\n{}\n",
            serde_json::json!({"type":"user","sessionId":"s1","cwd":"/nonexistent/demo",
                "isSidechain":false,"timestamp":"2026-01-02T03:04:05Z",
                "message":{"role":"user","content":q}}),
            serde_json::json!({"type":"assistant","message":{"role":"assistant",
                "content":[{"type":"text","text":a}]}})
        )
    }

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
            import_archive_with_roots(conn, &self.paths, &self.roots).unwrap()
        }
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn import_registers_existing_archive() {
        let e = env();
        let k = SourceKind::ClaudeCodeProjects;
        // Source present, archive is a matching prefix: adopt at archive size, then sync only the tail.
        let first = turn("q1", "a1");
        put(&e.archive(k, "p/match.jsonl", 0), &first);
        put(
            &e.root.join("p/match.jsonl"),
            &(first.clone() + &turn("q2", "a2")),
        );
        // Source present, tail differs: old archive kept, new generation.
        put(&e.archive(k, "p/diff.jsonl", 0), &first);
        put(
            &e.root.join("p/diff.jsonl"),
            &turn("different long question", "different long answer"),
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
            sync_file(&mut conn, &e.paths, f).unwrap(),
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
            first + &turn("q2", "a2")
        );
        // And the mismatched one mirrors into gen-1.
        let f = df
            .iter()
            .find(|f| f.rel == Path::new("p/diff.jsonl"))
            .unwrap();
        sync_file(&mut conn, &e.paths, f).unwrap();
        assert_eq!(
            fs::metadata(e.archive(k, "p/diff.jsonl", 1)).unwrap().len(),
            f.size
        );
    }

    #[test]
    fn import_skips_legacy_and_generations() {
        let e = env();
        let body = turn("q", "a");
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
        assert!(is_generation_name("s.gen-12.jsonl"));
        assert!(!is_generation_name("s.gen-x.jsonl"));
        assert!(!is_generation_name("s.jsonl"));
    }

    #[test]
    fn run_sync_respects_sync_lock() {
        let e = env();
        put(&e.root.join("p/s.jsonl"), &turn("q", "a"));
        let held = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(e.paths.sync_lock())
            .unwrap();
        held.lock_exclusive().unwrap();
        let stats = run_sync_with_roots(&e.paths, Some(&FakeEmbedder), &e.roots).unwrap();
        assert_eq!(stats, SyncStats::skipped());
        assert!(!e.paths.db().exists());
        held.unlock().unwrap();
        let stats = run_sync_with_roots(&e.paths, None, &e.roots).unwrap();
        assert!(!stats.skipped);
        assert_eq!(stats.new_exchanges, 1);
    }

    #[test]
    fn run_sync_without_embedder_leaves_pending() {
        let e = env();
        put(&e.root.join("p/s.jsonl"), &turn("q", "a"));
        let stats = run_sync_with_roots(&e.paths, None, &e.roots).unwrap();
        assert_eq!(
            (
                stats.files_synced,
                stats.new_exchanges,
                stats.embedded,
                stats.errors
            ),
            (1, 1, 0, 0)
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

        let stats = run_sync_with_roots(&e.paths, Some(&FakeEmbedder), &e.roots).unwrap();
        assert_eq!((stats.new_exchanges, stats.embedded), (0, 1));
        let conn = e.conn();
        assert_eq!(count(&conn, "SELECT count(*) FROM vec_exchanges"), 1);
        assert_eq!(meta_get(&conn, "sync_count").as_deref(), Some("2"));
    }

    #[test]
    fn run_sync_logs_file_errors_and_continues() {
        let e = env();
        put(&e.root.join("p/a.jsonl"), &turn("q", "a"));
        // A source whose archive location is blocked by a directory fails; the other still syncs.
        put(&e.root.join("p/b.jsonl"), &turn("q2", "a2"));
        fs::create_dir_all(e.archive(SourceKind::ClaudeCodeProjects, "p/a.jsonl", 0)).unwrap();
        let stats = run_sync_with_roots(&e.paths, None, &e.roots).unwrap();
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
        put(&e.root.join("p/a.jsonl"), &turn("q", "a"));
        run_sync_with_roots(&e.paths, None, &e.roots).unwrap();
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
        run_sync_with_roots(&e.paths, None, &e.roots).unwrap();
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
