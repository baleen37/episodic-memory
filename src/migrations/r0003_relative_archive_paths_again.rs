//! Revision 2 as shipped in v4.1.0 added a separator to a data dir that already ended with one,
//! so under such an `EPISODIC_MEMORY_DIR` it converted no row. Running the fixed revision 2
//! again converts them; elsewhere it finds nothing left to change.

use super::Migration;
use anyhow::Result;

pub const NAME: &str = "relative archive paths for a data dir ending in a separator";

pub fn up(m: &Migration) -> Result<()> {
    super::r0002_relative_archive_paths::up(m)
}
