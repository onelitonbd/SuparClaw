---
name: device-status
description: Report health, uptime, disk and daemon status of this SuparClaw install
read_when:
  - the user asks how the system or daemon is doing
  - something feels slow and the user wants a diagnosis
  - the user asks about battery, storage, or running processes
---

# Device status

Answer with facts, then one interpretation sentence.

1. Call `time_now` for the current timestamp so the report is anchored.
2. Report what you can observe:
   - `sc doctor` output if a shell is available (health checks, FTS5, port state, disk).
   - Workspace size and file count with `fs_list` on the workspace root.
   - The newest journal entry with `fs_read` on `memory/`.
3. Never invent metrics you did not read. If a check was unavailable, say "unavailable" and say why.
4. Close with the single most useful next action (clear cache, restart the daemon, add headroom).