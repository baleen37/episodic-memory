use crate::embed::Embedder;
use crate::terms::build_match_query;
use anyhow::{Result, bail};
use chrono::{Days, Duration, Local, NaiveDate, TimeZone};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, params_from_iter};
use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;

/// Most hits one search returns.
pub const MAX_LIMIT: usize = 50;
/// Candidates fetched per side (BM25 and vector) for each concept of an array query.
const MULTI_CONCEPT_CANDIDATES: usize = 300;
/// Vector candidates whose cosine similarity to the query is below this are dropped before
/// fusion, unless BM25 found them too. Calibrated on real data (spec §6).
pub const MIN_VECTOR_SIMILARITY: f64 = 0.85;
/// Highest possible fused score: BM25 rank 1 (with its bonus) plus vector rank 1.
/// Scores are reported as `fused / MAX_FUSED`, an absolute 0-1 scale.
const MAX_FUSED: f64 = 0.4 / 61.0 + 0.01 + 0.6 / 61.0;

#[derive(Debug, Clone, Default)]
pub struct SearchParams {
    pub queries: Vec<String>,
    pub limit: usize,
    pub after: Option<NaiveDate>,
    pub before: Option<NaiveDate>,
    pub project: Option<String>,
    /// The requesting conversation; its exchanges are never returned.
    pub exclude_session: Option<String>,
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
    /// At least one hit was found by BM25 (not only by vector similarity).
    pub keyword_match: bool,
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
    /// Applied to candidates after retrieval (`vec_exchanges` has no session column).
    exclude_session: Option<String>,
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
            exclude_session: p.exclude_session.clone(),
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
            let _ = write!(sql, " AND {col_prefix}project = ?");
            params.push(SqlValue::Text(p.clone()));
        }
        if let Some(t) = self.ts_from {
            let _ = write!(sql, " AND {col_prefix}ts >= ?");
            params.push(SqlValue::Integer(t));
        }
        if let Some(t) = self.ts_to {
            let _ = write!(sql, " AND {col_prefix}ts < ?");
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

/// Vector nearest neighbours as (id, cosine similarity), nearest first.
fn vec_hits(
    conn: &Connection,
    e: &dyn Embedder,
    query: &str,
    f: &Filters,
    n: usize,
) -> Result<Vec<(i64, f64)>> {
    let bytes: Vec<u8> = e
        .embed_query(query)?
        .iter()
        .flat_map(|x| x.to_le_bytes())
        .collect();
    let (cond, mut params) = f.sql("");
    params.insert(0, SqlValue::Integer(n as i64));
    params.insert(0, SqlValue::Blob(bytes));
    let mut stmt = conn.prepare(&format!(
        "SELECT rowid, distance FROM vec_exchanges WHERE embedding MATCH ? AND k = ?{cond} ORDER BY distance"
    ))?;
    // L2 distance between unit vectors: cosine = 1 - d²/2.
    let rows = stmt.query_map(params_from_iter(params), |r| {
        let d: f64 = r.get(1)?;
        Ok((r.get(0)?, 1.0 - d * d / 2.0))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// `ids` as a JSON array, bound as one parameter and expanded with `json_each`.
fn json_ids<'a>(ids: impl IntoIterator<Item = &'a i64>) -> String {
    serde_json::to_string(&ids.into_iter().collect::<Vec<_>>()).expect("integers serialize")
}

/// Candidate ids from `session` (to drop) and sidechain ids among `all`, in one query.
fn screen(
    conn: &Connection,
    all: &[&[i64]],
    session: Option<&str>,
) -> Result<(HashSet<i64>, HashSet<i64>)> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, is_sidechain, ?2 IS NOT NULL AND session_id IS ?2 FROM exchanges
         WHERE id IN (SELECT value FROM json_each(?1))",
    )?;
    let list = json_ids(all.iter().flat_map(|s| s.iter()));
    let (mut own, mut side) = (HashSet::new(), HashSet::new());
    let mut rows = stmt.query(rusqlite::params![list, session])?;
    while let Some(r) = rows.next()? {
        let (id, is_side, is_own): (i64, bool, bool) = (r.get(0)?, r.get(1)?, r.get(2)?);
        if is_own {
            own.insert(id);
        } else if is_side {
            side.insert(id);
        }
    }
    Ok((own, side))
}

/// (exchange id, raw fused score, found by BM25).
type Scored = (i64, f64, bool);

/// One concept's fused ranking, best first, cut to `limit`. `n` candidates are fetched per side. Vector candidates below
/// `MIN_VECTOR_SIMILARITY` are dropped before ranks are assigned, unless BM25 found them too.
fn concept(
    conn: &Connection,
    e: Option<&dyn Embedder>,
    query: &str,
    f: &Filters,
    limit: usize,
    n: usize,
) -> Result<Vec<Scored>> {
    let bm = bm25_ids(conn, query, f, n)?;
    let bm_set: HashSet<i64> = bm.iter().copied().collect();
    let ve: Vec<i64> = match e {
        Some(e) => vec_hits(conn, e, query, f, n)?
            .into_iter()
            .filter(|(id, cos)| *cos >= MIN_VECTOR_SIMILARITY || bm_set.contains(id))
            .map(|(id, _)| id)
            .collect(),
        None => Vec::new(),
    };
    let (own, side) = screen(conn, &[&bm, &ve], f.exclude_session.as_deref())?;
    let keep =
        |ids: Vec<i64>| -> Vec<i64> { ids.into_iter().filter(|id| !own.contains(id)).collect() };
    let mut ranked = rrf(&keep(bm), &keep(ve), &side);
    ranked.truncate(limit);
    Ok(ranked
        .into_iter()
        .map(|(id, s)| (id, s, bm_set.contains(&id)))
        .collect())
}

/// Hits for `ranked` (id, absolute score) in the same order, previews (first 200 chars) cut in
/// SQL.
fn load_hits(conn: &Connection, ranked: &[(i64, f64)]) -> Result<Vec<Hit>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, project, ts, substr(user_message, 1, 200),
                substr(assistant_message, 1, 200), archive_path, line_start, line_end
         FROM exchanges WHERE id IN (SELECT value FROM json_each(?))",
    )?;
    let mut by_id: HashMap<i64, Hit> = stmt
        .query_map([json_ids(ranked.iter().map(|(id, _)| id))], |r| {
            Ok(Hit {
                exchange_id: r.get(0)?,
                project: r.get(1)?,
                ts: r.get(2)?,
                score: 0.0,
                user_snippet: r.get(3)?,
                assistant_snippet: r.get(4)?,
                archive_path: r.get(5)?,
                line_start: r.get(6)?,
                line_end: r.get(7)?,
            })
        })?
        .map(|h| h.map(|h| (h.exchange_id, h)))
        .collect::<rusqlite::Result<_>>()?;
    ranked
        .iter()
        .map(|&(id, score)| {
            let mut h = by_id
                .remove(&id)
                .ok_or_else(|| anyhow::anyhow!("exchange {id} vanished during search"))?;
            h.score = score;
            Ok(h)
        })
        .collect()
}

