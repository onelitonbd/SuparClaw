---
name: self-tools
description: Build a tool for yourself when a job will happen twice — write the module, test it against real arguments, then keep it in your tool list for later sessions. Use this whenever a task needs a deterministic transformation (parsing, formatting, arithmetic, a date or unit conversion, an API call shape, a validation you keep repeating), whenever you are about to run the same `exec` command a second time, whenever the user says "make yourself a tool", "save that as a tool", "automate this", "you'll need this again", "can you just do it directly next time", or when the instructions for a job are long enough that re-deriving them every time will drift. Prefer a tool over a skill when the job is mechanical and repeatable; prefer a skill when the job needs judgement.
read_when:
  - create a tool for yourself or make a tool for later
  - automate a repeatable task or command
  - save a tool and reuse it next time
  - test the tool you just created
  - tool for exact parsing formatting or calculation
---

# Building your own tools

You can write a tool, test it, and keep it. It lands in your own tool list — the
same list `exec`, `fs_read` and the rest live in — so on every later turn you
call it by name with a schema, instead of rebuilding the same shell one-liner
from memory and hoping the quoting survived.

The tool that does this is `toolsmith`. The rest of this skill is the method:
when to build one, how to shape it, and how to test it so that "it works" means
something.

## Should this be a tool?

| The job | Right shape | Why |
|---|---|---|
| Same `exec` command, twice | **tool** | It becomes one call with named arguments, no quoting |
| Parse/convert/format data exactly | **tool** | Code is exact; prose drifts |
| A repeatable API call or URL shape | **tool** | The parameters belong in a schema, not in a prompt |
| A check you keep performing ("is this date valid", "which branch") | **tool** | It can be tested once and trusted after |
| A procedure with branches and judgement | **skill** | Instructions adapt; code would need a hundred `if`s |
| Something you will do exactly once, now | neither — just do it | A tool you use once is a file that rots |
| Something already covered by `exec`/`fs_*`/`github` | neither | Do not wrap what already has a tool |

The test is repetition: **if you would run it again, make it a tool.** If you
are unsure, do the job once by hand first; the second time is the signal.

## The contract

A tool is one ES module, `export default { name, description, parameters, run }`:

```js
export default {
  name: "word_freq",
  description: "Count the most frequent words in a text and return the top N with counts. Use for any 'most common words in this file' question.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "the text to analyse" },
      top: { type: "integer", description: "how many words to return (default 10)" },
    },
    required: ["text"],
  },
  async run({ text, top = 10 }, ctx) {
    const counts = new Map();
    for (const word of String(text).toLowerCase().match(/[a-z0-9']+/g) ?? []) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(top));
    return ranked.map(([w, n]) => `${n}\t${w}`).join("\n") || "(no words)";
  },
};
```

What you get to rely on:

- **`run(args, ctx)` returns a string.** That string is the tool result, exactly
  like any other tool. It may be `async`, and may call `fetch`, `fs`, anything
  Node has.
- **`ctx`** carries `{ workspace, stateDir, sessionKey }`. Use `ctx.workspace`
  for files the session owns, `ctx.stateDir` for state that must survive the
  session.
- **`parameters` is a JSON Schema object** (`type: "object"`, `properties`,
  optional `required`). Those names are what you will pass later — write them
  for the model you will be in three weeks, not for today's call.
- **The `description` is the trigger.** It is the only thing visible in the tool
  list, so it has to say *what it does and when to use it*. Under 400 characters.
- **`console.log` is captured**, not lost: those lines come back in the tool
  result under `[console]`. Use it while testing; strip it once the tool is right.
- **Isolation:** the module runs in a worker thread with a time limit (120 s by
  default). It cannot block the daemon, and a throw, a crash or `process.exit()`
  comes back as an `error:` line instead of taking anything down.
- **No top-level work.** The module is imported once at creation and again on
  every call. Anything at the top level runs each time — including a tool that
  fails to load, which is why `create` refuses it.

## The method

1. **Shape the job before writing code.** What goes in, what comes out, what
   the failure looks like. If you cannot name the arguments in a sentence, the
   job is not a tool yet.
2. **Write the module.** Small on purpose: one job, one return value. If it
   needs three helpers, that is fine; if it needs a framework, use a skill.
3. **Create it** — `toolsmith create` with `name` and `code`. Creation imports
   the module, reads the contract off the export and refuses anything it cannot
   describe: a syntax error, a missing `run`, a `name` that does not match, a
   description that is empty. Fix and retry; nothing is saved until it loads.
4. **Test it against real arguments.** Not `"foo"` — the actual shape the user
   gave you: their file path, their date, their empty case. `toolsmith test`
   runs it, prints the output, and records the result in the manifest. A test
   with a made-up input proves the code compiles, not that it works.
5. **Read the output like a reviewer.** Wrong sort order, off-by-one, a trailing
   newline, a missing branch → `toolsmith update` with the fixed code, then
   test again. Do not delete a tool because its first test failed; that is what
   tests are for.
6. **Use it.** From that moment it is in your tool list: call it by name. In the
   same turn, `toolsmith run` does the same thing without touching the manifest.

The loop is **write → create → test → read → update**, and it ends when a real
input produces the right answer. Say so when you report back: "made `word_freq`,
tested on your file, top word is X".

## Testing well

There is no test framework here — the tool is the unit of test, and the input is
the test case. Three tests worth running before you trust a tool:

- **The user's actual case.** The file they mentioned, the text they pasted.
- **The empty or missing case.** No matches, an empty string, a path that does
  not exist. Decide what it should say and make it say that, not a stack trace.
  ("no matches" is an answer; `TypeError: undefined` is not.)
- **The boundary.** Zero, one item, a very long line, unicode, a negative number
  — whichever the job actually touches.

If a case needs a decision only the user can make ("what should happen when the
file is missing?"), ask once, in the chat, and put the answer in the tool's
description so future-you does not re-litigate it.

## When the tool is saved

- **`toolsmith list`** shows every tool, its arguments, and whether it was ever
  tested (or which run failed last). A tool that is `never tested` is a draft —
  do not lean on it in an answer.
- **`toolsmith show <name>`** prints the source. Read it before changing it.
- **`toolsmith update`** replaces the code and keeps the creation date; the
  manifest (description + parameters) is re-derived from the new code, so edit
  the description when the behaviour changes.
- **`toolsmith delete`** needs `confirm:` repeated exactly — deleting is real.
  Delete tools that the world has outgrown; a stale tool that answers from an
  old API shape is worse than no tool.

Keep the toolbox small and sharp. A dozen well-tested tools beat forty drafts:
the list is in your context on every turn, and every entry costs attention.

## Limits and ethics

- 40 tools by default (`tools.selfTools.maxTools`), 40 KB of code, 60 KB of
  output, 120 s per call (30 s for the test's describe step). Those are guard
  rails, not targets.
- The code lives in `~/.suparclaw/tools/` as plain text — **never write a
  secret, an API key or a token into a tool**. Read it from the environment at
  call time if you need it, and say where it comes from.
- A tool runs with the daemon's permissions. Write the narrow version: read,
  compute, return. Anything that deletes, publishes or spends money is a tool
  that should require the user to ask for it in that turn, not a tool that
  fires on a hunch.
- If `tools.selfTools.enabled` is off, or exec policy is `deny`, `toolsmith`
  refuses and says so. That is a configuration decision — report it, never work
  around it with `exec`.
