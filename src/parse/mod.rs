use crate::paths::SourceKind;
use anyhow::Result;
use serde_json::Value;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
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
    /// A line has decided `is_sidechain` (Claude: first `isSidechain`; Codex: first
    /// `session_meta`); later lines no longer change it.
    pub sidechain_known: bool,
    pub agent_path: Option<String>,
    pub user_signal: Option<String>,
}

impl FileMeta {
    /// True when both decide exchange start messages alike: they agree on every field an
    /// adapter's `start_message` may read.
    pub fn same_boundaries(&self, other: &FileMeta) -> bool {
        self.agent_path == other.agent_path && self.user_signal == other.user_signal
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedExchange {
    pub line_start: i64,
    /// Byte position where line `line_start` starts in the archive.
    pub byte_start: i64,
    pub line_end: i64,
    pub ts: i64,
    pub user_message: String,
    pub assistant_message: String,
    pub tool_names: Vec<String>,
    /// Answer text seen only in transient events (Codex `agent_message`); it becomes the answer
    /// when the turn recorded none, which happens when the user interrupts it.
    pub fallback_answer: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParseOutput {
    pub exchanges: Vec<ParsedExchange>,
    pub do_not_index: bool,
    pub bad_lines: usize,
}

pub(crate) type Line = (i64, Option<Value>);

/// Where the next sync resumes parsing an archive: the 1-based line number of the last
/// exchange's start message and the byte position where that line starts. Byte 0 past line 1
/// means the position is unknown (rows from schema version 2): the line is found by counting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReparsePoint {
    pub line: i64,
    pub byte: i64,
}

impl ReparsePoint {
    /// The archive's first line.
    pub const START: ReparsePoint = ReparsePoint { line: 1, byte: 0 };
}

/// Yields (1-based line number, parsed JSON or None when the line is bad). Blank lines are skipped.
/// I/O errors are yielded as `Err`; invalid UTF-8 or JSON is a bad line, not an error.
#[cfg(test)]
pub(crate) fn read_lines<R: BufRead>(reader: R) -> impl Iterator<Item = Result<Line>> {
    read_lines_from(reader, 1)
}

/// Like `read_lines`, but lines before `from_line` are only counted, never decoded.
fn read_lines_from<R: BufRead>(reader: R, from_line: i64) -> impl Iterator<Item = Result<Line>> {
    positioned_lines(reader, ReparsePoint::START, from_line).map(|l| l.map(|(n, _, v)| (n, v)))
}

/// Lines of a reader positioned at `at` (line `at.line` starts at byte `at.byte`), each with
/// its line number and start byte. Lines before `from_line` are only counted, never decoded.
fn positioned_lines<R: BufRead>(
    mut reader: R,
    at: ReparsePoint,
    from_line: i64,
) -> impl Iterator<Item = Result<(i64, i64, Option<Value>)>> {
    let mut n = at.line - 1;
    let mut next_byte = at.byte;
    let mut buf = Vec::new();
    std::iter::from_fn(move || {
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) => return None,
                Err(e) => return Some(Err(e.into())),
                Ok(len) => {
                    n += 1;
                    let byte = next_byte;
                    next_byte += len as i64;
                    if n < from_line {
                        continue;
                    }
                    let parsed = std::str::from_utf8(&buf).ok().map(str::trim);
                    if parsed == Some("") {
                        continue;
                    }
                    let v = parsed.and_then(|s| serde_json::from_str::<Value>(s).ok());
                    return Some(Ok((n, byte, v)));
                }
            }
        }
    })
}

/// `read_lines_from` over a file: lines before `from_line` are counted, never decoded.
pub(crate) fn read_file_lines_from(
    path: &Path,
    from_line: i64,
) -> Result<impl Iterator<Item = Result<Line>>> {
    Ok(read_lines_from(
        BufReader::new(File::open(path)?),
        from_line,
    ))
}

impl ParsedExchange {
    fn new(line: i64, byte: i64, ts: i64, user_message: String) -> Self {
        Self {
            line_start: line,
            byte_start: byte,
            line_end: line,
            ts,
            user_message,
            assistant_message: String::new(),
            tool_names: Vec::new(),
            fallback_answer: String::new(),
        }
    }

    /// The exchange as indexed, or None when the turn produced neither an answer nor a tool
    /// call (interrupted before any output, resubmitted, or a local command like `/clear`).
    fn finish(mut self) -> Option<Self> {
        if self.assistant_message.is_empty() {
            self.assistant_message = std::mem::take(&mut self.fallback_answer);
        }
        self.fallback_answer.clear();
        (!self.assistant_message.is_empty() || !self.tool_names.is_empty()).then_some(self)
    }

    pub(crate) fn push_answer(&mut self, text: &str) {
        if !self.assistant_message.is_empty() {
            self.assistant_message.push_str("\n\n");
        }
        self.assistant_message.push_str(text);
    }

    pub(crate) fn push_tool(&mut self, name: &str) {
        if !self.tool_names.iter().any(|t| t == name) {
            self.tool_names.push(name.to_string());
        }
    }
}

/// One provider's transcript format. Every operation looks at a single archive line, so file
/// meta can be learned from appended lines alone. `provider` maps a source kind to its adapter.
pub(crate) trait Provider: Sync {
    /// File meta before any line is observed; `archive_path` keeps the source's relative path.
    fn initial_meta(&self, archive_path: &str) -> FileMeta;
    /// Updates `meta` from one line. Returns true once no later line can change it.
    fn observe_meta(&self, meta: &mut FileMeta, line: &Value) -> bool;
    /// The exchange start message text when `line` opens an exchange.
    fn start_message(&self, line: &Value, meta: &FileMeta) -> Option<String>;
    /// Folds a line that is not an exchange start message into the open exchange.
    fn fold_line(&self, exchange: &mut ParsedExchange, line: &Value);
    /// Markdown items for `read`; empty when the line has nothing to show.
    fn render_line(&self, line: &Value) -> Vec<String>;
}

