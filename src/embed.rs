use anyhow::{bail, Result};
use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};
use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

pub const DIMS: usize = 384;
const BATCH: usize = 32;
const DOC_MAX_CHARS: usize = 2000;

/// Implementations add the `passage: ` / `query: ` prefixes themselves.
pub trait Embedder: Send + Sync {
    fn embed_passages(&self, texts: &[String]) -> Result<Vec<Vec<f32>>>;
    fn embed_query(&self, q: &str) -> Result<Vec<f32>>;
}

pub struct E5Embedder {
    model: Mutex<TextEmbedding>,
}

impl E5Embedder {
    pub fn load(models_dir: &Path) -> Result<Self> {
        let model = TextEmbedding::try_new(
            TextInitOptions::new(EmbeddingModel::MultilingualE5Small)
                .with_cache_dir(models_dir.to_path_buf())
                .with_intra_threads(2),
        )?;
        Ok(E5Embedder {
            model: Mutex::new(model),
        })
    }

    fn embed(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
        let mut m = self
            .model
            .lock()
            .map_err(|_| anyhow::anyhow!("embedding model lock poisoned"))?;
        Ok(m.embed(texts, Some(BATCH))?)
    }
}

impl Embedder for E5Embedder {
    fn embed_passages(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        self.embed(texts.iter().map(|t| format!("passage: {t}")).collect())
    }

    fn embed_query(&self, q: &str) -> Result<Vec<f32>> {
        match self.embed(vec![format!("query: {q}")])?.pop() {
            Some(v) => Ok(v),
            None => bail!("embedder returned no vector"),
        }
    }
}

/// Deterministic test embedder: hashed bag of tokens, L2-normalized.
pub struct FakeEmbedder;

fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

impl FakeEmbedder {
    fn vector(text: &str) -> Vec<f32> {
        let mut v = vec![0.0f32; DIMS];
        for tok in text
            .to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|t| !t.is_empty())
        {
            v[(fnv1a(tok) % DIMS as u64) as usize] += 1.0;
        }
        let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            v.iter_mut().for_each(|x| *x /= norm);
        }
        v
    }
}

impl Embedder for FakeEmbedder {
    fn embed_passages(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        Ok(texts.iter().map(|t| Self::vector(t)).collect())
    }

    fn embed_query(&self, q: &str) -> Result<Vec<f32>> {
        Ok(Self::vector(q))
    }
}

struct Pending {
    id: i64,
    project: String,
    ts: i64,
    is_sidechain: i64,
    text: String,
}

