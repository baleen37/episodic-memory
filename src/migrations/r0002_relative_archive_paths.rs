//! `archive_path` is stored relative to the data dir (`Paths::archive_key`), so a later
//! revision can move the data dir without rewriting every row. A path outside the data dir
//! (written under another `EPISODIC_MEMORY_DIR`) stays absolute; `Paths::archive_file` reads both.

use super::Migration;
use anyhow::Result;

pub const NAME: &str = "relative archive paths";

pub fn up(m: &Migration) -> Result<()> {
    // Stored paths were built with `Path::join` on the data dir, which adds a separator only
    // when the data dir does not already end with one.
    let mut prefix = m.paths().data.to_string_lossy().into_owned();
    if !prefix.ends_with('/') {
        prefix.push('/');
    }
    // One statement per table: a row-by-row rewrite would hold the write lock far longer.
    for table in ["files", "exchanges"] {
        m.tx().execute(
            &format!(
                "UPDATE {table} SET archive_path = substr(archive_path, length(?1) + 1)
                 WHERE substr(archive_path, 1, length(?1)) = ?1"
            ),
            [&prefix],
        )?;
    }
    Ok(())
}
