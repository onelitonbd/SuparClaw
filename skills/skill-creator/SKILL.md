---
name: skill-creator
description: Create new skills, capture workflows as reusable skills, and improve existing skills. Use whenever the user wants to create a skill, save a workflow or procedure for later, turn something from this conversation into a skill, edit or optimize an existing skill, or says things like "save that as a skill", "remember how to do this", "make a skill for", "teach yourself how to".
---

# Skill Creator

A skill for creating new skills and iteratively improving them. Adapted from
Anthropic's `skill-creator` (github.com/anthropics/skills) for SuparClaw — the
creation methodology is theirs; the tooling here is SuparClaw's.

At a high level, the process of creating a skill goes like this:

- Decide what you want the skill to do and roughly how it should do it
- Write a draft of the skill
- Save it with the `skill_save` tool (or ask nothing — just show it to the user)
- Try it: read it back with `skill_read` and walk through a realistic request
- Get the user's feedback, rewrite, and repeat until it feels right

Your job when using this skill is to figure out where the user is in this
process and then jump in and help them progress through these stages. Maybe
they say "I want to make a skill for X" — narrow down what they mean, write a
draft, save it, and iterate. Maybe they already have a workflow in this
conversation and say "turn this into a skill" — extract it from the history
instead of interviewing from scratch. Maybe they already have a draft — go
straight to the improve loop.

Always be flexible: if the user says "just vibe with me, skip the tests", do
that instead.

## Communicating with the user

The skill creator gets used by people across a very wide range of familiarity
with technical jargon. Pay attention to context cues for how to phrase things.
In the default case:

- "workflow" and "triggering" are borderline, but OK
- for "frontmatter", "JSON", "slug", or "eval" only use those words when the
  user has shown they know them, or briefly explain them

It's OK to briefly explain terms if you're in doubt.

---

## Creating a skill

### Capture Intent

Start by understanding the user's intent. The current conversation might
already contain the workflow to capture (e.g. "turn this into a skill"). If so,
extract answers from the conversation history first — the tools used, the
sequence of steps, corrections the user made, input/output formats observed.
The user may need to fill the gaps, and should confirm before you proceed.

1. What should this skill enable the agent to do?
2. When should this skill trigger? (what user phrases/contexts)
3. What's the expected output format?

### Interview and Research

Proactively ask about edge cases, input/output formats, example inputs, success
criteria, and dependencies. Come prepared with context to reduce the burden on
the user. If the skill concerns a tool or API you can look up, do that research
before drafting.

### Write the SKILL.md

Based on the interview, fill in these components:

- **name**: Skill identifier — 1-64 lowercase letters, numbers, or hyphens
- **description**: When to trigger, what it does. This is the primary
  triggering mechanism — include both what the skill does AND specific contexts
  for when to use it. All "when to use" info goes here, not in the body. Note:
  agents have a tendency to "undertrigger" skills — to not use them when they'd
  be useful. To combat this, make the skill descriptions a little bit "pushy".
  So instead of "How to build a simple fast dashboard.", write "How to build a
  simple fast dashboard. Use this skill whenever the user mentions dashboards,
  data visualization, or wants to display any kind of internal data, even if
  they don't explicitly ask for a 'dashboard.'"
- **the rest of the skill** (the Markdown body)

Save the finished skill with the `skill_save` tool — it writes
`skills/NAME/SKILL.md` in the workspace with the frontmatter filled in. The
Settings page's Skills tab shows the same file, and the skill becomes usable
immediately.

### Skill Writing Guide

#### Anatomy of a Skill

```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name, description required)
│   └── Markdown instructions
└── Bundled Resources (optional)
    ├── scripts/    - Executable code for deterministic/repetitive tasks
    ├── references/ - Docs loaded into context as needed
    └── assets/     - Files used in output (templates, icons, fonts)
```

#### Progressive Disclosure

Skills use a three-level loading system:

1. **Metadata** (name + description) - Always in context (~100 words)
2. **SKILL.md body** - In context whenever the skill triggers (<500 lines ideal)
3. **Bundled resources** - As needed (unlimited; scripts can execute without
   loading)

**Key patterns:**

- Keep SKILL.md under 500 lines; if approaching this limit, add an additional
  layer of hierarchy with clear pointers about where to go next
- Reference files clearly from SKILL.md with guidance on when to read them
- For large reference files (>300 lines), include a table of contents

**Domain organization**: When a skill supports multiple domains/frameworks,
organize by variant — the reader loads only the relevant reference file.

#### Principle of Lack of Surprise

Skills must not contain malware, exploit code, or any content that could
compromise system security. A skill's contents should not surprise the user in
their intent as described. Don't create misleading skills or skills designed to
facilitate unauthorized access, data exfiltration, or other malicious
activities. "Roleplay as an XYZ" style skills are OK though.

#### Writing Patterns

Prefer using the imperative form in instructions.

**Defining output formats** — pin an exact template:

```markdown
## Report structure
ALWAYS use this exact template:
# TITLE
## Executive summary
## Key findings
## Recommendations
```

**Examples pattern** — include examples (deviate a little from the exact
Input/Output shapes below so they read naturally):

```markdown
## Commit message format
**Example 1:**
Input: Added user authentication with JWT tokens
Output: feat(auth): implement JWT-based authentication
```

### Writing Style

Explain to the model why things are important in lieu of heavy-handed musty
MUSTs. Use theory of mind and make the skill general, not super-narrow to
specific examples. Start with a draft, then look at it with fresh eyes and
improve it.

### Test Cases

After writing the draft, come up with 2-3 realistic test prompts — the kind of
thing a real user would actually say. Share them with the user: "Here are a few
test cases I'd like to try. Do these look right, or do you want to add more?"
Then try the skill against them in conversation (read it with `skill_read` and
roleplay the request) and fix what surfaces.

## Improving the skill

### How to think about improvements

When a run goes wrong, diagnose before rewriting:

- **Never triggered** — the description doesn't cover the phrasing the user
  used. Widen the trigger language; make it pushier.
- **Triggered but followed the wrong steps** — the body is ambiguous or the
  order is unclear. Tighten the workflow; add the missing branch.
- **Triggered too eagerly** — the description is too broad. Add negative scope
  ("not for ...").

### The iteration loop

1. Save the change with `skill_save` (same name overwrites the file)
2. Re-read it (`skill_read`) and try the failing case again
3. Repeat until satisfied, then expand the test set and try at a larger scale

## Description Optimization

The description is how the skill triggers — worth polishing on its own:

### Step 1: Generate trigger queries

Write 5-10 phrases a user might say that SHOULD trigger this skill, and 3-5
that should NOT.

### Step 2: Check with the user

"Here are the phrases I think should trigger it — anything missing?"

### Step 3: Adjust

Fold the missing phrasings into the description (pushy, but natural). Re-check
the negative cases still stay out.

### How skill triggering works

SuparClaw matches each incoming message against every skill's name and
description (plus any `read_when` phrases in the frontmatter), and the catalog
of name + description is always in the model's context. Rich, phrase-heavy
descriptions trigger reliably; clever bodies don't help at all if the
description is thin.

---

When you finish, tell the user what was saved and suggest a sentence they can
say later to test that it triggers.