/// Archive path of each id, in one query.
fn archive_paths(conn: &Connection, ids: &[Scored]) -> Result<HashMap<i64, String>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, archive_path FROM exchanges WHERE id IN (SELECT value FROM json_each(?))",
    )?;
    let rows = stmt.query_map([json_ids(ids.iter().map(|s| &s.0))], |r| {
        Ok((r.get(0)?, r.get(1)?))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
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
        .any(|q| !q.chars().any(char::is_alphanumeric))
    {
        return Ok(SearchOutput::default());
    }
    let vector_used = e.is_some();

    // Best first; raw fused scores are put on the absolute scale below.
    let ranked: Vec<Scored> = if p.queries.len() == 1 {
        concept(conn, e, &p.queries[0], &f, limit, 50.max(limit * 3))?
    } else {
        let n = MULTI_CONCEPT_CANDIDATES;
        // path -> per-concept best
        let mut by_path: HashMap<String, Vec<Option<Scored>>> = HashMap::new();
        for (ci, q) in p.queries.iter().enumerate() {
            let scored = concept(conn, e, q, &f, 2 * n, n)?;
            let mut paths = archive_paths(conn, &scored)?;
            for (id, score, kw) in scored {
                let path = paths
                    .remove(&id)
                    .ok_or_else(|| anyhow::anyhow!("exchange {id} vanished during search"))?;
                let slot = by_path
                    .entry(path)
                    .or_insert_with(|| vec![None; p.queries.len()]);
                if slot[ci].is_none_or(|(_, s, _)| score > s) {
                    slot[ci] = Some((id, score, kw));
                }
            }
        }
        let mut out: Vec<Scored> = by_path
            .into_values()
            .filter(|slot| slot.iter().all(Option::is_some))
            .map(|slot| {
                let best = slot
                    .iter()
                    .flatten()
                    .max_by(|a, b| a.1.total_cmp(&b.1).then(a.0.cmp(&b.0)))
                    .unwrap();
                let mean = slot.iter().flatten().map(|s| s.1).sum::<f64>() / slot.len() as f64;
                (best.0, mean, slot.iter().flatten().any(|s| s.2))
            })
            .collect();
        out.sort_by(|a, b| b.1.total_cmp(&a.1).then(b.0.cmp(&a.0)));
        out.truncate(limit);
        out
    };

    let keyword_match = ranked.iter().any(|r| r.2);
    let scored: Vec<(i64, f64)> = ranked
        .into_iter()
        .map(|(id, s, _)| (id, (s / MAX_FUSED).clamp(0.0, 1.0)))
        .collect();
    let hits = load_hits(conn, &scored)?;
    Ok(SearchOutput {
        hits,
        vector_used,
        keyword_match,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, NewExchange, insert_exchange};
    use crate::embed::{FakeEmbedder, embed_pending};
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
            queries: q.iter().map(ToString::to_string).collect(),
            limit: 10,
            ..SearchParams::default()
        }
    }

    fn ids_of(o: &SearchOutput) -> Vec<i64> {
        o.hits.iter().map(|h| h.exchange_id).collect()
    }

    #[test]
    fn requesting_session_is_excluded_on_both_sides() {
        let (_t, conn) = db_with(
            &[
                ex("a.jsonl", 1, "zebra mine"),
                ex("b.jsonl", 1, "zebra theirs"),
            ],
            true,
        );
        conn.execute(
            "UPDATE exchanges SET session_id = 'me' WHERE archive_path = 'a.jsonl'",
            [],
        )
        .unwrap();
        let theirs: i64 = conn
            .query_row(
                "SELECT id FROM exchanges WHERE archive_path = 'b.jsonl'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let mut p = params(&["zebra"]);
        p.exclude_session = Some("me".into());
        let out = search(&conn, Some(&FakeEmbedder), &p).unwrap();
        assert_eq!(ids_of(&out), [theirs]);
        // Exchanges without a session id are never treated as the requester's.
        p.exclude_session = None;
        assert_eq!(
            search(&conn, Some(&FakeEmbedder), &p).unwrap().hits.len(),
            2
        );
    }

    /// BM25 rank 1 alone, as an absolute score.
    const BM25_TOP: f64 = (0.4 / 61.0 + 0.01) / MAX_FUSED;

    /// Test embedder with a chosen cosine: the query is axis 0, a passage containing `cosNN`
    /// is `(NN/100, sqrt(1 - (NN/100)^2))`, any other passage is axis 1 (cosine 0).
    struct AxisEmbedder;

    fn cos_marker(text: &str) -> f32 {
        text.split(|c: char| !c.is_alphanumeric())
            .find_map(|t| t.strip_prefix("cos").and_then(|n| n.parse::<f32>().ok()))
            .map_or(0.0, |n| n / 100.0)
    }

    impl Embedder for AxisEmbedder {
        fn embed_passages(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
            Ok(texts
                .iter()
                .map(|t| {
                    let c = cos_marker(t);
                    let mut v = vec![0.0; crate::embed::DIMS];
                    v[0] = c;
                    v[1] = (1.0 - c * c).sqrt();
                    v
                })
                .collect())
        }
        fn embed_query(&self, _: &str) -> Result<Vec<f32>> {
            let mut v = vec![0.0; crate::embed::DIMS];
            v[0] = 1.0;
            Ok(v)
        }
    }

    fn db_axis(rows: &[Ex]) -> (tempfile::TempDir, Connection) {
        let (t, mut conn) = db_with(rows, false);
        embed_pending(&mut conn, &AxisEmbedder).unwrap();
        (t, conn)
    }

    /// `cosNN` markers just above and just below the floor.
    fn above() -> String {
        format!("cos{}", (MIN_VECTOR_SIMILARITY * 100.0).round() as i64 + 3)
    }
    fn below() -> String {
        format!("cos{}", (MIN_VECTOR_SIMILARITY * 100.0).round() as i64 - 3)
    }

    #[test]
    fn vector_only_candidates_below_floor_are_dropped() {
        let (hi, lo) = (format!("alpha {}", above()), format!("beta {}", below()));
        let (_t, conn) = db_axis(&[ex("/a/1", 1, &hi), ex("/a/2", 1, &lo)]);
        let o = search(&conn, Some(&AxisEmbedder), &params(&["gamma"])).unwrap();
        assert!(o.vector_used);
        assert!(!o.keyword_match);
        assert_eq!(ids_of(&o), vec![1]);
        // Vector-only rank 1 on the absolute scale.
        assert!((o.hits[0].score - (0.6 / 61.0) / MAX_FUSED).abs() < 1e-9);

        // Nothing above the floor: no results at all.
        let (_t, conn) = db_axis(&[ex("/a/2", 1, &lo)]);
        let o = search(&conn, Some(&AxisEmbedder), &params(&["gamma"])).unwrap();
        assert!(o.hits.is_empty());
    }

    #[test]
    fn keyword_hit_with_low_cosine_is_kept() {
        // The walrus row is nearer than the quokka row but below the floor and vector-only,
        // so it is dropped before ranks are assigned and the quokka row becomes vector rank 1.
        let other = format!("walrus {}", below());
        let (_t, conn) = db_axis(&[ex("/a/1", 1, "quokka cos10"), ex("/a/2", 1, &other)]);
        let o = search(&conn, Some(&AxisEmbedder), &params(&["quokka"])).unwrap();
        assert!(o.keyword_match);
        assert_eq!(ids_of(&o), vec![1]);
        assert_eq!(o.hits[0].score, 1.0);
    }

    #[test]
    fn array_query_uses_the_absolute_scale() {
        let both = format!("quokka walrus {}", above());
        let (_t, conn) = db_axis(&[ex("/a/same", 1, &both)]);
        // Each concept: BM25 rank 1 + vector rank 1 = 1.0, so the mean is 1.0.
        let o = search(&conn, Some(&AxisEmbedder), &params(&["quokka", "walrus"])).unwrap();
        assert_eq!(o.hits.len(), 1);
        assert!((o.hits[0].score - 1.0).abs() < 1e-12);
        assert!(o.keyword_match);
        // Vector-only for both concepts: the mean of two vector rank-1 scores.
        let o = search(&conn, Some(&AxisEmbedder), &params(&["gamma", "delta"])).unwrap();
        assert_eq!(o.hits.len(), 1);
        assert!((o.hits[0].score - (0.6 / 61.0) / MAX_FUSED).abs() < 1e-9);
        assert!(!o.keyword_match);
        // Below the floor, an array query finds nothing either.
        let lo = format!("quokka {}", below());
        let (_t, conn) = db_axis(&[ex("/a/x", 1, &lo)]);
        let o = search(&conn, Some(&AxisEmbedder), &params(&["gamma", "delta"])).unwrap();
        assert!(o.hits.is_empty());
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
        assert!(o.keyword_match);
        assert_eq!(ids_of(&o), vec![1]);
        // BM25 rank 1 alone, on the absolute scale.
        assert!((o.hits[0].score - BM25_TOP).abs() < 1e-12);
        assert_eq!(o.hits[0].archive_path, "/a/1");
        assert_eq!((o.hits[0].line_start, o.hits[0].line_end), (1, 2));
        assert_eq!(o.hits[0].project, "proj");
    }

    #[test]
    fn hybrid_top_in_both_lists_scores_one() {
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
        let mut row = ex("/a/1", 1, &long);
        let asst = format!("{}tail", "é😀".repeat(150));
        row.asst = &asst;
        let short = ex("/a/2", 1, "quokka short");
        let (_t, conn) = db_with(&[row, short], false);
        let o = search(&conn, None, &params(&["quokka"])).unwrap();
        let first = o.hits.iter().find(|h| h.archive_path == "/a/1").unwrap();
        assert_eq!(first.user_snippet, format!("quokka {}", "가".repeat(193)));
        assert_eq!(first.assistant_snippet, "é😀".repeat(100));
        let second = o.hits.iter().find(|h| h.archive_path == "/a/2").unwrap();
        assert_eq!(second.user_snippet, "quokka short");
        assert_eq!(second.assistant_snippet, "ok");
    }

    #[test]
    #[allow(clippy::many_single_char_names)]
    fn project_and_date_filters_apply_to_both() {
        use chrono::Utc;
        let mut a = ex("/a/1", 1, "zebra crossing");
        a.project = "alpha";
        let mut b = ex("/a/2", 1, "zebra crossing");
        b.project = "beta";
        b.ts = T0 + DAY;
        let mut c = ex("/a/3", 1, "zebra crossing");
        c.project = "alpha";
        c.ts = T0 + 2 * DAY;
        let (_t, conn) = db_with(&[a, b, c], true);
        let d = |s: &str| Some(NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap());
        let search =
            |c: &Connection, e: Option<&dyn Embedder>, p: &SearchParams| search_in(c, e, p, &Utc);
        for e in [None, Some(&FakeEmbedder as &dyn Embedder)] {
            let mut p = params(&["zebra"]);
            p.project = Some("alpha".into());
            let mut got = ids_of(&search(&conn, e, &p).unwrap());
            got.sort_unstable();
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
        // Keyword-only on both concepts: at most BM25 rank 1, never rescaled to 1.0.
        assert!(o.hits[0].score > 0.0 && o.hits[0].score <= BM25_TOP + 1e-12);

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
