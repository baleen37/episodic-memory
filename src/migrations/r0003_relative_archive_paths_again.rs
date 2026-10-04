//! Fences binaries from before revision 2 off the DB, and finishes revision 2's conversion.
//!
//! Those binaries read a relative `archive_path` against their working directory, find no
//! archive, and start a new generation under an absolute path, copying the source again. The
//! triggers abort that write (rolling back the whole file's transaction) while leaving reads,
//! and upserts of a row's existing path, alone. `db::SCHEMA` creates the same triggers.
//!
//! Revision 2 as shipped in v4.1.0 added a separator to a data dir that already ended with one,
//! so under such an `EPISODIC_MEMORY_DIR` it converted no row. Running the fixed revision 2
//! again converts them.

use super::Migration;
use anyhow::Result;

pub const NAME: &str = "fence absolute archive paths";

pub fn up(m: &Migration) -> Result<()> {
    m.sql(
        "CREATE TRIGGER files_archive_path_insert BEFORE INSERT ON files
           WHEN substr(NEW.archive_path, 1, 1) = '/'
             AND NOT EXISTS (SELECT 1 FROM files WHERE archive_path = NEW.archive_path)
         BEGIN SELECT RAISE(ABORT, 'absolute archive_path from an outdated episodic-memory; restart this session'); END;
         CREATE TRIGGER files_archive_path_update BEFORE UPDATE OF archive_path ON files
           WHEN substr(NEW.archive_path, 1, 1) = '/' AND NEW.archive_path IS NOT OLD.archive_path
         BEGIN SELECT RAISE(ABORT, 'absolute archive_path from an outdated episodic-memory; restart this session'); END;",
    )?;
    if m.paths().data.to_string_lossy().ends_with('/') {
        super::r0002_relative_archive_paths::up(m)?;
    }
    Ok(())
}
