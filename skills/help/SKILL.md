---
name: help
description: Explain what this agent can do, which tools and skills are available, and how to talk to it
read_when:
  - the user asks what you can do
  - the user asks for capabilities or a feature list
  - the user seems lost about how to use the assistant
---

# Help

When asked "what can you do", answer with a short, concrete list — not a marketing paragraph.

1. State the three or four things this agent is genuinely good at on this device:
   read/write workspace files, remember notes, search and fetch the web, run the daemon
   on schedules, and reply over Telegram if a channel is configured.
2. Mention the installed skills by name (call `skill_list` first if unsure).
3. Suggest one specific next action the user could try right now.
4. If they want scheduled work, show the command: `sc cron add <name> "<schedule>" "<prompt>"`.