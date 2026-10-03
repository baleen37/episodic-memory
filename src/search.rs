use crate::embed::Embedder;
use crate::terms::build_match_query;
use anyhow::{bail, Result};
use chrono::{Days, Duration, Local, NaiveDate, TimeZone};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection};
use std::collections::{HashMap, HashSet};

const MAX_LIMIT: usize = 50;
const SNIPPET_CHARS: usize = 200;
/// Candidates fetched per side (BM25 and vector) for each concept of an array query.
const MULTI_CONCEPT_CANDIDATES: usize = 300;

#[derive(Debug, Clone, Default)]
pub struct SearchParams {
    pub queries: Vec<String>,
    pub limit: usize,
    pub after: Option<NaiveDate>,
    pub before: Option<NaiveDate>,
    pub project: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub exchange_id: i64,
    pub project: String,
    pub ts: i64,
    pub score: f64,
    pub user_snippet: String,
    pub assistant_snippet: String,
    pub archive_path: String,
    pub line_start: i64,
    pub line_end: i64,
}

#[derive(Debug, Clone, Default)]
pub struct SearchOutput {
    pub hits: Vec<Hit>,
    pub vector_used: bool,
}

/// Reciprocal-rank fusion: `0.4/(60+r_bm25) + 0.6/(60+r_vec)` with 1-based ranks, a missing
/// side adding nothing, plus a BM25 top-rank bonus (+0.01 / +0.005 / +0.0025 for ranks 1-3)
/// so an exact keyword hit outranks a vector-only rank-1 hit, then sidechain ids scaled by 0.9. Sorted by score desc, ties newer id first.
pub fn rrf(bm25: &[i64], vec: &[i64], sidechain: &HashSet<i64>) -> Vec<(i64, f64)> {
    let mut scores: HashMap<i64, f64> = HashMap::new();
    for (i, id) in bm25.iter().enumerate() {
        let bonus = match i {
            0 => 0.01,
            1 => 0.005,
            2 => 0.0025,
            _ => 0.0,
        };
        *scores.entry(*id).or_default() += 0.4 / (60.0 + (i + 1) as f64) + bonus;
    }
    for (i, id) in vec.iter().enumerate() {
        *scores.entry(*id).or_default() += 0.6 / (60.0 + (i + 1) as f64);
    }
    let mut out: Vec<(i64, f64)> = scores
        .into_iter()
        .map(|(id, s)| (id, if sidechain.contains(&id) { s * 0.9 } else { s }))
        .collect();
    out.sort_by(|a, b| b.1.total_cmp(&a.1).then(b.0.cmp(&a.0)));
    out
}

/// Metadata filters as (ts lower bound inclusive, ts upper bound exclusive, project).
struct Filters {
    project: Option<String>,
    ts_from: Option<i64>,
    ts_to: Option<i64>,
}

impl Filters {
    /// Date bounds are midnights of `tz`: `after` is that day's 00:00, `before` the next day's.
    /// A skipped midnight resolves to the first valid 15-minute step within 3 hours, else UTC midnight.
    fn new_in<Tz: TimeZone>(p: &SearchParams, tz: &Tz) -> Filters {
        let day_ms = |d: NaiveDate| {
            let midnight = d.and_hms_opt(0, 0, 0).unwrap();
            // A DST gap can skip local midnight: use the first valid instant of that day.
            (0..=12)
                .find_map(|step| {
                    let t = midnight + Duration::minutes(15 * step);
                    tz.from_local_datetime(&t).earliest()
                })
                .map_or_else(
                    || midnight.and_utc().timestamp_millis(),
                    |t| t.timestamp_millis(),
                )
        };
        Filters {
            project: p.project.clone(),
            ts_from: p.after.map(day_ms),
            ts_to: p
                .before
                .map(|d| day_ms(d.checked_add_days(Days::new(1)).unwrap_or(d))),
        }
    }

