# Data dir changes are revision scripts, recorded in the DB, with older binaries fenced off

Planned changes move things the DB cannot describe on its own: the archive path rule, the generation file name rule, the data dir location, and the DB file itself. So every schema or layout change is a numbered revision script in `src/migrations/`. Sync runs the pending scripts in order under `sync.lock` before indexing. Each script runs in one DB transaction that also records `meta.revision`, so a crash leaves the script's DB changes and the revision together or not at all. A fresh DB gets the latest schema from `db::SCHEMA` and is stamped with the head revision by `db::open`, whichever caller creates it.

Binaries from before revision 2 read a relative `archive_path` against their working directory, find no archive, and start a new generation under an absolute path, copying the source again. Revision 2 therefore installs `migrations::FENCE` before converting paths, and `db::open` adds it to a fresh DB: triggers on every `files` insert or update, new exchange and `meta` write compare `em_revision()`, a SQL function returning the binary's head revision, with `meta.revision`. Binaries from before revisions do not define the function, so their statements fail to prepare; a binary whose head is behind the data dir aborts. Either way the per-file transaction rolls back before it registers a file or starts a generation, and the binary cannot touch `meta` (`last_sync`, `index_version`). Reads, and search, still work. Later revisions need no new trigger. Sync therefore never waits for other daemons, and `user_version` stays 4.

A DB without `meta.revision` takes its revision from `user_version`: 1 (up to v4.0.5) is revision 0; 4 is revision 1, or what `<data>/REVISION` says (written by v4.1.0, deleted once read). Revision 2 stores `archive_path` relative to the data dir, so moving the data dir later does not rewrite every row; revision 3 reruns it, fence included, for data dirs where v4.1.0's unfenced revision 2 let older binaries keep writing absolute paths or, under a data dir ending in a separator, converted nothing.

## Considered Options

- **Revision in a `<data>/REVISION` file** (v4.1.0). Replaced: the file and the DB could disagree after a crash, a fresh DB created by a search before the first sync had no file, and an empty file stopped every sync.
- **Wait for daemons of other versions to exit before migrating** (v4.1.0). Replaced: a daemon with a connected MCP client never exits, so indexing stopped until every older session closed.
- **Lock older binaries out with a `user_version` they reject.** Rejected: binaries up to 4.0.5 do not check it, and 4.0.7's error tells the user to delete a healthy DB.
- **Triggers that reject only absolute `archive_path` values, or compare against a fixed revision.** Rejected: each later layout change would need new triggers, which `CREATE TRIGGER IF NOT EXISTS` would not even replace in existing DBs.
- **A `migrate` command the user runs.** Rejected: the wrapper upgrades the binary silently, so a user who never runs it is left with a data dir the new binary cannot read.

## Consequences

- A session still on an older binary after an upgrade logs `no such function: em_revision` for changed files, and its search cards show paths its `read` cannot open, until it restarts on the new plugin.
- Writing `files` or `meta`, or adding exchanges, from the `sqlite3` CLI fails the same way unless the connection defines `em_revision()`; reads do not.
- A binary refuses a data dir at a revision newer than its head.
- A revision that moves the DB file must carry `meta` with it; the revision is read from whatever `paths.db()` names.
