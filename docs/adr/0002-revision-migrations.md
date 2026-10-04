# Data dir changes are revision scripts with the revision stored outside the DB

Planned changes move things the DB cannot describe on its own: the archive path rule, the generation file name rule, the data dir location, and the DB file itself. So every schema or layout change is a numbered revision script in `src/migrations/`, and the applied revision lives in `<data>/REVISION`. Sync runs the pending scripts in order under `sync.lock` before opening the DB. A fresh data dir gets the latest schema from `db::SCHEMA` and is stamped with the head revision without running scripts.

The three DB schema steps that used `PRAGMA user_version` became revisions 1 to 3, and a data dir with no `REVISION` file maps `user_version` N to revision N - 1. `user_version` stays at 4 for binaries older than this change. Revision 4 stores `archive_path` relative to the data dir, so moving the data dir later does not rewrite every row.

## Considered Options

- **Keep `user_version` and add a separate layout version.** Rejected: two counters for one data dir, and the one inside the DB cannot follow the DB to a new name or location.
- **A `migrate` command the user runs.** Rejected: the wrapper upgrades the binary silently, so a user who never runs it is left with a data dir the new binary cannot read.

## Consequences

- A revision waits while a daemon of another version holds its `daemon-*.lock`, because that daemon would keep writing the old layout. The sync fails with a log line and retries on the next SessionStart hook; `doctor` shows the revision as pending.
- A binary refuses a data dir at a revision newer than its head. Binaries from before this change do not check, so going back to one after revision 4 is not supported.
