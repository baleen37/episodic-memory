use super::{read_file_lines, ts_ms, FileMeta, ParseOutput, ParsedExchange, DO_NOT_INDEX};
use anyhow::Result;
use serde_json::Value;
use std::path::Path;

/// User messages that never start (and never break) an exchange.
struct Exclusions;

impl Exclusions {
    const TEXT_PREFIXES: [&'static str; 4] = [
        "[Request interrupted by user",
        "<local-command-",
        "<bash-stdout>",
        "<bash-stderr>",
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

pub fn read_meta(archive: &Path, rel_path: &str) -> Result<FileMeta> {
    let mut meta = FileMeta {
        is_sidechain: Path::new(rel_path)
            .components()
            .any(|c| c.as_os_str() == "subagents"),
        ..FileMeta::default()
    };
    let mut sidechain_seen = false;
    for line in read_file_lines(archive)? {
        let (_, v) = line?;
        let Some(v) = v else { continue };
        if meta.session_id.is_none() {
            meta.session_id = v["sessionId"].as_str().map(String::from);
        }
        if meta.cwd.is_none() {
            meta.cwd = v["cwd"].as_str().map(String::from);
        }
        if !sidechain_seen {
            if let Some(b) = v["isSidechain"].as_bool() {
                sidechain_seen = true;
                meta.is_sidechain |= b;
            }
        }
        if meta.session_id.is_some() && meta.cwd.is_some() && sidechain_seen {
            break;
        }
    }
    Ok(meta)
}

pub fn parse_from(archive: &Path, from_line: i64, _meta: &FileMeta) -> Result<ParseOutput> {
    let mut out = ParseOutput::default();
    let mut cur: Option<ParsedExchange> = None;
    for line in read_file_lines(archive)? {
        let (n, v) = line?;
        if n < from_line {
            continue;
        }
        let Some(v) = v else {
            out.bad_lines += 1;
            if let Some(c) = cur.as_mut() {
                c.line_end = n;
            }
            continue;
        };
        if let Some(text) = start_text(&v) {
            if !Exclusions::excludes(&v, &text) {
                out.exchanges.extend(cur.take());
                out.do_not_index |= text.contains(DO_NOT_INDEX);
                let ts = ts_ms(&v);
                cur = Some(ParsedExchange {
                    line_start: n,
                    line_end: n,
                    ts,
                    user_message: text,
                    assistant_message: String::new(),
                    tool_names: Vec::new(),
                });
                continue;
            }
        }
        let Some(c) = cur.as_mut() else { continue };
        c.line_end = n;
        if v["type"].as_str() != Some("assistant") {
            continue;
        }
        let Some(blocks) = v["message"]["content"].as_array() else {
            continue;
        };
        for b in blocks {
            match b["type"].as_str() {
                Some("text") => {
                    if let Some(t) = b["text"].as_str() {
                        if !c.assistant_message.is_empty() {
                            c.assistant_message.push_str("\n\n");
                        }
                        c.assistant_message.push_str(t);
                    }
                }
                Some("tool_use") => {
                    if let Some(name) = b["name"].as_str() {
                        if !c.tool_names.iter().any(|t| t == name) {
                            c.tool_names.push(name.to_string());
                        }
                    }
                }
                _ => {}
            }
        }
    }
    out.exchanges.extend(cur);
    Ok(out)
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
            (2, 10)
        );
        assert_eq!(out.exchanges[1].line_start, 11);
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
