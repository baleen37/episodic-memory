use crate::paths::{Paths, SourceKind};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Bytes compared before `offset` to detect a rewritten source.
pub const TAIL_COMPARE_BYTES: u64 = 4096;

const SCAN_CHUNK: u64 = 64 * 1024;

/// `archive_root/<kind>/<rel>`; generation N>=1 renames `<stem>.jsonl` to `<stem>.gen-<N>.jsonl`.
pub fn archive_path_for(paths: &Paths, kind: SourceKind, rel: &Path, generation: i64) -> PathBuf {
    let base = paths.archive_root().join(kind.as_str()).join(rel);
    if generation == 0 {
        return base;
    }
    let name = base
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let stem = name.strip_suffix(".jsonl").unwrap_or(&name);
    base.with_file_name(format!("{stem}.gen-{generation}.jsonl"))
}

/// Position just after the last '\n' in `f[from..len)`, or `from` if there is none.
fn end_of_last_line(f: &mut File, from: u64, len: u64) -> io::Result<u64> {
    let mut end = len;
    let mut buf = vec![0u8; SCAN_CHUNK as usize];
    while end > from {
        let start = end.saturating_sub(SCAN_CHUNK).max(from);
        let chunk = &mut buf[..(end - start) as usize];
        f.seek(SeekFrom::Start(start))?;
        f.read_exact(chunk)?;
        if let Some(i) = chunk.iter().rposition(|&b| b == b'\n') {
            return Ok(start + i as u64 + 1);
        }
        end = start;
    }
    Ok(from)
}

/// Appends `src[offset..last '\n']` to `dst` (assumed to be exactly `offset` long) and fsyncs.
/// Returns the new offset; unchanged when no complete line was added.
pub fn append_tail(src: &Path, dst: &Path, offset: u64) -> io::Result<u64> {
    let mut s = File::open(src)?;
    let len = s.metadata()?.len();
    if len <= offset {
        return Ok(offset);
    }
    let end = end_of_last_line(&mut s, offset, len)?;
    if end == offset {
        return Ok(offset);
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut d = OpenOptions::new().create(true).append(true).open(dst)?;
    s.seek(SeekFrom::Start(offset))?;
    let copied = io::copy(&mut (&mut s).take(end - offset), &mut d)?;
    if copied != end - offset {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "source shrank while appending",
        ));
    }
    d.sync_all()?;
    Ok(end)
}

/// Reads `[start, end)`; `None` if the file is shorter than `end`.
fn read_range(path: &Path, start: u64, end: u64) -> io::Result<Option<Vec<u8>>> {
    let mut f = File::open(path)?;
    if f.metadata()?.len() < end {
        return Ok(None);
    }
    let mut buf = vec![0u8; (end - start) as usize];
    f.seek(SeekFrom::Start(start))?;
    match f.read_exact(&mut buf) {
        Ok(()) => Ok(Some(buf)),
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => Ok(None),
        Err(e) => Err(e),
    }
}

/// Whether `src` and `dst` agree on `[offset-4096, offset)` (from 0 when offset < 4096).
/// False when either file is shorter than `offset`.
pub fn tails_match(src: &Path, dst: &Path, offset: u64) -> io::Result<bool> {
    let start = offset.saturating_sub(TAIL_COMPARE_BYTES);
    let a = read_range(src, start, offset)?;
    let b = read_range(dst, start, offset)?;
    Ok(matches!((a, b), (Some(a), Some(b)) if a == b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn archive_path_generations() {
        let p = Paths::new(PathBuf::from("/d"));
        let rel = Path::new("proj/abc.jsonl");
        assert_eq!(
            archive_path_for(&p, SourceKind::CodexSessions, rel, 0),
            PathBuf::from("/d/conversation-archive/codex-sessions/proj/abc.jsonl")
        );
        assert_eq!(
            archive_path_for(&p, SourceKind::ClaudeCodeProjects, rel, 2),
            PathBuf::from("/d/conversation-archive/claude-code-projects/proj/abc.gen-2.jsonl")
        );
    }

    #[test]
    fn append_tail_copies_complete_lines_only() {
        let t = tempfile::tempdir().unwrap();
        let src = t.path().join("s.jsonl");
        let dst = t.path().join("a/b/d.jsonl");
        fs::write(&src, "one\ntwo\nthr").unwrap();
        assert_eq!(append_tail(&src, &dst, 0).unwrap(), 8);
        assert_eq!(fs::read_to_string(&dst).unwrap(), "one\ntwo\n");
        assert_eq!(append_tail(&src, &dst, 8).unwrap(), 8);
        fs::write(&src, "one\ntwo\nthree\n").unwrap();
        assert_eq!(append_tail(&src, &dst, 8).unwrap(), 14);
        assert_eq!(fs::read_to_string(&dst).unwrap(), "one\ntwo\nthree\n");
    }

    #[test]
    fn append_tail_finds_newline_beyond_scan_chunk() {
        let t = tempfile::tempdir().unwrap();
        let src = t.path().join("s.jsonl");
        let dst = t.path().join("d.jsonl");
        let mut body = "x".repeat(200_000);
        body.push('\n');
        body.push_str(&"y".repeat(150_000)); // incomplete, longer than one scan chunk
        fs::write(&src, &body).unwrap();
        assert_eq!(append_tail(&src, &dst, 0).unwrap(), 200_001);
        assert_eq!(fs::metadata(&dst).unwrap().len(), 200_001);
    }

    #[test]
    fn tails_match_compares_last_4096_bytes() {
        let t = tempfile::tempdir().unwrap();
        let src = t.path().join("s");
        let dst = t.path().join("d");
        let base = "a".repeat(10_000);
        fs::write(&src, format!("{base}more")).unwrap();
        fs::write(&dst, &base).unwrap();
        assert!(tails_match(&src, &dst, 10_000).unwrap());
        // A difference before the compared window is not detected.
        let mut early = base.clone().into_bytes();
        early[0] = b'b';
        fs::write(&dst, &early).unwrap();
        assert!(tails_match(&src, &dst, 10_000).unwrap());
        // A difference inside the window is.
        let mut late = base.into_bytes();
        late[9_999] = b'b';
        fs::write(&dst, &late).unwrap();
        assert!(!tails_match(&src, &dst, 10_000).unwrap());
        // Shorter source never matches.
        assert!(!tails_match(&src, &dst, 20_000).unwrap());
        // Small offsets compare from 0.
        fs::write(&src, "abc").unwrap();
        fs::write(&dst, "abX").unwrap();
        assert!(tails_match(&src, &dst, 2).unwrap());
        assert!(!tails_match(&src, &dst, 3).unwrap());
    }
}
