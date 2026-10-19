---
name: daily-journal
description: Keep a running daily journal in memory/YYYY-MM-DD.md and summarize the day on request
read_when:
  - the user asks to journal, note, or log something
  - the user asks what happened today or yesterday
  - the user wants a daily summary or recap
---

# Daily journal

The journal lives at `memory/YYYY-MM-DD.md` in the workspace, one file per day.

**Logging something the user tells you:**

1. Call `memory_append` with a single concrete line: what happened, decisions made, numbers that matter.
2. Never store secrets, tokens, or third-party private details.
3. Confirm in one short sentence: "Noted in today's journal."

**Summarizing a day:**

1. Read `memory/YYYY-MM-DD.md` with `fs_read` (today or the date requested).
2. If the file is missing, say so plainly instead of inventing content.
3. Summarize as 3–7 bullets, most important first, with decisions and open questions separated
   from narrative events.

**End-of-day maintenance:** if the user asks to tidy memory, fold stable preferences into `USER.md`
(dated directives) and durable facts into `MEMORY.md`, then delete redundant daily lines.