fn truncate_chars(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

fn next_batch(conn: &Connection) -> Result<Vec<Pending>> {
    let mut stmt = conn.prepare(
        "SELECT id, project, ts, is_sidechain, user_message, assistant_message, tool_names
         FROM exchanges WHERE embedded = 0 ORDER BY id LIMIT ?",
    )?;
    let rows = stmt.query_map([BATCH as i64], |r| {
        let (u, a, t): (String, String, String) = (r.get(4)?, r.get(5)?, r.get(6)?);
        let doc = format!("User: {u}\n\nAssistant: {a}\n\nTools: {t}");
        Ok(Pending {
            id: r.get(0)?,
            project: r.get(1)?,
            ts: r.get(2)?,
            is_sidechain: r.get(3)?,
            text: truncate_chars(&doc, DOC_MAX_CHARS).to_string(),
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Embeds every `embedded = 0` exchange, 32 at a time. Returns how many were embedded.
pub fn embed_pending(conn: &mut Connection, e: &dyn Embedder) -> Result<usize> {
    let mut total = 0;
    loop {
        let batch = next_batch(conn)?;
        if batch.is_empty() {
            return Ok(total);
        }
        let texts: Vec<String> = batch.iter().map(|p| p.text.clone()).collect();
        let vectors = e.embed_passages(&texts)?;
        if vectors.len() != batch.len() || vectors.iter().any(|v| v.len() != DIMS) {
            bail!("embedder returned unexpected vector count or dimension");
        }
        let tx = conn.transaction()?;
        for (p, v) in batch.iter().zip(&vectors) {
            let bytes: Vec<u8> = v.iter().flat_map(|f| f.to_le_bytes()).collect();
            tx.execute(
                "INSERT INTO vec_exchanges(rowid, embedding, project, ts, is_sidechain)
                 VALUES (?, ?, ?, ?, ?)",
                params![p.id, bytes, p.project, p.ts, p.is_sidechain],
            )?;
            tx.execute("UPDATE exchanges SET embedded = 1 WHERE id = ?", [p.id])?;
        }
        tx.commit()?;
        total += batch.len();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{insert_exchange, NewExchange};

    fn dot(a: &[f32], b: &[f32]) -> f32 {
        a.iter().zip(b).map(|(x, y)| x * y).sum()
    }

    #[test]
    fn fake_embedder_similarity() {
        let e = FakeEmbedder;
        let v = e
            .embed_passages(&[
                "rust sqlite vector search".to_string(),
                "vector search in sqlite".to_string(),
                "banana smoothie recipe".to_string(),
            ])
            .unwrap();
        assert_eq!(v[0].len(), 384);
        assert!(dot(&v[0], &v[1]) > dot(&v[0], &v[2]));
        let q = e.embed_query("sqlite vector").unwrap();
        assert!(dot(&q, &v[0]) > dot(&q, &v[2]));
        assert!(e.embed_query("").unwrap().iter().all(|x| *x == 0.0));
    }

    fn add(conn: &mut Connection, n: i64, user: &str) {
        let tx = conn.transaction().unwrap();
        insert_exchange(
            &tx,
            &NewExchange {
                archive_path: "/a".into(),
                line_start: n,
                line_end: n,
                session_id: None,
                project: "proj".into(),
                harness: "claude".into(),
                is_sidechain: n % 2 == 0,
                ts: 1000 + n,
                user_message: user.into(),
                assistant_message: "ans".into(),
                tool_names: "Bash".into(),
            },
            "t",
        )
        .unwrap();
        tx.commit().unwrap();
    }

    #[test]
    fn embed_pending_marks_and_inserts() {
        let t = tempfile::tempdir().unwrap();
        let mut conn = crate::db::open(&t.path().join("e.db")).unwrap();
        for n in 1..=40 {
            add(&mut conn, n, &"가".repeat(3000)); // exercises truncation on char boundaries
        }
        assert_eq!(embed_pending(&mut conn, &FakeEmbedder).unwrap(), 40);
        let pending: i64 = conn
            .query_row(
                "SELECT count(*) FROM exchanges WHERE embedded = 0",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let vecs: i64 = conn
            .query_row("SELECT count(*) FROM vec_exchanges", [], |r| r.get(0))
            .unwrap();
        assert_eq!((pending, vecs), (0, 40));
        let (p, ts, side): (String, i64, i64) = conn
            .query_row(
                "SELECT project, ts, is_sidechain FROM vec_exchanges WHERE rowid = 2",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((p.as_str(), ts, side), ("proj", 1002, 1));
        assert_eq!(embed_pending(&mut conn, &FakeEmbedder).unwrap(), 0);
    }

    #[test]
    fn doc_text_is_truncated_to_2000_chars() {
        let t = tempfile::tempdir().unwrap();
        let mut conn = crate::db::open(&t.path().join("e.db")).unwrap();
        add(&mut conn, 1, &"x".repeat(5000));
        let b = next_batch(&conn).unwrap();
        assert_eq!(b[0].text.chars().count(), 2000);
        assert!(b[0].text.starts_with("User: xxx"));
    }

    #[test]
    #[ignore] // requires model download (~470MB)
    fn e5_embedder_loads_and_embeds_384() {
        let cache =
            std::env::var("FASTEMBED_CACHE_DIR").unwrap_or_else(|_| "/tmp/fastembed-cache".into());
        let e = E5Embedder::load(Path::new(&cache)).unwrap();
        assert_eq!(e.embed_query("안녕").unwrap().len(), 384);
    }
}
