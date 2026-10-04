use crate::parse::truncate_chars;
use anyhow::{Result, bail};
use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};
use rusqlite::{Connection, params};
use std::path::Path;
use std::sync::Mutex;

pub const DIMS: usize = 384;
/// Small batches keep ONNX Runtime's peak activation memory, and so daemon RSS, low
/// (2,000-exchange sample: peak 4.2 GB at 32, 2.2 GB at 8, same throughput).
const BATCH: usize = 8;
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
        let mut m = crate::locks::lock(&self.model);
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
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
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
            for x in &mut v {
                *x /= norm;
            }
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

/// Test embedder whose every call fails with "broken".
#[cfg(test)]
pub struct Broken;

#[cfg(test)]
impl Embedder for Broken {
    fn embed_passages(&self, _: &[String]) -> Result<Vec<Vec<f32>>> {
        bail!("broken")
    }

    fn embed_query(&self, _: &str) -> Result<Vec<f32>> {
        bail!("broken")
    }
}

struct Pending {
    id: i64,
    text: String,
}

fn next_batch(conn: &Connection) -> Result<Vec<Pending>> {
    let mut stmt = conn.prepare(
        "SELECT id, user_message, assistant_message, tool_names
         FROM exchanges WHERE embedded = 0 ORDER BY id LIMIT ?",
    )?;
    let rows = stmt.query_map([BATCH as i64], |r| {
        let (u, a, t): (String, String, String) = (r.get(1)?, r.get(2)?, r.get(3)?);
        let doc = format!("User: {u}\n\nAssistant: {a}\n\nTools: {t}");
        Ok(Pending {
            id: r.get(0)?,
            text: truncate_chars(&doc, DOC_MAX_CHARS).to_string(),
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// A vector as the little-endian f32 blob `vec_exchanges` stores.
pub fn to_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

/// Meta key holding the embedding worker's last failure; a successful batch clears it.
/// Separate from sync's `last_error`, which every sync run overwrites.
pub const LAST_EMBED_ERROR: &str = "last_embed_error";

/// Records an embedding failure for `doctor`. Best effort: a DB that cannot take the write
/// already fails louder elsewhere.
pub fn record_embed_error(conn: &Connection, error: &str) {
    let _ = crate::db::meta_set(conn, LAST_EMBED_ERROR, error);
}

fn embed_batch(e: &dyn Embedder, texts: &[String]) -> Result<Vec<Vec<f32>>> {
    let vectors = e.embed_passages(texts)?;
    if vectors.len() != texts.len() || vectors.iter().any(|v| v.len() != DIMS) {
        bail!("embedder returned unexpected vector count or dimension");
    }
    Ok(vectors)
}

/// Embeds every `embedded = 0` exchange, `BATCH` at a time. Returns how many were embedded.
/// Vectors are computed outside any transaction; each batch is written in one short immediate
/// transaction. A row deleted or embedded by someone else in between is skipped. The vector's
/// `project`/`ts`/`is_sidechain` are copied from `exchanges` inside that transaction, so they
/// match the row as committed then, not as read before embedding.
pub fn embed_pending(conn: &mut Connection, e: &dyn Embedder) -> Result<usize> {
    let mut total = 0;
    loop {
        let batch = next_batch(conn)?;
        if batch.is_empty() {
            return Ok(total);
        }
        let texts: Vec<String> = batch.iter().map(|p| p.text.clone()).collect();
        let vectors = match embed_batch(e, &texts) {
            Ok(v) => v,
            Err(err) => {
                record_embed_error(conn, &format!("{err:#}"));
                return Err(err);
            }
        };
        let tx = conn.transaction()?;
        {
            tx.prepare_cached("DELETE FROM meta WHERE key = ?")?
                .execute([LAST_EMBED_ERROR])?;
            let mut mark = tx.prepare_cached(
                "UPDATE exchanges SET embedded = 1 WHERE id = ? AND embedded = 0",
            )?;
            let mut insert = tx.prepare_cached(
                "INSERT INTO vec_exchanges(rowid, embedding, project, ts, is_sidechain)
                 SELECT id, ?2, project, ts, is_sidechain FROM exchanges WHERE id = ?1",
            )?;
            for (p, v) in batch.iter().zip(&vectors) {
                if mark.execute([p.id])? == 1 {
                    insert.execute(params![p.id, to_blob(v)])?;
                    total += 1;
                }
            }
        }
        tx.commit()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{NewExchange, insert_exchange};

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

    /// Deletes exchange 1 (as a concurrent sync reindex would) while the batch is embedded.
    struct DeletesFirst(std::path::PathBuf);

    impl Embedder for DeletesFirst {
        fn embed_passages(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
            let mut c = crate::db::open(&self.0).unwrap();
            let tx = c.transaction().unwrap();
            crate::db::delete_exchanges_from(&tx, "/a", 1).unwrap();
            tx.commit().unwrap();
            FakeEmbedder.embed_passages(texts)
        }
        fn embed_query(&self, q: &str) -> Result<Vec<f32>> {
            FakeEmbedder.embed_query(q)
        }
    }

    #[test]
    fn exchange_deleted_during_embedding_gets_no_vector() {
        let t = tempfile::tempdir().unwrap();
        let db = t.path().join("e.db");
        let mut conn = crate::db::open(&db).unwrap();
        add(&mut conn, 1, "q");
        assert_eq!(embed_pending(&mut conn, &DeletesFirst(db)).unwrap(), 0);
        let vecs: i64 = conn
            .query_row("SELECT count(*) FROM vec_exchanges", [], |r| r.get(0))
            .unwrap();
        assert_eq!(vecs, 0);
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
    #[ignore = "requires model download (~470MB)"]
    fn e5_embedder_loads_and_embeds_384() {
        let cache =
            std::env::var("FASTEMBED_CACHE_DIR").unwrap_or_else(|_| "/tmp/fastembed-cache".into());
        let e = E5Embedder::load(Path::new(&cache)).unwrap();
        assert_eq!(e.embed_query("안녕").unwrap().len(), 384);
    }
}
