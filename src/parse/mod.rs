use crate::paths::SourceKind;
use anyhow::Result;
use serde_json::Value;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

pub mod claude;
pub mod codex;

pub const DO_NOT_INDEX: &str =
    "<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileMeta {
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub is_sidechain: bool,
    pub agent_path: Option<String>,
    pub user_signal: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedExchange {
    pub line_start: i64,
    pub line_end: i64,
    pub ts: i64,
    pub user_message: String,
    pub assistant_message: String,
    pub tool_names: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParseOutput {
    pub exchanges: Vec<ParsedExchange>,
    pub do_not_index: bool,
    pub bad_lines: usize,
}

pub(crate) type Line = (i64, Option<Value>);

/// Yields (1-based line number, parsed JSON or None when the line is bad). Blank lines are skipped.
/// I/O errors are yielded as `Err`; invalid UTF-8 or JSON is a bad line, not an error.
pub(crate) fn read_lines<R: BufRead>(mut reader: R) -> impl Iterator<Item = Result<Line>> {
    let mut n = 0i64;
    let mut buf = Vec::new();
    std::iter::from_fn(move || loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => return None,
            Err(e) => return Some(Err(e.into())),
            Ok(_) => {
                n += 1;
                let parsed = std::str::from_utf8(&buf).ok().map(str::trim);
                if parsed == Some("") {
                    continue;
                }
                let v = parsed.and_then(|s| serde_json::from_str::<Value>(s).ok());
                return Some(Ok((n, v)));
            }
        }
    })
}

pub(crate) fn read_file_lines(path: &Path) -> Result<impl Iterator<Item = Result<Line>>> {
    Ok(read_lines(BufReader::new(File::open(path)?)))
}

/// Line timestamp (top-level RFC3339 `timestamp`) in ms; 0 when missing or invalid.
pub(crate) fn ts_ms(v: &Value) -> i64 {
    v["timestamp"]
        .as_str()
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .map_or(0, |d| d.timestamp_millis())
}

const TRUNCATED: &str = "…[truncated]";
pub(crate) const TEXT_MAX: usize = 16384;
pub(crate) const TOOL_MAX: usize = 4096;

/// Cuts `s` to at most `max` bytes on a char boundary and appends a marker when cut.
pub(crate) fn truncate_bytes(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{TRUNCATED}", &s[..end])
}

/// Markdown items for one archive line (`**User:**`, `**Assistant:**`, `**Tool <name>:**`,
/// `**Result:**`); empty when the line has nothing to show.
pub fn render_line(kind: SourceKind, value: &Value) -> Vec<String> {
    match kind {
        SourceKind::ClaudeCodeProjects | SourceKind::ClaudeCodeTranscripts => {
            claude::render_line(value)
        }
        SourceKind::CodexSessions => codex::render_line(value),
    }
}

/// Reads file-level metadata from the head of the archive file.
pub fn read_meta(kind: SourceKind, archive: &Path, rel_path: &str) -> Result<FileMeta> {
    match kind {
        SourceKind::ClaudeCodeProjects | SourceKind::ClaudeCodeTranscripts => {
            claude::read_meta(archive, rel_path)
        }
        SourceKind::CodexSessions => codex::read_meta(archive),
    }
}

/// Parses exchanges starting at the 1-based physical line `from_line`.
pub fn parse_from(
    kind: SourceKind,
    archive: &Path,
    from_line: i64,
    meta: &FileMeta,
) -> Result<ParseOutput> {
    match kind {
        SourceKind::ClaudeCodeProjects | SourceKind::ClaudeCodeTranscripts => {
            claude::parse_from(archive, from_line, meta)
        }
        SourceKind::CodexSessions => codex::parse_from(archive, from_line, meta),
    }
}
