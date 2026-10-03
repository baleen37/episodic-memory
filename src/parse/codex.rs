use super::{
    read_file_lines, truncate_bytes, ts_ms, FileMeta, ParseOutput, ParsedExchange, DO_NOT_INDEX,
    TEXT_MAX, TOOL_MAX,
};
use anyhow::Result;
use serde_json::Value;
use std::path::Path;

/// `response_item` user messages that are injected context, not human input
/// (only consulted for the "response_item" fallback signal).
const INJECTED_PREFIXES: [&str; 6] = [
    "# AGENTS.md instructions",
    "<environment_context>",
    "<codex_internal_context>",
    "<user_instructions>",
    "<recommended_plugins>",
    "<skill>",
];

/// Tool name recorded for `local_shell_call`, which carries no `name`.
const LOCAL_SHELL: &str = "local_shell";

/// Joins non-empty `field` strings of the content blocks whose `type` is in `types`.
fn block_texts(blocks: &Value, types: &[&str], sep: &str) -> Option<String> {
    let texts: Vec<&str> = blocks
        .as_array()?
        .iter()
        .filter(|b| b["type"].as_str().is_some_and(|t| types.contains(&t)))
        .filter_map(|b| b["text"].as_str())
        .collect();
    (!texts.is_empty()).then(|| texts.join(sep))
}

fn is_item_completed_user(v: &Value) -> bool {
    v["type"] == "event_msg"
        && v["payload"]["type"] == "item_completed"
        && v["payload"]["item"]["type"] == "UserMessage"
}

pub fn read_meta(archive: &Path) -> Result<FileMeta> {
    let mut meta = FileMeta::default();
    let mut seen_meta = false;
    let (mut has_user_message, mut has_item_completed) = (false, false);
    for line in read_file_lines(archive)? {
        let (_, v) = line?;
        let Some(v) = v else { continue };
        if !seen_meta && v["type"] == "session_meta" {
            seen_meta = true;
            let p = &v["payload"];
            meta.session_id = p["id"].as_str().map(String::from);
            meta.cwd = p["cwd"].as_str().map(String::from);
            let sub = &p["source"]["subagent"];
            if !sub.is_null() {
                meta.is_sidechain = true;
                meta.agent_path = sub["thread_spawn"]["agent_path"].as_str().map(String::from);
            }
        }
        if is_item_completed_user(&v) {
            has_item_completed = true;
            if seen_meta {
                break;
            }
        } else if v["type"] == "event_msg" && v["payload"]["type"] == "user_message" {
            has_user_message = true;
        }
    }
    let signal = if has_item_completed {
        "item_completed"
    } else if has_user_message {
        "user_message"
    } else {
        "response_item"
    };
    meta.user_signal = Some(signal.to_string());
    Ok(meta)
}

/// Text of an exchange-starting line, or None when the line does not start one.
fn start_text(v: &Value, meta: &FileMeta) -> Option<String> {
    let p = &v["payload"];
    if let Some(agent_path) = &meta.agent_path {
        // Subagent files: only messages addressed to this agent start exchanges.
        return (v["type"] == "response_item"
            && p["type"] == "agent_message"
            && p["recipient"].as_str() == Some(agent_path))
        .then(|| block_texts(&p["content"], &["input_text"], "\n"))
        .flatten();
    }
    match meta.user_signal.as_deref() {
        Some("item_completed") => is_item_completed_user(v)
            .then(|| block_texts(&p["item"]["content"], &["text"], "\n"))
            .flatten(),
        Some("user_message") => (v["type"] == "event_msg" && p["type"] == "user_message")
            .then(|| p["message"].as_str().map(String::from))
            .flatten(),
        _ => {
            if v["type"] != "response_item" || p["type"] != "message" || p["role"] != "user" {
                return None;
            }
            let text = block_texts(&p["content"], &["input_text"], "\n")?;
            let t = text.trim_start();
            (!INJECTED_PREFIXES.iter().any(|x| t.starts_with(x))).then_some(text)
        }
    }
}