    /// SQL conditions (each prefixed with " AND ") on `col_prefix`-qualified columns, and their params.
    fn sql(&self, col_prefix: &str) -> (String, Vec<SqlValue>) {
        let mut sql = String::new();
        let mut params = Vec::new();
        if let Some(p) = &self.project {
            sql.push_str(&format!(" AND {col_prefix}project = ?"));
            params.push(SqlValue::Text(p.clone()));
        }
        if let Some(t) = self.ts_from {
            sql.push_str(&format!(" AND {col_prefix}ts >= ?"));
            params.push(SqlValue::Integer(t));
        }
        if let Some(t) = self.ts_to {
            sql.push_str(&format!(" AND {col_prefix}ts < ?"));
            params.push(SqlValue::Integer(t));
        }
        (sql, params)
    }
}

fn ids(conn: &Connection, sql: &str, params: Vec<SqlValue>) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params_from_iter(params), |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn bm25_ids(conn: &Connection, query: &str, f: &Filters, n: usize) -> Result<Vec<i64>> {
    let Some(m) = build_match_query(conn, query)? else {
        return Ok(Vec::new());
    };
    let (cond, mut params) = f.sql("e.");
    params.insert(0, SqlValue::Text(m));
    params.push(SqlValue::Integer(n as i64));
    ids(
        conn,
        &format!(
            "SELECT e.id FROM fts_exchanges JOIN exchanges e ON e.id = fts_exchanges.rowid
             WHERE fts_exchanges MATCH ?{cond} ORDER BY bm25(fts_exchanges) LIMIT ?"
        ),
        params,
    )
}

fn vec_ids(
    conn: &Connection,
    e: &dyn Embedder,
    query: &str,
    f: &Filters,
    n: usize,
) -> Result<Vec<i64>> {
    let bytes: Vec<u8> = e
        .embed_query(query)?
        .iter()
        .flat_map(|x| x.to_le_bytes())
        .collect();
    let (cond, mut params) = f.sql("");
    params.insert(0, SqlValue::Integer(n as i64));
    params.insert(0, SqlValue::Blob(bytes));
    ids(
        conn,
        &format!(
            "SELECT rowid FROM vec_exchanges WHERE embedding MATCH ? AND k = ?{cond} ORDER BY distance"
        ),
        params,
    )
}

fn sidechain_set(conn: &Connection, all: &[&[i64]]) -> Result<HashSet<i64>> {
    let mut stmt = conn.prepare("SELECT is_sidechain FROM exchanges WHERE id = ?")?;
    let mut out = HashSet::new();
    for id in all.iter().flat_map(|s| s.iter()) {
        let side: Option<i64> = stmt.query_row([id], |r| r.get(0)).ok();
        if side == Some(1) {
            out.insert(*id);
        }
    }
    Ok(out)
}

/// One concept's fused ranking (best first), cut to `limit`.
/// `n` candidates are fetched per side.
fn concept(
    conn: &Connection,
    e: Option<&dyn Embedder>,
    query: &str,
    f: &Filters,
    limit: usize,
    n: usize,
) -> Result<Vec<(i64, f64)>> {
    let bm = bm25_ids(conn, query, f, n)?;
    let ve = match e {
        Some(e) => vec_ids(conn, e, query, f, n)?,
        None => Vec::new(),
    };
    let side = sidechain_set(conn, &[&bm, &ve])?;
    let mut ranked = rrf(&bm, &ve, &side);
    ranked.truncate(limit);
    Ok(ranked)
}

fn load_hit(conn: &Connection, id: i64, score: f64) -> Result<Hit> {
    let snippet = |s: String| s.chars().take(SNIPPET_CHARS).collect::<String>();
    Ok(conn.query_row(
        "SELECT project, ts, user_message, assistant_message, archive_path, line_start, line_end
         FROM exchanges WHERE id = ?",
        [id],
        |r| {
            Ok(Hit {
                exchange_id: id,
                project: r.get(0)?,
                ts: r.get(1)?,
                score,
                user_snippet: snippet(r.get(2)?),
                assistant_snippet: snippet(r.get(3)?),
                archive_path: r.get(4)?,
                line_start: r.get(5)?,
                line_end: r.get(6)?,
            })
        },
    )?)
}