/// The only place a source kind is mapped to its provider adapter.
pub(crate) fn provider(kind: SourceKind) -> &'static dyn Provider {
    match kind {
        SourceKind::ClaudeCodeProjects | SourceKind::ClaudeCodeTranscripts => &claude::ClaudeCode,
        SourceKind::CodexSessions => &codex::Codex,
    }
}

/// Exchange loop shared by all providers. Bad lines extend the open exchange.
/// Turns without an answer or tool call are dropped; a still-open last turn is picked up again
/// by the next sync, which reparses from the last returned exchange.
fn parse_exchanges(
    p: &dyn Provider,
    archive: &Path,
    from: ReparsePoint,
    meta: &FileMeta,
) -> Result<ParseOutput> {
    let mut out = ParseOutput::default();
    let mut cur: Option<ParsedExchange> = None;
    let mut file = File::open(archive)?;
    // A known byte position is seeked to; an unknown one is found by counting from line 1.
    let at = if from.byte > 0 || from.line == 1 {
        file.seek(SeekFrom::Start(from.byte as u64))?;
        from
    } else {
        ReparsePoint::START
    };
    for line in positioned_lines(BufReader::new(file), at, from.line) {
        let (n, byte, v) = line?;
        let Some(v) = v else {
            out.bad_lines += 1;
            if let Some(c) = cur.as_mut() {
                c.line_end = n;
            }
            continue;
        };
        if let Some(text) = p.start_message(&v, meta) {
            out.exchanges
                .extend(cur.take().and_then(ParsedExchange::finish));
            out.do_not_index |= text.contains(DO_NOT_INDEX);
            cur = Some(ParsedExchange::new(n, byte, ts_ms(&v), text));
            continue;
        }
        let Some(c) = cur.as_mut() else { continue };
        c.line_end = n;
        p.fold_line(c, &v);
    }
    out.exchanges.extend(cur.and_then(ParsedExchange::finish));
    Ok(out)
}

/// Line timestamp (top-level RFC3339 `timestamp`) in ms; 0 when missing or invalid.
pub(crate) fn ts_ms(v: &Value) -> i64 {
    v["timestamp"]
        .as_str()
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .map_or(0, |d| d.timestamp_millis())
}

const TRUNCATED: &str = "…[truncated]";
const TEXT_MAX: usize = 16384;
const TOOL_MAX: usize = 4096;

/// Cuts `s` to at most `max` bytes on a char boundary and appends a marker when cut.
pub(crate) fn truncate_bytes(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    format!("{}{TRUNCATED}", &s[..s.floor_char_boundary(max)])
}

/// The first `max` chars of `s` (all of it when shorter).
pub(crate) fn truncate_chars(s: &str, max: usize) -> &str {
    s.char_indices().nth(max).map_or(s, |(i, _)| &s[..i])
}

pub(crate) fn render_text(role: &str, text: &str) -> String {
    format!("**{role}:** {}", truncate_bytes(text, TEXT_MAX))
}

pub(crate) fn render_tool(name: &str, input: &str) -> String {
    format!("**Tool {name}:** {}", truncate_bytes(input, TOOL_MAX))
}

pub(crate) fn render_result(output: &str) -> String {
    format!("**Result:** {}", truncate_bytes(output, TOOL_MAX))
}

/// A JSON value as display text: strings verbatim, null empty, anything else as JSON.
pub(crate) fn value_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Markdown items for one archive line (`**User:**`, `**Assistant:**`, `**Tool <name>:**`,
/// `**Result:**`); empty when the line has nothing to show.
pub fn render_line(kind: SourceKind, value: &Value) -> Vec<String> {
    provider(kind).render_line(value)
}

/// File meta of an archive before any of its lines is observed. `archive_path` keeps the
/// source's relative path.
pub fn initial_meta(kind: SourceKind, archive_path: &str) -> FileMeta {
    provider(kind).initial_meta(archive_path)
}

/// Updates `meta` from the archive lines that start at byte `from` (a line start), stopping
/// once it is settled. Returns true when no later line can change `meta`.
pub fn observe_meta_from(
    kind: SourceKind,
    archive: &Path,
    from: u64,
    meta: &mut FileMeta,
) -> Result<bool> {
    let p = provider(kind);
    let mut f = File::open(archive)?;
    f.seek(SeekFrom::Start(from))?;
    for line in read_lines_from(BufReader::new(f), 1) {
        if let (_, Some(v)) = line?
            && p.observe_meta(meta, &v)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// File meta observed from the whole archive.
#[cfg(test)]
pub fn read_meta(kind: SourceKind, archive: &Path, rel_path: &str) -> Result<FileMeta> {
    let mut meta = initial_meta(kind, rel_path);
    observe_meta_from(kind, archive, 0, &mut meta)?;
    Ok(meta)
}

/// Parses exchanges starting at the reparse point `from`.
pub fn parse_from(
    kind: SourceKind,
    archive: &Path,
    from: ReparsePoint,
    meta: &FileMeta,
) -> Result<ParseOutput> {
    parse_exchanges(provider(kind), archive, from, meta)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_lines_from_start_keep_physical_numbers() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join("a.jsonl");
        std::fs::write(&p, "{\"a\":1}\n{not json\n\n{\"a\":4}\n").unwrap();
        let got: Vec<_> = read_file_lines_from(&p, 2)
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(got, vec![(2, None), (4, Some(serde_json::json!({"a": 4})))]);
    }
}
