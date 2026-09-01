---
name: doctor
description: Diagnose the health of the episodic-memory plugin. Invoke when episodic-memory search returns nothing, after upgrades, or when the user asks to check that episodic-memory is working.
version: 1.0.0
---

# Diagnose Conversation Memory

This skill checks whether the episodic-memory plugin is healthy and tells the user how to
fix anything that is wrong. It diagnoses and suggests — it never auto-runs a fix.

## Run the diagnostic

```bash
episodic-memory doctor
```

Each line reports one check:

- `✓ <check>` — healthy, nothing to do.
- `⚠ <check>` — degraded but usable; a suggested command can improve it.
- `✗ <check>` — broken; run the suggested command to fix it.

Checks:

| Check | Meaning | Typical fix |
|-------|---------|-------------|
| `build` | `dist/` is rebuilt after the latest `src` change | `bun run build` |
| `index` | Memory index passes integrity verification | `episodic-memory sync` |
| `data`  | Records exist and are vectorized | `episodic-memory sync` |

The exit code is `1` if any check is `✗`, otherwise `0`.

## Acting on the result

When a check reports `⚠` or `✗`, the output prints a suggested command
(`→ run: ...`). **Show the suggestion to the user and run it only after they
approve.** Do not run fixes automatically.

After running a suggested fix, re-run `episodic-memory doctor` to confirm the check now
reports `✓`.

## Related

- [skills/setup/SKILL.md](../setup/SKILL.md) — configure the LLM provider and
  environment (run this if `data` stays empty after `episodic-memory sync`, since
  extraction needs a configured provider).
