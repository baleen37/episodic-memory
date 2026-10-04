# Data dir changes are revision scripts, recorded in the DB, with older binaries fenced off

Planned changes move things the DB cannot describe on its own: the archive path rule, the generation file name rule, the data dir location, and the DB file itself. So every schema or layout change is a numbered revision script in `src/migrations/`. Sync runs the pending scripts in order under `sync.lock` before indexing. Each script runs in one DB transaction that also records `meta.revision`, so a crash leaves the script's DB changes and the revision together or not at all. A fresh DB gets the latest schema from `db::SCHEMA` and is stamped with the head revision by `db::open`, whichever caller creates it.

Binaries from before revision 2 read a relative `archive_path` against their working directory, find no archive, and start a new generation under an absolute path, copying the source again. Two triggers on `files` (revision 3, and `db::SCHEMA`) abort any write that adds an absolute `archive_path`, which rolls back that binary's whole per-file transaction. Reads and its upserts of existing rows still work, so an older session keeps searching (with paths `read` cannot open) until it restarts. Sync therefore never waits for other daemons. `user_version` stays 4.

A DB without `meta.revision` takes its revision from `user_version`: 1 (up to v4.0.5) is revision 0; 4 is revision 1, or what `<data>/REVISION` says (written by v4.1.0, deleted once read). Revision 2 stores `archive_path` relative to the data dir, so moving the data dir later does not rewrite every row; revision 3 adds the triggers and reruns revision 2 for data dirs ending in a separator, which v4.1.0 skipped.

## Considered Options

- **Revision in a `<data>/REVISION` file** (v4.1.0). Replaced: the file and the DB could disagree after a crash, a fresh DB created by a search before the first sync had no file, and an empty file stopped every sync.
- **Wait for daemons of other versions to exit before migrating** (v4.1.0). Replaced: a daemon with a connected MCP client never exits, so indexing stopped until every older session closed.
- **Lock older binaries out with a `user_version` they reject.** Rejected: binaries up to 4.0.5 do not check it, 4.0.7's error tells the user to delete a healthy DB, and a failing revision 1 would leave a DB no binary can use.
- **A `migrate` command the user runs.** Rejected: the wrapper upgrades the binary silently, so a user who never runs it is left with a data dir the new binary cannot read.

## Consequences

- A session still on an older binary after an upgrade logs sync errors for changed files, and its search cards show paths its `read` cannot open, until it restarts on the new plugin.
- A binary refuses a data dir at a revision newer than its head.
- A revision that moves the DB file must carry `meta` with it; the revision is read from whatever `paths.db()` names.
