// `sc setup` — first-run wizard, and `sc provider` — provider management.
// Everything here writes through ConfigService, so changes apply live.

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { SuparClawConfig } from "../config/schema.js";
import { ConfigService } from "../config/load.js";
import { createLogger } from "../util/log.js";
import { configPath } from "../util/paths.js";

const openConfig = () => new ConfigService(createLogger({ level: "error" }), configPath());

export interface Preset {
  name: string;
  label: string;
  baseUrl: string;
  needsKey: boolean;
  note?: string;
}

export const PRESETS: Preset[] = [
  { name: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", needsKey: true },
  { name: "openrouter", label: "OpenRouter (many models, one key)", baseUrl: "https://openrouter.ai/api/v1", needsKey: true },
  { name: "groq", label: "Groq (fast, cheap)", baseUrl: "https://api.groq.com/openai/v1", needsKey: true },
  { name: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", needsKey: true },
  { name: "ollama", label: "Ollama (on this device)", baseUrl: "http://127.0.0.1:11434/v1", needsKey: false },
  { name: "lmstudio", label: "LM Studio (on this device)", baseUrl: "http://127.0.0.1:1234/v1", needsKey: false },
  { name: "custom", label: "Custom OpenAI-compatible URL", baseUrl: "", needsKey: true },
];

/** Ask a provider for its model list. Returns [] when unreachable. */
export async function fetchModels(baseUrl: string, apiKey: string): Promise<{ models: string[]; error?: string }> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const res = await fetch(url, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return { models: [], error: `HTTP ${res.status}` };
    const body = (await res.json()) as { data?: { id?: string }[] };
    const models = (body.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    return { models };
  } catch (err) {
    return { models: [], error: (err as Error).message };
  }
}

export async function providerCmd(args: string[]): Promise<number> {
  const [sub = "list", ...rest] = args;
  const cfg = openConfig();
  const config = cfg.current;

  switch (sub) {
    case "list": {
      const names = Object.keys(config.providers ?? {});
      if (names.length === 0) {
        console.log("no providers yet.");
        console.log("  sc setup                    guided setup");
        console.log("  sc provider add openrouter  or any preset: " + PRESETS.map((p) => p.name).join(", "));
        return 0;
      }
      const current = config.agents?.defaults?.model ?? "(unset)";
      console.log(`providers (default model: ${current})\n`);
      for (const name of names) {
        const p = config.providers[name] as { baseUrl?: string; apiKey?: string; models?: string[] };
        const key = p.apiKey ? `${p.apiKey.slice(0, 6)}…${p.apiKey.slice(-4)}` : "(none)";
        console.log(`  ${name}`);
        console.log(`    url    ${p.baseUrl ?? ""}`);
        console.log(`    key    ${key}`);
        console.log(`    models ${(p.models ?? []).join(", ") || "(none listed)"}`);
      }
      return 0;
    }

    case "add": {
      const name = rest[0];
      if (!name) {
        console.error("usage: sc provider add <name> [--base-url URL] [--api-key KEY] [--models a,b,c]");
        return 1;
      }
      const preset = PRESETS.find((p) => p.name === name);
      const baseUrl = flag(rest, "--base-url") ?? preset?.baseUrl ?? "";
      const apiKey = flag(rest, "--api-key") ?? "";
      const models = (flag(rest, "--models") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!baseUrl) {
        console.error("a base url is required: --base-url https://…/v1");
        return 1;
      }
      const next = { ...(config.providers ?? {}), [name]: { baseUrl, apiKey, models } };
      const saved = cfg.setPath("providers", next);
      if (!saved.ok) {
        console.error(`could not save: ${saved.errors.join("; ")}`);
        return 1;
      }
      console.log(`provider "${name}" saved`);
      if (models.length === 0) {
        const found = await fetchModels(baseUrl, apiKey);
        if (found.models.length > 0) {
          const cfg2 = openConfig();
          cfg2.setPath(`providers.${name}.models`, found.models.slice(0, 200));
          console.log(`discovered ${found.models.length} models from ${baseUrl}`);
        } else {
          console.log(`no models discovered (${found.error ?? "empty list"}) — pass --models a,b,c`);
        }
      }
      console.log(`set a default with: sc config set agents.defaults.model "${name}/<model>"`);
      return 0;
    }

    case "remove": {
      const name = rest[0];
      if (!name || !config.providers?.[name]) {
        console.error(name ? `no such provider: ${name}` : "usage: sc provider remove <name>");
        return 1;
      }
      const next = { ...config.providers };
      delete next[name];
      cfg.setPath("providers", next);
      console.log(`removed "${name}"`);
      return 0;
    }

    case "test": {
      const name = rest[0];
      const p = name ? config.providers?.[name] : undefined;
      if (!p) {
        console.error(name ? `no such provider: ${name}` : "usage: sc provider test <name>");
        return 1;
      }
      const found = await fetchModels(p.baseUrl ?? "", p.apiKey ?? "");
      if (found.error) {
        console.error(`${name}: unreachable — ${found.error}`);
        console.error(`  check the url (${p.baseUrl}) and that the device is online`);
        return 1;
      }
      console.log(`${name}: ok — ${found.models.length} models`);
      for (const m of found.models.slice(0, 12)) console.log(`  ${m}`);
      if (found.models.length > 12) console.log(`  … and ${found.models.length - 12} more`);
      return 0;
    }

    default:
      console.error(`unknown subcommand: ${sub}`);
      console.error("usage: sc provider <list|add|remove|test>");
      return 1;
  }
}

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx === -1 ? undefined : args[idx + 1];
}

/** Ask without echoing. Falls back to plain input when stdin is not a TTY. */
async function askHidden(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  if (!stdin.isTTY) return (await rl.question(prompt)).trim();
  rl.pause();
  stdout.write(prompt);
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return await new Promise<string>((resolve) => {
    let buf = "";
    const done = (value: string) => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      rl.resume();
      stdout.write("\n");
      resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done(buf);
        if (ch === "\u0003") return done(""); // ctrl+c aborts the entry
        if (ch === "\u007f" || ch === "\b") { buf = buf.slice(0, -1); continue; }
        buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** `sc setup`: walk a first-time user from nothing to a working model. */
export async function setupCmd(): Promise<number> {
  const cfg = openConfig();
  const config: SuparClawConfig = cfg.current;
  const rl = createInterface({ input: stdin, output: stdout });
  const say = (s = "") => console.log(s);

  try {
    say("\nSuparClaw setup");
    say("───────────────");
    const existing = Object.keys(config.providers ?? {});
    if (existing.length > 0) say(`current providers: ${existing.join(", ")}\n`);

    say("Pick a provider:\n");
    PRESETS.forEach((p, i) => say(`  ${i + 1}. ${p.label}`));
    const answer = (await rl.question("\nnumber or name: ")).trim().toLowerCase();
    const byIndex = PRESETS[Number(answer) - 1];
    const preset = byIndex ?? PRESETS.find((p) => p.name === answer);
    if (!preset) {
      say("unknown provider");
      return 1;
    }

    let baseUrl = preset.baseUrl;
    if (preset.name === "custom" || !preset.baseUrl) {
      baseUrl = (await rl.question("base url (https://…/v1): ")).trim();
      if (!baseUrl) { say("a base url is required"); return 1; }
    }

    let apiKey = "";
    if (preset.needsKey) {
      apiKey = await askHidden(rl, "api key (hidden): ");
      if (!apiKey) { say("without a key most providers will reject requests"); }
    } else {
      say(`\n${preset.label} needs no key.`);
    }

    say(`\nchecking ${baseUrl} …`);
    const found = await fetchModels(baseUrl, apiKey);
    let models = found.models;
    if (models.length === 0) {
      say(`could not read a model list (${found.error ?? "empty"})`);
      const manual = (await rl.question("models, comma separated (leave blank to skip): ")).trim();
      models = manual.split(",").map((s) => s.trim()).filter(Boolean);
      if (models.length === 0) {
        say("nothing saved — add a reachable provider and run `sc setup` again");
        return 1;
      }
    } else {
      say(`found ${models.length} models:\n`);
      models.slice(0, 15).forEach((m, i) => say(`  ${i + 1}. ${m}`));
      if (models.length > 15) say(`  … and ${models.length - 15} more`);
      const pick = (await rl.question(`\nmodel number (1-${Math.min(15, models.length)}, or leave blank for the first): `)).trim();
      const idx = Number(pick) - 1;
      models = pick && models[idx] ? [models[idx] as string, ...models.filter((_, i) => i !== idx)] : models;
    }

    const name = preset.name === "custom"
      ? (await rl.question("provider name to save as: ")).trim() || "custom"
      : preset.name;

    const saved = cfg.setPath(`providers.${name}`, { baseUrl, apiKey, models });
    if (!saved.ok) { say(`could not save: ${saved.errors.join("; ")}`); return 1; }
    cfg.setPath("agents.defaults.model", `${name}/${models[0]}`);
    cfg.setPath("agents.defaults.fallbacks", []);

    say("");
    say(`✓ provider "${name}" saved`);
    say(`✓ default model  ${name}/${models[0]}`);
    say("");
    say("next:");
    say("  sc gateway            start the gateway (web UI on http://127.0.0.1:18790/)");
    say("  sc chat               terminal chat");
    say("  sc doctor             check everything is wired up");
    return 0;
  } finally {
    rl.close();
  }
}
