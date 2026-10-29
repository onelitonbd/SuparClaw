// The Telegram channel as reachable from a phone: `sc telegram status` and
// `sc telegram commands`.
//
// The `/` menu is stored on the BOT TOKEN (Bot API), not in this process — which
// is why a token that once ran another build keeps that build's commands, and
// why none of this needs a running gateway. `commands` is the repair tool:
//
//   sc telegram commands              show what the token holds, and drift
//   sc telegram commands --replace    clear stale scopes, publish ours
//   sc telegram commands --purge      clear stale scopes, publish nothing
//   sc telegram commands --token t    any bot — including the ones you retired
//
// `--lang xx` also clears a language-specific list (Telegram cannot enumerate
// those, so they are opt-in).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botApiCall, telegramProxy } from "../channels/telegram.js";
import {
  buildCommandMenu,
  menuDrift,
  staleCommandScopes,
  parseTelegramArgs,
  scopeLabel,
  type CommandScope,
} from "../channels/telegram-menu.js";
import { SLASH_CATALOG } from "../agent/slash-commands.js";

const fg = {
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  red: (s: string) => `\x1b[31m${s}\x1b[39m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[39m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
};

interface MenuShape {
  command: string;
  description?: string;
}

export async function cmdTelegram(args: string[]): Promise<number> {
  const { sub, opts } = parseTelegramArgs(args);

  if (sub !== "commands" && sub !== "menu") {
    console.error("usage: sc telegram commands [--show|--replace|--purge] [--token <t>] [--lang <code>] [--json]");
    console.error("  the / menu lives on the bot token — this inspects and repairs it without a running gateway");
    return 1;
  }

  // Config + store are read lazily: `--token` alone must work even on a box with
  // no SuparClaw install (cleaning up a retired bot).
  let token = opts.token ?? "";
  let proxy = telegramProxy(undefined);
  let chatIds: string[] = [];
  let userIds: string[] = [];
  let menu: ReturnType<typeof buildCommandMenu> = [];

  let tgCfg: { token?: string; proxy?: string; allowFrom?: string[]; groupAllowFrom?: string[] } = {};
  try {
    const { readConfigFile } = await import("../config/load.js");
    const { configPath } = await import("../util/paths.js");
    tgCfg = (readConfigFile(configPath()).config?.channels?.telegram ?? {}) as typeof tgCfg;
  } catch {
    /* no config yet — --token is the only way in, and that is fine */
  }
  token = opts.token ?? tgCfg.token ?? "";
  if (!opts.token) proxy = telegramProxy(tgCfg.proxy);
  userIds = [...(tgCfg.allowFrom ?? []), ...(tgCfg.groupAllowFrom ?? [])];

  if (!token) {
    console.error(fg.red("no telegram token") + fg.dim("  — set channels.telegram.token, or pass --token <t>"));
    return 1;
  }

  // Chat ids the token can hold a scope for: sessions first, then pairing lists.
  process.env.SUPARCLAW_HOME ??= mkdtempSync(join(tmpdir(), "sc-tg-cli-"));
  try {
    const { Store } = await import("../state/db.js");
    const { dbPath } = await import("../util/paths.js");
    const store = Store.open(dbPath());
    try {
      for (const row of store.listSessions(500, { includeArchived: true })) {
        const m = /^telegram:(\d+)/.exec(String((row as { key?: string }).key ?? ""));
        if (m?.[1]) chatIds.push(m[1]);
      }
    } finally {
      store.close();
    }
  } catch {
    /* no store yet — the wildcard scopes still get cleaned */
  }
  chatIds = [...new Set([...chatIds, ...userIds])];

  // Build the same menu the gateway would, skills included.
  const { TELEGRAM_COMMANDS } = await import("../channels/telegram.js");
  let skills: { name: string; description: string; eligible: boolean; userInvocable: boolean }[] = [];
  try {
    const { Service } = await import("../agent/service.js");
    const svc = new Service();
    skills = svc.loop.skills;
    svc.store.close();
  } catch {
    /* the menu still publishes; only the per-skill entries are missing */
  }
  menu = buildCommandMenu({ catalog: SLASH_CATALOG, local: TELEGRAM_COMMANDS, skills });

  const targets = staleCommandScopes({ chatIds, userIds, langs: opts.langs });
  const report: Record<string, unknown>[] = [];
  let failures = 0;

  // Read first, so a broken token or a blocked carrier fails before we delete.
  for (const { scope, language_code } of targets) {
    const read = await botApiCall<MenuShape[]>(
      token,
      "getMyCommands",
      language_code ? { scope, language_code } : { scope },
      proxy,
    );
    if (!read.ok) {
      report.push({ scope: scopeLabel(scope, language_code), error: read.error });
      failures += 1;
      continue;
    }
    const current = read.result ?? [];
    const drift = menuDrift(current, menu);
    report.push({
      scope: scopeLabel(scope, language_code),
      count: current.length,
      commands: current.map((c) => c.command),
      drift: opts.mode === "show" ? drift : undefined,
    });
    if (current.length > 0 && opts.json === false && opts.mode === "show") {
      const flags = [
        drift.extra.length ? fg.red(`${drift.extra.length} unknown to this build`) : "",
        drift.missing.length ? fg.yellow(`${drift.missing.length} missing`) : "",
      ].filter(Boolean);
      console.log(`  ${fg.bold(scopeLabel(scope, language_code))}  ${current.length} command(s)${flags.length ? `  — ${flags.join(", ")}` : fg.green("  — matches")}`);
      if (drift.extra.length) console.log(`    ${fg.red("stale:")} ${drift.extra.slice(0, 12).join(", ")}${drift.extra.length > 12 ? " …" : ""}`);
    }
  }

  if (failures > 0 && opts.mode === "show") {
    const err = String((report.find((r) => r.error) as { error?: string })?.error ?? "");
    console.error(fg.red(`cannot read the menu: ${err}`));
    if (/unauthorized|not found/i.test(err)) console.error(fg.dim("  — the token is wrong or was revoked in BotFather"));
    return 1;
  }

  if (opts.mode !== "show") {
    let cleared = 0;
    for (const { scope, language_code } of targets) {
      type Del = { scope: CommandScope; language_code?: string };
      const params = (language_code ? { scope, language_code } : { scope }) as Del;
      const del = await botApiCall(token, "deleteMyCommands", params as unknown as Record<string, unknown>, proxy);
      if (del.ok) cleared += 1;
      else failures += 1;
    }
    let published = 0;
    if (opts.mode === "replace") {
      const set = await botApiCall(
        token,
        "setMyCommands",
        { commands: menu.map((m) => ({ command: m.command, description: m.description })), scope: { type: "default" } },
        proxy,
      );
      if (!set.ok) {
        console.error(fg.red(`could not publish the menu: ${set.error}`));
        return 1;
      }
      published = menu.length;
    }
    if (opts.json) {
      console.log(JSON.stringify({ ok: failures === 0, cleared, published, scopes: report }, null, 2));
    } else {
      console.log();
      console.log(`  ${fg.green(`${cleared} scope(s) cleared`)}${opts.mode === "replace" ? fg.green(`, ${published} command(s) published`) : fg.dim("  — nothing published (--purge)")}`);
      console.log(fg.dim("  reopen Telegram (or the chat) to see the new menu; the old one is cached on the client for a few minutes."));
    }
    return failures === 0 ? 0 : 1;
  }

  const anyDrift = report.some((r) => {
    const d = r.drift as { missing: string[]; extra: string[] } | undefined;
    return d && (d.missing.length > 0 || d.extra.length > 0);
  });
  if (opts.json) {
    console.log(JSON.stringify({ menu, scopes: report, drift: anyDrift }, null, 2));
    // Non-zero so a script can gate on "this token is not ours yet".
    return anyDrift ? 1 : 0;
  }
  console.log();
  console.log(`  ${fg.bold("this build publishes")} ${menu.length} command(s)`);
  if (anyDrift) {
    console.log();
    console.log(`  ${fg.yellow("drift found")} — repair with: ${fg.bold("sc telegram commands --replace")}`);
    return 1;
  }
  console.log(fg.green("  every scope matches this build"));
  return 0;
}
