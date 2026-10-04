#[cfg(test)]
use super::ParseOutput;
use super::{
    render_result, render_text, render_tool, value_text, FileMeta, ParsedExchange, Provider,
};
use serde_json::Value;
use std::path::Path;

/// User messages that never start (and never break) an exchange.
struct Exclusions;

impl Exclusions {
    const TEXT_PREFIXES: [&'static str; 6] = [
        "[Request interrupted by user",
        "<local-command-",
        "<bash-stdout>",
        "<bash-stderr>",
        "<teammate-message",
        "Another Claude session sent a message:",
    ];

    fn excludes(v: &Value, text: &str) -> bool {
        if v["isMeta"].as_bool() == Some(true) || v["isCompactSummary"].as_bool() == Some(true) {
            return true;
        }
        if let Some(kind) = v["origin"]["kind"].as_str() {
            if kind != "human" {
                return true;
            }
        }
        let t = text.trim_start();
        Self::TEXT_PREFIXES.iter().any(|p| t.starts_with(p))
    }
}

/// Text of a user start message, or None when the line cannot start an exchange.
fn start_text(v: &Value) -> Option<String> {
    if v["type"].as_str() != Some("user") {
        return None;
    }
    match &v["message"]["content"] {
        Value::String(s) => Some(s.clone()),
        Value::Array(blocks) => {
            let texts: Vec<&str> = blocks
                .iter()
                .filter(|b| b["type"].as_str() == Some("text"))
                .filter_map(|b| b["text"].as_str())
                .collect();
            (!texts.is_empty()).then(|| texts.join("\n"))
        }
        _ => None,
    }
}

/// Provider adapter for Claude Code transcripts.
pub(crate) struct ClaudeCode;

impl Provider for ClaudeCode {
    fn initial_meta(&self, archive_path: &str) -> FileMeta {
        FileMeta {
            is_sidechain: Path::new(archive_path)
                .components()
                .any(|c| c.as_os_str() == "subagents"),
            ..FileMeta::default()
        }
    }

    fn observe_meta(&self, meta: &mut FileMeta, v: &Value) -> bool {
        if meta.session_id.is_none() {
            meta.session_id = v["sessionId"].as_str().map(String::from);
        }
        if meta.cwd.is_none() {
            meta.cwd = v["cwd"].as_str().map(String::from);
        }
        if !meta.sidechain_known {
            if let Some(b) = v["isSidechain"].as_bool() {
                meta.sidechain_known = true;
                meta.is_sidechain |= b;
            }
        }
        meta.session_id.is_some() && meta.cwd.is_some() && meta.sidechain_known
    }

    fn start_message(&self, v: &Value, _meta: &FileMeta) -> Option<String> {
        start_text(v).filter(|t| !Exclusions::excludes(v, t))
    }

    fn fold_line(&self, exchange: &mut ParsedExchange, v: &Value) {
        add_answer_and_tools(exchange, v);
    }

    fn render_line(&self, v: &Value) -> Vec<String> {
        render_line(v)
    }
}

