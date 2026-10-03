use anyhow::Result;
use rusqlite::Connection;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum QueryToken {
    Term(String),
    Prefix(String),
}

fn is_syllable(c: char) -> bool {
    ('\u{AC00}'..='\u{D7A3}').contains(&c)
}

/// Rewrites Hangul syllable runs into overlapping bigrams padded with spaces.
/// Single-syllable runs and all other characters are kept as-is.
pub fn to_terms(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    let mut run: Vec<char> = Vec::new();
    let flush = |run: &mut Vec<char>, out: &mut String| {
        match run.len() {
            0 => {}
            1 => out.push(run[0]),
            _ => {
                out.push(' ');
                for (i, w) in run.windows(2).enumerate() {
                    if i > 0 {
                        out.push(' ');
                    }
                    out.push(w[0]);
                    out.push(w[1]);
                }
                out.push(' ');
            }
        }
        run.clear();
    };
    for c in text.chars() {
        if is_syllable(c) {
            run.push(c);
        } else {
            flush(&mut run, &mut out);
            out.push(c);
        }
    }
    flush(&mut run, &mut out);
    out
}

pub fn query_tokens(query: &str) -> Vec<QueryToken> {
    to_terms(query)
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| {
            let t = t.to_lowercase();
            let mut chars = t.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) if is_syllable(c) => QueryToken::Prefix(t),
                _ => QueryToken::Term(t),
            }
        })
        .collect()
}

fn quote(t: &str) -> String {
    format!("\"{}\"", t.replace('"', "\"\""))
}

/// Builds an FTS5 MATCH expression (OR of quoted tokens), dropping tokens that
/// appear in more than 20% of exchanges. Returns None when there are no tokens.
/// Doc counts come from a per-token MATCH count, so the FTS tokenizer (porter)
/// is applied for us.
pub fn build_match_query(conn: &Connection, query: &str) -> Result<Option<String>> {
    let mut tokens = query_tokens(query);
    let mut seen = std::collections::HashSet::new();
    tokens.retain(|t| seen.insert(t.clone()));
    if tokens.is_empty() {
        return Ok(None);
    }
    let total: i64 = conn.query_row("SELECT count(*) FROM exchanges", [], |r| r.get(0))?;
    let mut stmt =
        conn.prepare("SELECT count(*) FROM fts_exchanges WHERE fts_exchanges MATCH ?1")?;
    let mut kept: Vec<String> = Vec::new();
    let mut counted: Vec<(String, i64)> = Vec::new();
    for t in &tokens {
        let (expr, is_prefix) = match t {
            QueryToken::Term(s) => (quote(s), false),
            QueryToken::Prefix(s) => (format!("{}*", quote(s)), true),
        };
        if is_prefix || total == 0 {
            kept.push(expr);
            continue;
        }
        let doc: i64 = stmt.query_row([&expr], |r| r.get(0))?;
        if (doc as f64) <= total as f64 * 0.2 {
            kept.push(expr);
        } else {
            counted.push((expr, doc));
        }
    }
    if kept.is_empty() {
        if let Some((expr, _)) = counted.into_iter().min_by_key(|(_, d)| *d) {
            kept.push(expr);
        }
    }
    Ok(Some(kept.join(" OR ")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, NewExchange};

    fn norm(s: String) -> String {
        s.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn to_terms_cases() {
        assert_eq!(norm(to_terms("검색추천")), "검색 색추 추천");
        assert_eq!(norm(to_terms("API검색")), "API 검색");
        assert_eq!(norm(to_terms("가 나")), "가 나");
        assert_eq!(norm(to_terms("sync 버그를")), "sync 버그 그를");
    }

    #[test]
    fn query_tokens_kinds() {
        assert_eq!(
            query_tokens("검 Foo"),
            vec![
                QueryToken::Prefix("검".into()),
                QueryToken::Term("foo".into())
            ]
        );
        assert_eq!(query_tokens("추천"), vec![QueryToken::Term("추천".into())]);
        assert!(query_tokens("   ").is_empty());
    }

    fn setup(docs: &[String]) -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let mut c = db::open(&dir.path().join("t.db")).unwrap();
        let tx = c.transaction().unwrap();
        for (i, d) in docs.iter().enumerate() {
            let e = NewExchange {
                archive_path: "a".into(),
                line_start: i as i64 + 1,
                line_end: i as i64 + 1,
                session_id: None,
                project: "p".into(),
                harness: "claude".into(),
                is_sidechain: false,
                ts: 0,
                user_message: d.clone(),
                assistant_message: String::new(),
                tool_names: String::new(),
            };
            db::insert_exchange(&tx, &e, &to_terms(d)).unwrap();
        }
        tx.commit().unwrap();
        (dir, c)
    }

    fn run(c: &Connection, m: &str) -> Vec<i64> {
        let mut s = c
            .prepare("SELECT rowid FROM fts_exchanges WHERE fts_exchanges MATCH ?1 ORDER BY rowid")
            .unwrap();
        s.query_map([m], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    #[test]
    fn fts_roundtrip() {
        let (_d, c) = setup(&["검색추천 기능".into(), "API검색 수정".into()]);
        let q = |s: &str| build_match_query(&c, s).unwrap().unwrap();
        assert_eq!(run(&c, &q("추천")), vec![1]);
        assert_eq!(run(&c, &q("검색")), vec![1, 2]);
        assert_eq!(run(&c, &q("검")), vec![1, 2]);
        let m = q("C++ foo-bar a:b \"x\"");
        run(&c, &m);
        assert_eq!(build_match_query(&c, "   ").unwrap(), None);
    }

    #[test]
    fn common_tokens_dropped() {
        let mut docs: Vec<String> = (0..9).map(|i| format!("합니다 항목{i}")).collect();
        docs.push("추천 기능".into());
        let (_d, c) = setup(&docs);
        let m = build_match_query(&c, "합니다 추천").unwrap().unwrap();
        assert!(!m.contains("니다"), "{m}");
        assert!(m.contains("\"추천\""), "{m}");
        // every token common -> keep exactly one
        let m = build_match_query(&c, "합니다").unwrap().unwrap();
        assert!(!m.contains(" OR "), "{m}");
        assert!(!m.is_empty());
    }
}
