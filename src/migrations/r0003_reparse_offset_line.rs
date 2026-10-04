//! The reparse line that `reparse_offset` belongs to. Binaries before DB version 3 update
//! `reparse_line` without `reparse_offset`, so the byte position is used only while both name
//! the same line. Existing rows get NULL (unknown) and find the line by counting once.

use super::Migration;
use anyhow::Result;

pub const NAME: &str = "reparse byte position line";

pub fn up(m: &Migration) -> Result<()> {
    m.sql(
        "ALTER TABLE files ADD COLUMN reparse_offset_line INTEGER;
         PRAGMA user_version = 4;",
    )
}
