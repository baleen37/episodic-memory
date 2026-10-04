//! The reparse point also stores its byte position. Existing rows get 0 (unknown), so their
//! next sync finds the reparse line by counting once.

use super::Migration;
use anyhow::Result;

pub const NAME: &str = "reparse byte position";

pub fn up(m: &Migration) -> Result<()> {
    m.sql(
        "ALTER TABLE files ADD COLUMN reparse_offset INTEGER NOT NULL DEFAULT 0;
         PRAGMA user_version = 3;",
    )
}