fn add_answer_and_tools(c: &mut ParsedExchange, v: &Value) {
    if v["type"] != "response_item" {
        return;
    }
    let p = &v["payload"];
    match p["type"].as_str() {
        Some("message") if p["role"] == "assistant" => {
            if let Some(t) = block_texts(&p["content"], &["output_text"], "\n\n") {
                if !c.assistant_message.is_empty() {
                    c.assistant_message.push_str("\n\n");
                }
                c.assistant_message.push_str(&t);
            }
        }
        Some("function_call" | "custom_tool_call") => {
            if let Some(name) = p["name"].as_str() {
                push_tool(c, name);
            }
        }
        Some("local_shell_call") => push_tool(c, LOCAL_SHELL),
        _ => {}
    }
}

fn push_tool(c: &mut ParsedExchange, name: &str) {
    if !c.tool_names.iter().any(|t| t == name) {
        c.tool_names.push(name.to_string());
    }
}

pub fn parse_from(archive: &Path, from_line: i64, meta: &FileMeta) -> Result<ParseOutput> {
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
        if let Some(text) = start_text(&v, meta) {
            out.exchanges.extend(cur.take());
            out.do_not_index |= text.contains(DO_NOT_INDEX);
            cur = Some(ParsedExchange {
                line_start: n,
                line_end: n,
                ts: ts_ms(&v),
                user_message: text,
                assistant_message: String::new(),
                tool_names: Vec::new(),
            });
            continue;
        }
        let Some(c) = cur.as_mut() else { continue };
        c.line_end = n;
        add_answer_and_tools(c, &v);
    }
    out.exchanges.extend(cur);
    Ok(out)
}

