// `sc setup` — first-run wizard, and `sc provider` — provider management.
// All provider logic lives in src/config/providers.ts so the TUI, Telegram and
// the web UI share one implementation.

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ConfigService } from "../config/load.js";
import { createLogger } from "../util/log.js";
import { configPath } from "../util/paths.js";
import {
  PRESETS,
  addProvider,
  fetchModels,
  formatProviders,
  presetByName,
  removeProvider,
  testProvider,
} from "../config/providers.js";

const openConfig = () => new ConfigService(createLogger({ level: "error" }), configPath());

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx === -1 ? undefined : args[idx + 1];
}

export async function providerCmd(args: string[]): Promise<number> {
  const [sub = "list", ...rest] = args;
  const cfg = openConfig();

  switch (sub) {
    case "list":
      console.log(formatProviders(cfg.current));
      return 0;

    case "add": {
      const name = rest[0];
      if (!name) {
        console.error("usage: sc provider add <name> [--base-url URL] [--api-key KEY] [--models a,b,c]");
        console.error(`presets: ${PRESETS.map((p) => p.name).join(", ")}`);
        return 1;
      }
      const preset = presetByName(name);
      const result = await addProvider(cfg, name, {
        baseUrl: flag(rest, "--base-url") ?? preset?.baseUrl,
        apiKey: flag(rest, "--api-key") ?? "",
        models: (flag(rest, "--models") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      });
      console.log(result.message);
      return result.ok ? 0 : 1;
    }

    case "remove": {
      const name = rest[0];
      if (!name) {
        console.error("usage: sc provider remove <name>");
        return 1;
      }
      const result = removeProvider(cfg, name);
      console.log(result.message);
      return result.ok ? 0 : 1;
    }

    case "test": {
      const name = rest[0];
      if (!name) {
        console.error("usage: sc provider test <name>");
        return 1;
      }
      const result = await testProvider(cfg.current, name);
      console.log(result.message);
      return result.ok ? 0 : 1;
    }

    default:
      console.error(`unknown subcommand: ${sub}`);
      console.error("usage: sc provider <list|add|remove|test>");
      return 1;
  }
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
  const rl = createInterface({ input: stdin, output: stdout });
  const say = (s = "") => console.log(s);

  try {
    say("\nSuparClaw setup");
    say("───────────────");
    const existing = Object.keys(cfg.current.providers ?? {});
    if (existing.length > 0) say(`current providers: ${existing.join(", ")}\n`);

    say("Pick a provider:\n");
    PRESETS.forEach((p, i) => say(`  ${i + 1}. ${p.label}`));
    const answer = (await rl.question("\nnumber or name: ")).trim().toLowerCase();
    const byIndex = PRESETS[Number(answer) - 1];
    const preset = byIndex ?? presetByName(answer);
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
      if (!apiKey) say("without a key most providers will reject requests");
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
      ? ((await rl.question("provider name to save as: ")).trim() || "custom")
      : preset.name;

    const result = await addProvider(cfg, name, { baseUrl, apiKey, models });
    if (!result.ok) { say(result.message); return 1; }
    cfg.setPath("agents.defaults.model", `${name}/${models[0]}`);
    cfg.setPath("agents.defaults.fallbacks", []);

    say("");
    say(`✓ ${result.message.split("\n")[0]}`);
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
