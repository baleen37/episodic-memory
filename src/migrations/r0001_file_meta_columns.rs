//! Every file meta field is stored, with the archive bytes it was learned from. Rows start
//! with `meta_offset` 0, so their meta is learned again from the archive.

use super::Migration;
use anyhow::Result;

pub const NAME: &str = "file meta columns";

pub fn up(m: &Migration) -> Result<()> {
    m.sql(
        "ALTER TABLE files ADD COLUMN sidechain_known INTEGER NOT NULL DEFAULT 0;
         ALTER TABLE files ADD COLUMN agent_path TEXT;
         ALTER TABLE files ADD COLUMN meta_offset INTEGER NOT NULL DEFAULT 0;
         ALTER TABLE files ADD COLUMN meta_settled INTEGER NOT NULL DEFAULT 0;
         PRAGMA user_version = 2;",
    )
}
