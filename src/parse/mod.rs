#![allow(dead_code)] // not yet used by main; wired in later tasks

use crate::paths::SourceKind;
use anyhow::Result;
use std::path::Path;

pub mod claude;

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

/// Reads file-level metadata from the head of the archive file.
pub fn read_meta(kind: SourceKind, archive: &Path, rel_path: &str) -> Result<FileMeta> {
    match kind {
        SourceKind::ClaudeCodeProjects | SourceKind::ClaudeCodeTranscripts => {
            claude::read_meta(archive, rel_path)
        }
        SourceKind::CodexSessions => anyhow::bail!("codex parser not implemented"),
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
        SourceKind::CodexSessions => anyhow::bail!("codex parser not implemented"),
    }
}
