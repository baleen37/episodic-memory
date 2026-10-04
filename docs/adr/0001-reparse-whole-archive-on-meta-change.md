# Reparse the whole archive when file meta changes

File meta is learned incrementally from the lines appended since the last sync, so it can change after exchanges were already indexed (a Codex archive that first shows only `user_message` events and later gains `item_completed`, which changes the user signal). When a meta field that decides exchange boundaries changes, sync deletes that archive's exchanges and reparses it from line 1 instead of patching only the affected range.

## Considered Options

- **Patch only the affected exchanges.** Rejected: it needs per-provider knowledge of which earlier exchanges a meta change invalidates, which brings provider branches back into sync.
- **Ignore the change** (the behaviour before this decision). Rejected: earlier exchanges keep boundaries from the wrong user signal.

The full reparse is rare (once per archive at most for each boundary-deciding field) and keeps the rule provider-independent: any adapter whose meta changes gets the same treatment.