fn add_answer_and_tools(c: &mut ParsedExchange, v: &Value) {
    if v["type"].as_str() != Some("assistant") {
        return;
    }
    let Some(blocks) = v["message"]["content"].as_array() else {
        return;
    };
    for b in blocks {
        match b["type"].as_str() {
            Some("text") => {
                if let Some(t) = b["text"].as_str() {
                    c.push_answer(t);
                }
            }
            Some("tool_use") => {
                if let Some(name) = b["name"].as_str() {
                    c.push_tool(name);
                    // A subagent's final report arrives as this tool's input, not as text.
                    if name == "SubagentHandback" {
                        if let Some(t) = b["input"]["message"].as_str() {
                            c.push_answer(t);
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

fn result_text(content: &Value) -> String {
    match content {
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        other => value_text(other),
    }
}

fn render_line(v: &Value) -> Vec<String> {
    let role = match v["type"].as_str() {
        Some("user") => "User",
        Some("assistant") => "Assistant",
        _ => return Vec::new(),
    };
    match &v["message"]["content"] {
        Value::String(s) if !s.is_empty() => vec![render_text(role, s)],
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| match b["type"].as_str()? {
                "text" => b["text"]
                    .as_str()
                    .filter(|t| !t.is_empty())
                    .map(|t| render_text(role, t)),
                "tool_use" => Some(render_tool(
                    b["name"].as_str().unwrap_or("?"),
                    &b["input"].to_string(),
                )),
                "tool_result" => Some(render_result(&result_text(&b["content"]))),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::read_lines;
    use crate::paths::SourceKind;
    use std::io::BufReader;

    const K: SourceKind = SourceKind::ClaudeCodeProjects;
    const MAIN: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/claude/main.jsonl"
    );
    const NOISE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/claude/noise.jsonl"
    );
    const SUB: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/claude/subagent.jsonl"
    );

    fn parse(path: &str, from: i64) -> ParseOutput {
        let p = Path::new(path);
        let meta = crate::parse::read_meta(K, p, "proj/s.jsonl").unwrap();
        crate::parse::parse_from(K, p, from, &meta).unwrap()
    }

    #[test]
    fn main_fixture_exchanges() {
        let out = parse(MAIN, 1);
        assert_eq!(out.exchanges.len(), 3);
        assert_eq!(out.bad_lines, 0);
        assert!(!out.do_not_index);
        let e = &out.exchanges;
        assert_eq!((e[0].line_start, e[0].line_end), (1, 2));
        assert_eq!((e[1].line_start, e[1].line_end), (3, 8));
        assert_eq!((e[2].line_start, e[2].line_end), (9, 10));
        assert_eq!(e[0].user_message, "Q1 how do I list files?");
        assert_eq!(e[1].user_message, "Q2 show the config");
        assert_eq!(e[1].tool_names, vec!["Bash", "Read"]);
        assert_eq!(e[1].assistant_message, "Let me look.\n\nSecond part.");
        assert_eq!(e[2].assistant_message, "A3 welcome.");
        assert_eq!(e[0].ts, 1767323045000);
    }

    #[test]
    fn parse_from_later_line() {
        let out = parse(MAIN, 3);
        assert_eq!(out.exchanges.len(), 2);
        assert_eq!(out.exchanges[0].line_start, 3);
    }

    #[test]
    fn noise_does_not_create_boundaries() {
        let out = parse(NOISE, 1);
        assert_eq!(out.exchanges.len(), 2);
        assert_eq!(out.bad_lines, 1);
        assert!(!out.do_not_index);
        assert_eq!(out.exchanges[0].user_message, "Real one");
        assert_eq!(
            (out.exchanges[0].line_start, out.exchanges[0].line_end),
            (2, 12)
        );
        assert_eq!(out.exchanges[0].assistant_message, "ok\n\ndone");
        assert_eq!(out.exchanges[1].line_start, 13);
    }

    #[test]
    fn subagent_handback_is_assistant_text() {
        let out = parse(SUB, 1);
        assert_eq!(out.exchanges.len(), 1);
        let e = &out.exchanges[0];
        assert_eq!(e.assistant_message, "Found it.\n\nSynthetic final report.");
        assert_eq!(e.tool_names, vec!["SubagentHandback"]);
        assert_eq!((e.line_start, e.line_end), (1, 3));
    }

    #[test]
    fn do_not_index_only_from_user_message() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.jsonl");
        let line = |t: &str, c: &str| format!(r#"{{"type":"{t}","message":{{"content":{c}}}}}"#);
        let marker = serde_json::to_string(crate::parse::DO_NOT_INDEX).unwrap();
        std::fs::write(&p, line("user", &marker) + "\n").unwrap();
        assert!(parse(p.to_str().unwrap(), 1).do_not_index);
    }

    #[test]
    fn meta_and_sidechain() {
        let m = crate::parse::read_meta(K, Path::new(MAIN), "proj/s.jsonl").unwrap();
        assert_eq!(m.session_id.as_deref(), Some("sess-main"));
        assert_eq!(m.cwd.as_deref(), Some("/work/demo"));
        assert!(!m.is_sidechain);
        assert!(m.agent_path.is_none() && m.user_signal.is_none());
        let s = crate::parse::read_meta(K, Path::new(SUB), "proj/s.jsonl").unwrap();
        assert!(s.is_sidechain);
        let by_path =
            crate::parse::read_meta(K, Path::new(MAIN), "x/subagents/agent-1.jsonl").unwrap();
        assert!(by_path.is_sidechain);
    }

    #[test]
    fn io_error_propagates() {
        struct Failing(bool);
        impl std::io::Read for Failing {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                if self.0 {
                    return Err(std::io::Error::other("boom"));
                }
                self.0 = true;
                let data = b"{\"type\":\"user\"}\n";
                buf[..data.len()].copy_from_slice(data);
                Ok(data.len())
            }
        }
        let mut it = read_lines(BufReader::new(Failing(false)));
        assert!(it.next().unwrap().is_ok());
        assert!(it.next().unwrap().is_err());
    }

    #[test]
    fn invalid_utf8_is_bad_line_not_error() {
        let items: Vec<_> = read_lines(&b"\xff\xfe\n{}\n"[..]).collect();
        assert!(matches!(items[0], Ok((1, None))));
        assert!(matches!(items[1], Ok((2, Some(_)))));
    }
}
