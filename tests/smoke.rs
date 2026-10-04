use rusqlite::{Connection, ffi::sqlite3_auto_extension, params};
use sqlite_vec::sqlite3_vec_init;

fn vec_bytes(first: f32) -> Vec<u8> {
    let mut v = vec![0.0f32; 384];
    v[0] = first;
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

#[test]
fn fts5_contentless_delete_and_vec0_metadata_knn() {
    unsafe {
        sqlite3_auto_extension(Some(std::mem::transmute::<
            *const (),
            unsafe extern "C" fn(
                *mut rusqlite::ffi::sqlite3,
                *mut *mut std::os::raw::c_char,
                *const rusqlite::ffi::sqlite3_api_routines,
            ) -> std::os::raw::c_int,
        >(sqlite3_vec_init as *const ())));
    }
    let db = Connection::open_in_memory().unwrap();

    db.execute_batch("CREATE VIRTUAL TABLE f USING fts5(body, content='', contentless_delete=1);")
        .unwrap();
    db.execute("INSERT INTO f(rowid, body) VALUES (1, 'hello world')", [])
        .unwrap();
    let deleted = db.execute("DELETE FROM f WHERE rowid = 1", []).unwrap();
    assert_eq!(deleted, 1);

    db.execute_batch(
        "CREATE VIRTUAL TABLE v USING vec0(embedding float[384], project TEXT, ts INTEGER);",
    )
    .unwrap();
    for (id, project, x) in [(1, "a", 1.0f32), (2, "b", 1.0f32)] {
        db.execute(
            "INSERT INTO v(rowid, embedding, project, ts) VALUES (?, ?, ?, 0)",
            params![id, vec_bytes(x), project],
        )
        .unwrap();
    }
    let mut stmt = db
        .prepare("SELECT rowid FROM v WHERE embedding MATCH ? AND k = 5 AND project = 'a'")
        .unwrap();
    let rows: Vec<i64> = stmt
        .query_map(params![vec_bytes(1.0)], |r| r.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert_eq!(rows, vec![1]);
}

#[test]
#[ignore] // requires model download (~470MB)
fn e5_small_embeds_384() {
    use fastembed::{EmbeddingModel, TextEmbedding, TextInitOptions};
    let cache =
        std::env::var("FASTEMBED_CACHE_DIR").unwrap_or_else(|_| "/tmp/fastembed-cache".into());
    let mut model = TextEmbedding::try_new(
        TextInitOptions::new(EmbeddingModel::MultilingualE5Small).with_cache_dir(cache.into()),
    )
    .unwrap();
    let out = model.embed(vec!["passage: 안녕"], None).unwrap();
    assert_eq!(out[0].len(), 384);
    let norm = out[0].iter().map(|x| x * x).sum::<f32>().sqrt();
    assert!((norm - 1.0).abs() < 1e-3, "norm = {norm}");
}
