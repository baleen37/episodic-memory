---
name: doctor
description: Diagnose the health of the memmem plugin. Invoke when memmem search returns nothing, after upgrades, or when the user asks to check that memmem is working.
version: 1.0.0
---

# Diagnose Conversation Memory

This skill checks whether the memmem plugin is healthy and tells the user how to
fix anything that is wrong. It diagnoses and suggests — it never auto-runs a fix.

## Run the diagnostic

```bash
memmem doctor
```

Each line reports one check:

- `✓ <check>` — healthy, nothing to do.
- `⚠ <check>` — degraded but usable; a suggested command can improve it.
- `✗ <check>` — broken; run the suggested command to fix it.

Checks:

| Check | Meaning | Typical fix |
|-------|---------|-------------|
| `build` | The binary is built and running | `bash scripts/build-binaries.sh` |
| `index` | Memory index passes integrity verification | `memmem sync` |
| `data`  | Records exist and are vectorized | `memmem sync` |

The exit code is `1` if any check is `✗`, otherwise `0`.

## Acting on the result

When a check reports `⚠` or `✗`, the output prints a suggested command
(`→ run: ...`). **Show the suggestion to the user and run it only after they
approve.** Do not run fixes automatically.

After running a suggested fix, re-run `memmem doctor` to confirm the check now
reports `✓`.

## Related

- [skills/setup/SKILL.md](../setup/SKILL.md) — configure the LLM provider and
  environment (run this if `data` stays empty after `memmem sync`, since
  extraction needs a configured provider).
