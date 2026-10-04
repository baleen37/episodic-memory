//! DB `user_version` 1 (the schema up to v4.0.5) to 4. Every file meta field is stored, with
//! the archive bytes it was learned from; rows start with `meta_offset` 0, so their meta is
//! learned again from the archive. The reparse point also stores its byte position and the line
//! that position belongs to; rows start with NULL (unknown) and find the line by counting once.

use super::Migration;
use anyhow::Result;

pub const NAME: &str = "file meta and reparse columns";

pub fn up(m: &Migration) -> Result<()> {
    m.sql(
        "ALTER TABLE files ADD COLUMN sidechain_known INTEGER NOT NULL DEFAULT 0;
         ALTER TABLE files ADD COLUMN agent_path TEXT;
         ALTER TABLE files ADD COLUMN meta_offset INTEGER NOT NULL DEFAULT 0;
         ALTER TABLE files ADD COLUMN meta_settled INTEGER NOT NULL DEFAULT 0;
         ALTER TABLE files ADD COLUMN reparse_offset INTEGER NOT NULL DEFAULT 0;
         ALTER TABLE files ADD COLUMN reparse_offset_line INTEGER;
         PRAGMA user_version = 4;",
    )
}
