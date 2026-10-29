# Agent skills (vendored from the AITMPL Skill Hub)

These are working instructions for whoever (human or agent) builds on this
repo. They are **vendored copies** of skills from
[aitmpl.com/skills](https://www.aitmpl.com/skills/) — the skill catalog of
[`davila7/claude-code-templates`](https://github.com/davila7/claude-code-templates)
(MIT, see `LICENSE-aitmpl`). Kept inside the repo so they survive sandbox /
workstation restarts and travel with every clone.

## Standing rule — read this first

**Before starting any task:**

1. **Research** (existing rule): read the relevant parts of the vendored
   OpenClaw docs in `docs/openclaw/` *and* check the internet for the current
   state of the upstream project.
2. **Load skills** (this rule): open the `SKILL.md` of every skill below that
   matches the task's domain and follow its guidance while working.

| Task kind | Skills to load |
|---|---|
| Any new feature / change | `brainstorming` (intent first), then the domain rows below |
| Architecture, tech-stack, integration decisions | `senior-architect` |
| End-to-end product work | `senior-fullstack` |
| Anything in `ui/` (React/Tailwind, components, performance) | `senior-frontend`, `react-best-practices` |
| Anything in `src/` (Node server, tools, storage, security) | `senior-backend`, `senior-security` |
| Visual direction / look-and-feel / new screens | `ui-ux-pro-max`, `frontend-design`, `ui-design-system` |
| Any code change, before commit | `clean-code`, `code-reviewer`, `git-commit-helper` |
| Testing / verifying UI or flows | `webapp-testing` |
| Mobile-shaped work (Termux, touch layout) | `mobile-design` |
| LLM / agent / prompt behavior | `senior-prompt-engineer` |
| MCP servers or external integrations | `mcp-builder` |
| Creating or improving skills | `skill-creator` |
| Standalone visual assets (posters, art) | `canvas-design` |
| Word / slides / PDF deliverables | `docx`, `pptx`, `pdf-processing-pro` |

## The vault

Tier 1 — core foundation (load first, covers ~80% of any job):

| # | Skill folder | What it adds |
|---|---|---|
| 1 | `senior-architect/` | System design, architecture, tech-stack decisions |
| 2 | `senior-fullstack/` | End-to-end app building, scaffolding, code quality |
| 3 | `senior-frontend/` | React/Next/TS/Tailwind components, performance |
| 4 | `senior-backend/` | Node/Go/Python, DBs, APIs, auth, perf |
| 5 | `ui-ux-pro-max/` | 50 styles, palettes, font pairings, full UI workflow |
| 6 | `brainstorming/` | Mandatory pre-build intent & requirements thinking |

Tier 2 — quality & craft:

| # | Skill folder | What it adds |
|---|---|---|
| 7 | `frontend-design/` | Distinctive visual direction, anti-"default" taste |
| 8 | `clean-code/` | Pragmatic standards, no over-engineering |
| 9 | `code-reviewer/` | Multi-language review + security scan |
| 10 | `ui-design-system/` | Design tokens, component docs, handoff |
| 11 | `react-best-practices/` | Rendering, waterfalls, bundle optimization |
| 12 | `webapp-testing/` | Playwright functional tests, screenshots |
| 13 | `senior-security/` | AppSec, threat modeling, auditing |

Tier 3 — specialized levers (pull in on demand):

| # | Skill folder | What it adds |
|---|---|---|
| 14 | `mobile-design/` | iOS/Android conventions, touch, perf |
| 15 | `senior-prompt-engineer/` | LLM prompts, RAG, agent design |
| 16 | `mcp-builder/` | MCP servers (Python & TS) |
| 17 | `skill-creator/` | Author, edit, benchmark skills |
| 18 | `canvas-design/` | Original visual art / posters |
| 19 | `git-commit-helper/` | Diff-aware commit messages |
| 20 | `docx/` + `pptx/` + `pdf-processing-pro/` | Professional documents & decks |

## Refreshing

To update to the newest skill versions:

```bash
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/davila7/claude-code-templates /tmp/aitmpl
cd /tmp/aitmpl && git sparse-checkout set cli-tool/components/skills
# copy the folders listed in the table above, overwriting docs/skills/<name>/
```