fn archive_path_of(conn: &Connection, id: i64) -> Result<String> {
    Ok(conn.query_row(
        "SELECT archive_path FROM exchanges WHERE id = ?",
        [id],
        |r| r.get(0),
    )?)
}

pub fn search(
    conn: &Connection,
    e: Option<&dyn Embedder>,
    p: &SearchParams,
) -> Result<SearchOutput> {
    search_in(conn, e, p, &Local)
}

/// `search` with date filters interpreted in `tz`.
fn search_in<Tz: TimeZone>(
    conn: &Connection,
    e: Option<&dyn Embedder>,
    p: &SearchParams,
    tz: &Tz,
) -> Result<SearchOutput> {
    if p.queries.is_empty() || p.queries.len() > 5 {
        bail!("query must be 1 to 5 strings");
    }
    let limit = p.limit.clamp(1, MAX_LIMIT);
    let f = Filters::new_in(p, tz);
    // The vector side runs whenever an embedder is present, unless a query is pure noise.
    if p.queries
        .iter()
        .any(|q| !q.chars().any(|c| c.is_alphanumeric()))
    {
        return Ok(SearchOutput::default());
    }
    let vector_used = e.is_some();

    // (exchange id, score) best first, already normalized by the caller below.
    let ranked: Vec<(i64, f64)> = if p.queries.len() == 1 {
        concept(conn, e, &p.queries[0], &f, limit, 50.max(limit * 3))?
    } else {
        let n = MULTI_CONCEPT_CANDIDATES;
        // path -> per-concept best (score, id)
        let mut by_path: HashMap<String, Vec<Option<(f64, i64)>>> = HashMap::new();
        for (ci, q) in p.queries.iter().enumerate() {
            for (id, score) in concept(conn, e, q, &f, 2 * n, n)? {
                let slot = by_path
                    .entry(archive_path_of(conn, id)?)
                    .or_insert_with(|| vec![None; p.queries.len()]);
                if slot[ci].is_none_or(|(s, _)| score > s) {
                    slot[ci] = Some((score, id));
                }
            }
        }
        let mut out: Vec<(i64, f64)> = by_path
            .into_values()
            .filter(|slot| slot.iter().all(Option::is_some))
            .map(|slot| {
                let best = slot
                    .iter()
                    .flatten()
                    .max_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)))
                    .unwrap();
                let mean = slot.iter().flatten().map(|s| s.0).sum::<f64>() / slot.len() as f64;
                (best.1, mean)
            })
            .collect();
        out.sort_by(|a, b| b.1.total_cmp(&a.1).then(b.0.cmp(&a.0)));
        out.truncate(limit);
        out
    };

    let top = ranked.first().map_or(1.0, |r| r.1);
    let hits = ranked
        .into_iter()
        .map(|(id, s)| load_hit(conn, id, if top > 0.0 { s / top } else { 0.0 }))
        .collect::<Result<Vec<_>>>()?;
    Ok(SearchOutput { hits, vector_used })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, insert_exchange, NewExchange};
    use crate::embed::{embed_pending, FakeEmbedder};
    use crate::terms::to_terms;

    const DAY: i64 = 86_400_000;
    // 2026-01-10 12:00:00 UTC
    const T0: i64 = 1_768_046_400_000;

    struct Ex<'a> {
        path: &'a str,
        line: i64,
        project: &'a str,
        side: bool,
        ts: i64,
        user: &'a str,
        asst: &'a str,
    }

    fn ex<'a>(path: &'a str, line: i64, user: &'a str) -> Ex<'a> {
        Ex {
            path,
            line,
            project: "proj",
            side: false,
            ts: T0,
            user,
            asst: "ok",
        }
    }

    fn db_with(rows: &[Ex], embed: bool) -> (tempfile::TempDir, Connection) {
        let t = tempfile::tempdir().unwrap();
        let mut conn = db::open(&t.path().join("s.db")).unwrap();
        let tx = conn.transaction().unwrap();
        for r in rows {
            insert_exchange(
                &tx,
                &NewExchange {
                    archive_path: r.path.into(),
                    line_start: r.line,
                    line_end: r.line + 1,
                    session_id: None,
                    project: r.project.into(),
                    harness: "claude".into(),
                    is_sidechain: r.side,
                    ts: r.ts,
                    user_message: r.user.into(),
                    assistant_message: r.asst.into(),
                    tool_names: String::new(),
                },
                &to_terms(&format!("{} {}", r.user, r.asst)),
            )
            .unwrap();
        }
        tx.commit().unwrap();
        if embed {
            embed_pending(&mut conn, &FakeEmbedder).unwrap();
        }
        (t, conn)
    }

    fn params(q: &[&str]) -> SearchParams {
        SearchParams {
            queries: q.iter().map(|s| s.to_string()).collect(),
            limit: 10,
            ..SearchParams::default()
        }
    }

    fn ids_of(o: &SearchOutput) -> Vec<i64> {
        o.hits.iter().map(|h| h.exchange_id).collect()
    }

    #[test]
    fn rrf_weights() {
        let r = rrf(&[1, 2], &[2, 3], &HashSet::new());
        // BM25 bonus (+0.01 rank 1, +0.005 rank 2) lifts id 1 above vector-only id 3.
        assert_eq!(r.iter().map(|x| x.0).collect::<Vec<_>>(), vec![2, 1, 3]);
        let s = |id| r.iter().find(|x| x.0 == id).unwrap().1;
        assert!((s(2) - (0.4 / 62.0 + 0.005 + 0.6 / 61.0)).abs() < 1e-12);
        assert!((s(3) - 0.6 / 62.0).abs() < 1e-12);
        assert!((s(1) - (0.4 / 61.0 + 0.01)).abs() < 1e-12);
    }

    #[test]
    fn rrf_ties_prefer_newer_id() {
        let r = rrf(&[5], &[9], &HashSet::new());
        // BM25-only rank 1 (0.4/61 + 0.01) beats vector-only rank 1 (0.6/61).
        assert_eq!(r[0].0, 5);
        let r = rrf(&[1, 2], &[], &HashSet::new());
        assert_eq!(r[0].0, 1);
        let r = rrf(&[7], &[], &HashSet::from([7]));
        assert!((r[0].1 - 0.9 * (0.4 / 61.0 + 0.01)).abs() < 1e-12);
    }

    #[test]
    fn sidechain_penalty() {
        let side = HashSet::from([1]);
        let r = rrf(&[1, 2], &[], &side);
        let s1 = r.iter().find(|x| x.0 == 1).unwrap().1;
        assert!((s1 - 0.9 * (0.4 / 61.0 + 0.01)).abs() < 1e-12);
        // Penalty can flip the order: id 1 is BM25 rank 1 (0.0166) but sidechain (0.0149);
        // id 2 is BM25 rank 2 + vec rank 1 on the main thread (0.0213).
        let r = rrf(&[1, 2], &[2], &HashSet::from([1]));
        assert_eq!(r[0].0, 2);
        let r = rrf(&[1, 2], &[2, 1], &HashSet::from([2]));
        assert_eq!(r[0].0, 1);
    }

    #[test]
    fn bm25_only_without_embedder() {
        let (_t, conn) = db_with(
            &[
                ex("/a/1", 1, "how to feed a quokka"),
                ex("/a/1", 3, "sourdough starter tips"),
            ],
            true,
        );
        let o = search(&conn, None, &params(&["quokka"])).unwrap();
        assert!(!o.vector_used);
        assert_eq!(ids_of(&o), vec![1]);
        assert_eq!(o.hits[0].score, 1.0);
        assert_eq!(o.hits[0].archive_path, "/a/1");
        assert_eq!((o.hits[0].line_start, o.hits[0].line_end), (1, 2));
        assert_eq!(o.hits[0].project, "proj");
    }

    #[test]
    fn hybrid_uses_vector_and_normalizes() {
        let (_t, conn) = db_with(
            &[
                ex("/a/1", 1, "quokka feeding schedule"),
                ex("/a/1", 3, "sourdough starter tips"),
            ],
            true,
        );
        let o = search(&conn, Some(&FakeEmbedder), &params(&["quokka feeding"])).unwrap();
        assert!(o.vector_used);
        assert_eq!(o.hits[0].exchange_id, 1);
        assert_eq!(o.hits[0].score, 1.0);
        assert!(o.hits.iter().all(|h| h.score <= 1.0 && h.score > 0.0));
    }

    #[test]
    fn snippets_are_first_200_chars() {
        let long = format!("quokka {}", "가".repeat(500));
        let (_t, conn) = db_with(&[ex("/a/1", 1, &long)], false);
        let o = search(&conn, None, &params(&["quokka"])).unwrap();
        assert_eq!(o.hits[0].user_snippet.chars().count(), 200);
    }

    #[test]
    fn project_and_date_filters_apply_to_both() {
        let mut a = ex("/a/1", 1, "zebra crossing");
        a.project = "alpha";
        let mut b = ex("/a/2", 1, "zebra crossing");
        b.project = "beta";
        b.ts = T0 + DAY;
        let mut c = ex("/a/3", 1, "zebra crossing");
        c.project = "alpha";
        c.ts = T0 + 2 * DAY;
        let (_t, conn) = db_with(&[a, b, c], true);
        use chrono::Utc;
        let d = |s: &str| Some(NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap());
        let search =
            |c: &Connection, e: Option<&dyn Embedder>, p: &SearchParams| search_in(c, e, p, &Utc);
        for e in [None, Some(&FakeEmbedder as &dyn Embedder)] {
            let mut p = params(&["zebra"]);
            p.project = Some("alpha".into());
            let mut got = ids_of(&search(&conn, e, &p).unwrap());
            got.sort();
            assert_eq!(got, vec![1, 3]);

            // "before" includes the whole day; "after" starts at 00:00 (UTC here).
            let mut p = params(&["zebra"]);
            p.after = d("2026-01-11");
            p.before = d("2026-01-11");
            assert_eq!(ids_of(&search(&conn, e, &p).unwrap()), vec![2]);

            let mut p = params(&["zebra"]);
            p.before = d("2026-01-10");
            assert_eq!(ids_of(&search(&conn, e, &p).unwrap()), vec![1]);

            let mut p = params(&["zebra"]);
            p.after = d("2026-01-12");
            p.project = Some("beta".into());
            assert!(search(&conn, e, &p).unwrap().hits.is_empty());
        }
    }

    #[test]
    fn multi_concept_intersects_by_conversation() {
        let (_t, conn) = db_with(
            &[
                ex("/a/same", 1, "feeding the quokka"),
                ex("/a/same", 3, "polishing a walrus tusk"),
                ex("/a/other", 1, "another walrus story"),
            ],
            false,
        );
        let o = search(&conn, None, &params(&["quokka", "walrus"])).unwrap();
        assert_eq!(o.hits.len(), 1);
        assert_eq!(o.hits[0].archive_path, "/a/same");
        assert_eq!(o.hits[0].score, 1.0);

        // Concepts living in different conversations intersect to nothing.
        let (_t, conn) = db_with(
            &[
                ex("/a/x", 1, "feeding the quokka"),
                ex("/a/y", 1, "polishing a walrus tusk"),
            ],
            false,
        );
        let o = search(&conn, None, &params(&["quokka", "walrus"])).unwrap();
        assert!(o.hits.is_empty());
    }

    #[test]
    fn multi_concept_shows_best_exchange_and_validates_count() {
        // The rival outranks /a/same for "quokka", so inside /a/same the "walrus" exchange
        // (rank 1) has the highest single score and is the one shown.
        let (_t, conn) = db_with(
            &[
                ex("/a/same", 1, "quokka"),
                ex("/a/same", 3, "walrus"),
                ex("/a/rival", 1, "quokka quokka quokka quokka quokka"),
            ],
            false,
        );
        let o = search(&conn, None, &params(&["quokka", "walrus"])).unwrap();
        assert_eq!(o.hits.len(), 1);
        assert_eq!(o.hits[0].archive_path, "/a/same");
        assert_eq!(o.hits[0].exchange_id, 2);
        assert!(search(&conn, None, &params(&[])).is_err());
        assert!(search(&conn, None, &params(&["a", "b", "c", "d", "e", "f"])).is_err());
    }

    #[test]
    fn empty_and_noise_queries_return_empty() {
        let (_t, conn) = db_with(&[ex("/a/1", 1, "quokka")], true);
        for q in ["", "   ", "!!!"] {
            for e in [None, Some(&FakeEmbedder as &dyn Embedder)] {
                let o = search(&conn, e, &params(&[q])).unwrap();
                assert!(o.hits.is_empty(), "{q:?}");
            }
        }
        let o = search(&conn, Some(&FakeEmbedder), &params(&["quokka", "!!!"])).unwrap();
        assert!(o.hits.is_empty());
    }

    #[test]
    fn limit_capped_at_50() {
        let users: Vec<String> = (0..60).map(|i| format!("quokka number{i}")).collect();
        let rows: Vec<Ex> = users
            .iter()
            .enumerate()
            .map(|(i, u)| ex("/a/1", i as i64 * 2 + 1, u))
            .collect();
        let (_t, conn) = db_with(&rows, true);
        let mut p = params(&["quokka"]);
        p.limit = 100;
        assert_eq!(
            search(&conn, Some(&FakeEmbedder), &p).unwrap().hits.len(),
            50
        );
        p.limit = 0;
        assert_eq!(
            search(&conn, Some(&FakeEmbedder), &p).unwrap().hits.len(),
            1
        );
        p.limit = 7;
        assert_eq!(
            search(&conn, Some(&FakeEmbedder), &p).unwrap().hits.len(),
            7
        );
    }

    #[test]
    fn sidechain_hits_rank_below_equal_main_hits() {
        let mut side = ex("/a/1", 1, "quokka report");
        side.side = true;
        let main = ex("/a/2", 1, "quokka report");
        // The BM25 rank-1 bonus (+0.01) outweighs the 0.9 penalty, so the tie must not
        // hand the sidechain row rank 1: insert the main-thread row first.
        let (_t, conn) = db_with(&[main, side], true);
        let o = search(&conn, Some(&FakeEmbedder), &params(&["quokka report"])).unwrap();
        assert_eq!(ids_of(&o), vec![1, 2]);
        assert!(o.hits[1].score < 1.0);
    }

    #[test]
    fn rrf_bm25_top_rank_bonus() {
        let r = rrf(&[1, 2, 3, 4], &[], &HashSet::new());
        let s = |id| r.iter().find(|x| x.0 == id).unwrap().1;
        assert!((s(1) - (0.4 / 61.0 + 0.01)).abs() < 1e-12);
        assert!((s(2) - (0.4 / 62.0 + 0.005)).abs() < 1e-12);
        assert!((s(3) - (0.4 / 63.0 + 0.0025)).abs() < 1e-12);
        assert!((s(4) - 0.4 / 64.0).abs() < 1e-12);
        // Bonus applies before the sidechain multiplier.
        let r = rrf(&[1], &[], &HashSet::from([1]));
        assert!((r[0].1 - 0.9 * (0.4 / 61.0 + 0.01)).abs() < 1e-12);
        // A BM25-only rank-1 hit beats a vector-only rank-1 hit.
        let r = rrf(&[5], &[9], &HashSet::new());
        assert_eq!(r[0].0, 5);
    }

    #[test]
    fn bm25_only_exact_match_ranks_first_among_vector_hits() {
        // Fillers dominate the vector side (N = 50); the lone zorblax exchange is
        // only found by BM25 and must still come out on top.
        let long = format!(
            "zorblax {}",
            (0..30)
                .map(|i| format!("w{i}"))
                .collect::<Vec<_>>()
                .join(" ")
        );
        let fillers: Vec<String> = (0..60).map(|i| format!("filler note{i}")).collect();
        let mut rows = vec![ex("/a/z", 1, &long)];
        rows.extend(
            fillers
                .iter()
                .enumerate()
                .map(|(i, u)| ex("/a/f", i as i64 * 2 + 1, u)),
        );
        let (_t, conn) = db_with(&rows, true);
        let o = search(&conn, Some(&FakeEmbedder), &params(&["zorblax filler"])).unwrap();
        assert_eq!(o.hits[0].exchange_id, 1);
    }

    #[test]
    fn multi_concept_uses_300_candidates_per_side() {
        // For each concept, 10 rivals outrank the shared conversation's exchange, which
        // falls outside limit*5 = 5 but well inside 300 candidates.
        for concepts in [
            vec!["quokka", "walrus", "narwhal"],
            vec!["quokka", "walrus", "narwhal", "ocelot"],
        ] {
            let mut texts: Vec<(String, String)> = Vec::new();
            for c in &concepts {
                for i in 0..10 {
                    texts.push((format!("/a/rival-{c}-{i}"), format!("{c} {c} {c} {c}")));
                }
            }
            let mut rows: Vec<Ex> = texts.iter().map(|(p, u)| ex(p, 1, u)).collect();
            for (i, c) in concepts.iter().enumerate() {
                rows.push(ex("/a/same", i as i64 * 2 + 1, c));
            }
            let (_t, conn) = db_with(&rows, false);
            let mut p = params(&concepts);
            p.limit = 1;
            let o = search(&conn, None, &p).unwrap();
            assert_eq!(o.hits.len(), 1, "{concepts:?}");
            assert_eq!(o.hits[0].archive_path, "/a/same");
        }
    }

    #[test]
    fn date_filters_use_the_given_timezone() {
        use chrono::{FixedOffset, Utc};
        let d = |s: &str| Some(NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap());
        let p = SearchParams {
            after: d("2026-01-11"),
            before: d("2026-01-11"),
            ..SearchParams::default()
        };
        // +09:00: local midnight 2026-01-11 is 2026-01-10T15:00:00Z.
        let kst = FixedOffset::east_opt(9 * 3600).unwrap();
        let f = Filters::new_in(&p, &kst);
        assert_eq!(f.ts_from, Some(1_768_057_200_000));
        assert_eq!(f.ts_to, Some(1_768_057_200_000 + DAY));
        // UTC: plain UTC midnights.
        let f = Filters::new_in(&p, &Utc);
        assert_eq!(f.ts_from, Some(1_768_089_600_000));
        assert_eq!(f.ts_to, Some(1_768_089_600_000 + DAY));
    }

    #[test]
    fn skipped_midnight_uses_first_valid_instant_of_the_day() {
        // America/Sao_Paulo 2018-11-04: clocks jumped 00:00 -> 01:00 (-02:00 DST), so the
        // day starts at 01:00 local = 03:00Z.
        let tz = chrono_tz::America::Sao_Paulo;
        let d = |s: &str| Some(NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap());
        let day_start = 1_541_300_400_000; // 2018-11-04T03:00:00Z
        let p = SearchParams {
            after: d("2018-11-04"),
            before: d("2018-11-03"),
            ..SearchParams::default()
        };
        let f = Filters::new_in(&p, &tz);
        assert_eq!(f.ts_from, Some(day_start));
        assert_eq!(f.ts_to, Some(day_start));
    }
}
