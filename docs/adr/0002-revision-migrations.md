# Data dir changes are revision scripts, recorded in the DB and locked against older binaries

Planned changes move things the DB cannot describe on its own: the archive path rule, the generation file name rule, the data dir location, and the DB file itself. So every schema or layout change is a numbered revision script in `src/migrations/`. Sync runs the pending scripts in order under `sync.lock` before indexing. Each script runs in one DB transaction that also records `meta.revision`, so a crash leaves the script's DB changes and the revision together or not at all. A fresh DB gets the latest schema from `db::SCHEMA` and is stamped with the head revision by `db::open`, whichever caller creates it.

Every DB with `meta.revision` has `user_version` 2. Binaries from before revisions refuse it in `db::open` (4.0.7 rejects 2 and 3, 4.0.6 fails migrating 2 to 3), so a daemon of an older version still running after an upgrade cannot write a layout it does not know. Sync therefore never waits for other daemons. Binaries up to 4.0.5 do not check `user_version` and are not covered.

A DB without `meta.revision` takes its revision from `<data>/REVISION` (written by v4.1.0, then deleted) or else from `user_version`: 1 (up to v4.0.5) is revision 0, 4 is revision 1. Revision 2 stores `archive_path` relative to the data dir, so moving the data dir later does not rewrite every row; revision 3 reruns it for data dirs that v4.1.0 skipped.

## Considered Options

- **Revision in a `<data>/REVISION` file** (v4.1.0). Replaced: the file and the DB could disagree after a crash, a fresh DB created by a search before the first sync had no file, and an empty file stopped every sync.
- **Wait for daemons of other versions to exit before migrating** (v4.1.0). Replaced: a daemon with a connected MCP client never exits, so indexing stopped until every older session closed.
- **A `migrate` command the user runs.** Rejected: the wrapper upgrades the binary silently, so a user who never runs it is left with a data dir the new binary cannot read.

## Consequences

- A session still on 4.0.6 or 4.0.7 after an upgrade gets errors from search and sync until it restarts on the new plugin.
- A binary refuses a data dir at a revision newer than its head.
- A revision that moves the DB file must carry `meta` with it; the revision is read from whatever `paths.db()` names.