/// Renders `response_item` lines only; `event_msg` duplicates them.
pub fn render_line(v: &Value) -> Vec<String> {
    if v["type"] != "response_item" {
        return Vec::new();
    }
    let p = &v["payload"];
    let text = |role: &str, kind: &str| {
        block_texts(&p["content"], &[kind], "\n\n")
            .map(|t| vec![format!("**{role}:** {}", truncate_bytes(&t, TEXT_MAX))])
            .unwrap_or_default()
    };
    let tool = |name: &str, input: String| {
        vec![format!(
            "**Tool {name}:** {}",
            truncate_bytes(&input, TOOL_MAX)
        )]
    };
    let as_text = |x: &Value| match x {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    };
    match p["type"].as_str() {
        Some("message") if p["role"] == "user" => text("User", "input_text"),
        Some("message") if p["role"] == "assistant" => text("Assistant", "output_text"),
        Some("function_call") => tool(p["name"].as_str().unwrap_or("?"), as_text(&p["arguments"])),
        Some("custom_tool_call") => tool(p["name"].as_str().unwrap_or("?"), as_text(&p["input"])),
        Some("local_shell_call") => tool(LOCAL_SHELL, as_text(&p["action"])),
        Some("function_call_output" | "custom_tool_call_output") => vec![format!(
            "**Result:** {}",
            truncate_bytes(&as_text(&p["output"]), TOOL_MAX)
        )],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use crate::parse::{parse_from, read_meta, ParseOutput, DO_NOT_INDEX};
    use crate::paths::SourceKind;
    use std::path::Path;

    const K: SourceKind = SourceKind::CodexSessions;

    fn fx(name: &str) -> String {
        format!(
            "{}/tests/fixtures/codex/{name}.jsonl",
            env!("CARGO_MANIFEST_DIR")
        )
    }

    fn parse(path: &str, from: i64) -> (crate::parse::FileMeta, ParseOutput) {
        let p = Path::new(path);
        let meta = read_meta(K, p, "2026/01/02/rollout.jsonl").unwrap();
        let out = parse_from(K, p, from, &meta).unwrap();
        (meta, out)
    }

    #[test]
    fn modern_uses_item_completed_only() {
        let (meta, out) = parse(&fx("modern"), 1);
        assert_eq!(meta.session_id.as_deref(), Some("codex-modern"));
        assert_eq!(meta.cwd.as_deref(), Some("/work/demo"));
        assert_eq!(meta.user_signal.as_deref(), Some("item_completed"));
        assert!(!meta.is_sidechain && meta.agent_path.is_none());
        let e = &out.exchanges;
        assert_eq!(e.len(), 2);
        assert_eq!((e[0].line_start, e[0].line_end), (3, 8));
        assert_eq!((e[1].line_start, e[1].line_end), (9, 16));
        assert_eq!(e[0].user_message, "Q1 how do I list files?");
        assert_eq!(e[0].assistant_message, "Use ls.");
        assert_eq!(e[0].tool_names, vec!["exec"]);
        assert_eq!(e[1].tool_names, vec!["apply_patch", "exec"]);
        assert_eq!(e[1].assistant_message, "Looking.\n\nHere it is.");
        assert_eq!(e[0].ts, 1767323045000);
        assert_eq!(out.bad_lines, 0);
        assert!(!out.do_not_index);
    }

    #[test]
    fn parse_from_later_line() {
        let (_, out) = parse(&fx("modern"), 9);
        assert_eq!(out.exchanges.len(), 1);
        assert_eq!(out.exchanges[0].line_start, 9);
    }

    #[test]
    fn legacy_falls_back_to_response_items_without_injections() {
        let (meta, out) = parse(&fx("legacy"), 1);
        assert_eq!(meta.user_signal.as_deref(), Some("response_item"));
        let e = &out.exchanges;
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].user_message, "Old Q1 hello");
        assert_eq!((e[0].line_start, e[0].line_end), (4, 9));
        assert_eq!(e[0].tool_names, vec!["shell", "local_shell"]);
        assert_eq!(e[0].assistant_message, "Old A1");
        assert_eq!(e[1].user_message, "Old Q2 again");
    }

    #[test]
    fn subagent_starts_at_own_agent_message() {
        let (meta, out) = parse(&fx("subagent"), 1);
        assert!(meta.is_sidechain);
        assert_eq!(meta.agent_path.as_deref(), Some("/root/reviewer"));
        let e = &out.exchanges;
        assert_eq!(e.len(), 1);
        assert_eq!(e[0].user_message, "Review the parser");
        assert_eq!(e[0].line_start, 4);
        assert_eq!(e[0].tool_names, vec!["exec"]);
        assert_eq!(e[0].assistant_message, "Review done.");
    }

    #[test]
    fn fork_uses_first_session_meta() {
        let (meta, out) = parse(&fx("fork"), 1);
        assert_eq!(meta.session_id.as_deref(), Some("codex-fork"));
        assert_eq!(meta.cwd.as_deref(), Some("/work/demo"));
        assert_eq!(out.exchanges.len(), 1);
        assert_eq!(out.exchanges[0].user_message, "Fork Q1");
    }

    #[test]
    fn user_message_event_signal_and_do_not_index() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("r.jsonl");
        let marker = serde_json::to_string(DO_NOT_INDEX).unwrap();
        let content = format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"x\"}}}}\n\
             {{\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\",\"message\":{marker}}}}}\n\
             {{\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"type\":\"input_text\",\"text\":\"ignored\"}}]}}}}\n\
             not json\n"
        );
        std::fs::write(&p, content).unwrap();
        let (meta, out) = parse(p.to_str().unwrap(), 1);
        assert_eq!(meta.user_signal.as_deref(), Some("user_message"));
        assert_eq!(out.exchanges.len(), 1);
        assert_eq!(out.exchanges[0].line_end, 4);
        assert_eq!(out.bad_lines, 1);
        assert!(out.do_not_index);
        assert_eq!(out.exchanges[0].ts, 0);
    }

    #[test]
    fn do_not_index_ignores_assistant_text() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("r.jsonl");
        let marker = serde_json::to_string(DO_NOT_INDEX).unwrap();
        let content = format!(
            "{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"item_completed\",\"item\":{{\"type\":\"UserMessage\",\"content\":[{{\"text\":\"hi\"}}]}}}}}}\n\
             {{\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{{\"type\":\"output_text\",\"text\":{marker}}}]}}}}\n"
        );
        std::fs::write(&p, content).unwrap();
        assert!(!parse(p.to_str().unwrap(), 1).1.do_not_index);
    }
}
