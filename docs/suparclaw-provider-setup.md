# Provider setup

SuparClaw talks to any OpenAI-compatible endpoint. One provider configuration
serves every surface — CLI, TUI, Telegram and the web UI — because they all
write the same `providers` block in `~/.suparclaw/config.json5`.

## Quick start (CLI)

```sh
sc setup
```

Interactive wizard: pick a preset, paste the key (hidden input), fetch the
model list, choose a default. Presets: `openai`, `openrouter`, `groq`,
`mistral`, `ollama`, `lmstudio`, `custom`.

```sh
sc provider list                    # providers + masked keys + default model
sc provider add openrouter --api-key sk-or-…
sc provider add local --base-url http://127.0.0.1:11434/v1 --models qwen3:8b
sc provider test openrouter         # hits /models, reports what came back
sc provider remove openrouter
```

## Terminal UI (TUI)

```
/provider                       list providers
/provider add <name> [url|key] [key] [models,a,b]
/provider test <name>
/provider remove <name>
/model <provider>/<model>       override for this session
/model <provider>/<model> --save  make it the default everywhere
```

With a preset name the URL is optional: `/provider add openrouter sk-or-…`
saves under `https://openrouter.ai/api/v1`. When no models are given, they are
discovered from the endpoint's `/models`.

Ctrl+L opens the fuzzy model picker for the session.

## Telegram

Send as bot messages (owner/paired accounts only):

```
/status
/model
/model <provider>/<model>
/provider
/provider add <name> [url|key] [key] [models,a,b]
/provider test <name> · /provider remove <name>
/help
```

`/model` on Telegram changes the **default** model globally — there is no
per-chat override on this surface.

## Web UI (Control UI)

- **Settings → Providers**: table with add / edit / remove; keys are masked.
- **Model pill / Ctrl+L**: model chooser grouped by provider, with a pinned
  "＋ Add provider…" row that opens the provider form.
- Saved through the `config.set` RPC, which hot-applies to the live LLM
  client — no gateway restart.

## Behaviour shared by every surface

- Provider names are normalised to lowercase and validated (`[\w.-]`).
- Missing model list → discovered from `/models` (first 200 kept).
- Unreachable endpoint still saves; `provider test` reports the HTTP status.
- Removing the provider your default model points at warns you.
- Keys are masked in every listing (`sk-or-abc…1234` style).
