---
name: reminder
description: Turn "remind me ..." requests into scheduled SuparClaw cron jobs
read_when:
  - the user asks to be reminded, pinged, or woken about something
  - the user asks for something to happen later automatically
  - the user wants a recurring check
---

# Reminder

Convert a natural-language request into one cron job, and confirm the exact time before creating it.

1. **Parse the request** into: task text, schedule, and session.
   - "in 20 minutes" → one-shot-ish expression (e.g. `*/20 * * * *` is wrong; prefer a specific
     `M H D *` or a `0 * * * *` repeat and say which you chose).
   - "every morning at 8" → `0 8 * * *`.
   - "every weekday at 9" → `0 9 * * 1-5`.
2. **Confirm before creating:** quote the exact schedule, the time it will first fire, and the prompt.
3. **Create it** with the shell command `sc cron add <name> "<schedule>" "<prompt>"`, or ask the user
   to run it themselves if shell access is disabled.
4. **Verify** with `sc cron list` and report the id plus next run time.
5. Keep jobs small: one prompt, no state files. If the job needs to remember something, it should
   append to `memory/`.