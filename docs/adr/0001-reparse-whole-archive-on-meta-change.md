# Reparse the whole archive when file meta changes

File meta is learned incrementally from the lines appended since the last sync, so it can change after exchanges were already indexed (a Codex archive that first shows only `user_message` events and later gains `item_completed`, which changes the user signal; a Claude Code archive whose first lines carry no `cwd` or `sessionId`). When any file meta field changes, sync deletes that archive's exchanges and reparses it from line 1 instead of patching only the affected range. Fields that decide exchange boundaries and fields copied onto every exchange (session, project, sidechain flag) get the same treatment.

## Considered Options

- **Patch only the affected exchanges.** Rejected: it needs per-provider knowledge of which earlier exchanges a meta change invalidates, which brings provider branches back into sync.
- **Update the copied fields of earlier exchanges in place, reparse only for boundary fields.** Rejected: a second write path for exchanges (and for `vec_exchanges`, which has no FKs) that a reparse already covers.
- **Ignore the change** (the behaviour before this decision). Rejected: earlier exchanges keep boundaries from the wrong user signal.

The full reparse is rare (file meta only grows, so at most a few times per archive, usually while it is still short) and keeps the rule provider-independent: any adapter whose meta changes gets the same treatment.
