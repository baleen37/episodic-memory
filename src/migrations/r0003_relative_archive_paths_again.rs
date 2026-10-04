//! Revision 2 as shipped in v4.1.0 had no fence, so binaries from before it kept writing
//! absolute paths after it ran, and under an `EPISODIC_MEMORY_DIR` ending in a separator it
//! converted no row at all. Running the current revision 2 again fences those binaries off and
//! converts whatever they left.

use super::Migration;
use anyhow::Result;

pub const NAME: &str = "fence older binaries, convert archive paths again";

pub fn up(m: &Migration) -> Result<()> {
    super::r0002_relative_archive_paths::up(m)
}
