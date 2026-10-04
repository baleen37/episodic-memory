use super::{
    FileMeta, ParsedExchange, Provider, render_result, render_text, render_tool, value_text,
};
use serde_json::Value;

/// `response_item` user messages that are injected context, not human input
/// (only consulted for the `response_item` fallback signal).
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

/// Provider adapter for Codex session transcripts.
pub(crate) struct Codex;

/// User signals, weakest first: an archive uses the strongest one any of its lines shows.
const SIGNALS: [&str; 3] = ["response_item", "user_message", "item_completed"];

fn raise_signal(meta: &mut FileMeta, signal: &str) {
    let rank = |s: Option<&str>| SIGNALS.iter().position(|x| Some(*x) == s);
    if rank(Some(signal)) > rank(meta.user_signal.as_deref()) {
        meta.user_signal = Some(signal.to_string());
    }
}

impl Provider for Codex {
    fn initial_meta(&self, _archive_path: &str) -> FileMeta {
        FileMeta {
            user_signal: Some(SIGNALS[0].to_string()),
            ..FileMeta::default()
        }
    }

    fn observe_meta(&self, meta: &mut FileMeta, v: &Value) -> bool {
        // A fork copies its parent's lines after its own header, so the first header wins.
        if !meta.sidechain_known && v["type"] == "session_meta" {
            meta.sidechain_known = true;
            let p = &v["payload"];
            meta.session_id = p["id"].as_str().map(String::from);
            meta.cwd = p["cwd"].as_str().map(String::from);
            let sub = &p["source"]["subagent"];
            if !sub.is_null() {
                meta.is_sidechain = true;
                meta.agent_path = sub["thread_spawn"]["agent_path"].as_str().map(String::from);
            }
        }
        if is_item_completed_user(v) {
            raise_signal(meta, "item_completed");
        } else if v["type"] == "event_msg" && v["payload"]["type"] == "user_message" {
            raise_signal(meta, "user_message");
        }
        meta.sidechain_known && meta.user_signal.as_deref() == Some("item_completed")
    }

    fn start_message(&self, v: &Value, meta: &FileMeta) -> Option<String> {
        start_text(v, meta)
    }

    fn fold_line(&self, exchange: &mut ParsedExchange, v: &Value) {
        add_answer_and_tools(exchange, v);
    }

    fn render_line(&self, v: &Value) -> Vec<String> {
        render_line(v)
    }
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
    let p = &v["payload"];
    if v["type"] == "event_msg" && p["type"] == "agent_message" {
        // Duplicated by a `response_item` answer unless the user interrupted the turn.
        if let Some(t) = p["message"].as_str().filter(|t| !t.is_empty()) {
            if !c.fallback_answer.is_empty() {
                c.fallback_answer.push_str("\n\n");
            }
            c.fallback_answer.push_str(t);
        }
        return;
    }
    if v["type"] != "response_item" {
        return;
    }
    match p["type"].as_str() {
        Some("message") if p["role"] == "assistant" => {
            if let Some(t) = block_texts(&p["content"], &["output_text"], "\n\n") {
                c.push_answer(&t);
            }
        }
        Some("function_call" | "custom_tool_call") => {
            if let Some(name) = p["name"].as_str() {
                c.push_tool(name);
            }
        }
        Some("local_shell_call") => c.push_tool(LOCAL_SHELL),
        _ => {}
    }
}

/// Renders `response_item` lines only; `event_msg` duplicates them.
fn render_line(v: &Value) -> Vec<String> {
    if v["type"] != "response_item" {
        return Vec::new();
    }
    let p = &v["payload"];
    let text = |role: &str, kind: &str| {
        block_texts(&p["content"], &[kind], "\n\n")
            .map(|t| vec![render_text(role, &t)])
            .unwrap_or_default()
    };
    let tool = |name: &str, input: &Value| vec![render_tool(name, &value_text(input))];
    match p["type"].as_str() {
        Some("message") if p["role"] == "user" => text("User", "input_text"),
        Some("message") if p["role"] == "assistant" => text("Assistant", "output_text"),
        Some("function_call") => tool(p["name"].as_str().unwrap_or("?"), &p["arguments"]),
        Some("custom_tool_call") => tool(p["name"].as_str().unwrap_or("?"), &p["input"]),
        Some("local_shell_call") => tool(LOCAL_SHELL, &p["action"]),
        Some("function_call_output" | "custom_tool_call_output") => {
            vec![render_result(&value_text(&p["output"]))]
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use crate::parse::{DO_NOT_INDEX, ParseOutput, parse_from, read_meta};
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
        assert_eq!(e[0].ts, 1_767_323_045_000);
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
             {{\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{{\"type\":\"output_text\",\"text\":\"ok\"}}]}}}}\n\
             not json\n"
        );
        std::fs::write(&p, content).unwrap();
        let (meta, out) = parse(p.to_str().unwrap(), 1);
        assert_eq!(meta.user_signal.as_deref(), Some("user_message"));
        assert_eq!(out.exchanges.len(), 1);
        assert_eq!(out.exchanges[0].line_end, 5);
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

    #[test]
    fn interrupted_turn_keeps_streamed_answer_and_drops_silent_turn() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("r.jsonl");
        let user = |t: &str| {
            format!(
                "{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\",\"message\":\"{t}\"}}}}\n"
            )
        };
        let streamed = |t: &str| {
            format!(
                "{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"agent_message\",\"message\":\"{t}\"}}}}\n"
            )
        };
        let answer = |t: &str| {
            format!(
                "{{\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{{\"type\":\"output_text\",\"text\":\"{t}\"}}]}}}}\n"
            )
        };
        let content = [
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"x\"}}\n".to_string(),
            user("go"),
            streamed("starting"), // interrupted: no response_item answer follows
            user("silent"),       // interrupted before any output
            user("again"),
            streamed("done"),
            answer("done"),
            user("open"), // the turn still running
        ]
        .concat();
        std::fs::write(&p, content).unwrap();
        let (_, out) = parse(p.to_str().unwrap(), 1);
        let got: Vec<_> = out
            .exchanges
            .iter()
            .map(|e| (e.user_message.as_str(), e.assistant_message.as_str()))
            .collect();
        assert_eq!(got, [("go", "starting"), ("again", "done")]);
    }
}
