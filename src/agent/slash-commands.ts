// Shared slash-command extension surface (Partial #10).
//
// service.send() already intercepts the queue-family commands (#commands in
// service.ts). This module is the second, larger half of the SAME pipeline so
// every surface — local TUI, remote TUI, web chat, Telegram — resolves the
// same command the same way instead of each keeping its own mini-parser.
// The reply text is delivered through the surface's normal reply channel and
// lands in the transcript like an assistant message (upstream matches).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Service } from "./service.js";
import { readTextSafe, workspaceDir } from "../util/paths.js";

export const SLASH_CATALOG: { cmd: string; summary: string }[] = [
  { cmd: "/help", summary: "short help summary" },
  { cmd: "/commands", summary: "full command catalog" },
  { cmd: "/status", summary: "model, tools, dreaming and runtime status" },
  { cmd: "/stop", summary: "cancel queued work, then the active run" },
  { cmd: "/queue [mode|default]", summary: "show or set this session's queue mode" },
  { cmd: "/steer <msg>", summary: "inject into the live turn (alias /tell)" },
  { cmd: "/followup <msg>", summary: "run as its own turn, queued behind work" },
  { cmd: "/subagents", summary: "sub-agent runs for this session (text view)" },
  { cmd: "/tools", summary: "tools the agent can use right now" },
  { cmd: "/skills", summary: "installed skills and readiness" },
  { cmd: "/dream [on|off|status|run|log [full]]", summary: "dreaming: toggle, status, manual sweep, diary" },
  { cmd: "/compact [instructions]", summary: "summarize older context now (recent turns stay verbatim)" },
  { cmd: "/exec [mode|global <mode>|reset]", summary: "exec approval mode for this session or globally" },
  { cmd: "/title <text>", summary: "rename the current session" },
  { cmd: "/export-session [name]", summary: "export this chat to HTML in the workspace (alias /export)" },
  { cmd: "/new", summary: "fresh session (handled by your surface: TUI rotates; web UI chat switcher)" },
];

export function slashHelp(): string {
  return [
    "suparclaw chat commands:",
    ...SLASH_CATALOG.map((c) => `  ${c.cmd.padEnd(36)} ${c.summary}`),
    "",
    "surface-local (client): /exit /quit /clear /session <key> /model [--save] (TUI) · /new (surface switcher)",
  ].join("\n");
}

export function slashCommands(): string {
  return slashHelp();
}

const htmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Minimal inline formatting for exported HTML (bold, inline code, links),
// applied AFTER escaping so exported content can never inject markup.
function inline(md: string): string {
  return htmlEscape(md)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

function renderSessionHtml(opts: { sessionKey: string; name?: string | null; messages: { role: string; content: string; createdAt?: number }[] }): string {
  const cards = opts.messages
    .map((m) => {
      const kind = m.role === "user" ? "user" : m.role === "assistant" ? "assistant" : "system";
      return `<div class="msg ${kind}"><div class="who">${kind}</div><div class="body">${inline(m.content).replace(/\n/g, "<br>")}</div></div>`;
    })
    .join("\n");
  const title = htmlEscape(opts.name?.trim() || opts.sessionKey);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — suparclaw export</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;max-width:52rem;margin:1rem auto;padding:0 1rem;color:#1c1c1e}
.msg{margin:.5rem 0;padding:.5rem .75rem;border-radius:10px}
.user{background:#e8f1ff}.assistant{background:#f3f3f5}.system{background:#fff9e6}
.who{font-size:11px;text-transform:uppercase;letter-spacing:.05em;opacity:.55;margin-bottom:2px}
code{font-family:ui-monospace,monospace;background:rgba(0,0,0,.06);padding:0 3px;border-radius:4px}
a{color:#0a5cff}
h1{font-size:1.1rem} .meta{opacity:.55;font-size:12px}
</style></head><body>
<h1>${title}</h1>
<div class="meta">session ${htmlEscape(opts.sessionKey)} · ${opts.messages.length} message(s) · exported ${new Date().toISOString()}</div>
${cards}
</body></html>`;
}

/**
 * The extension half of the chat command router. Returns the reply text when
 * the command was handled here, or null when it belongs to the built-ins
 * (service.#commands) or is unknown.
 */
export async function handleSlashExtension(
  service: Service,
  cmd: string,
  rest: string,
  payload: { sessionKey: string; isMainSession?: boolean },
): Promise<string | null> {
  switch (cmd) {
    case "/help":
      return slashHelp();
    case "/commands":
      return slashCommands();

    case "/status": {
      const cfg = service.config;
      const dreaming = cfg.memory.dreaming;
      const status = service.status() as Record<string, unknown>;
      const tools = (status.tools as unknown[]).length;
      const skills = status.skills as { name: string; eligible: boolean }[];
      const comp = service.compactionStats(payload.sessionKey);
      return [
        `model:     ${cfg.agents.defaults.model || "(unset)"}${cfg.agents.defaults.fallbacks.length ? ` · fallbacks: ${cfg.agents.defaults.fallbacks.length}` : ""}`,
        `tools:     ${tools} registered · skills: ${skills.filter((s) => s.eligible).length}/${skills.length} ready`,
        `dreaming:  ${dreaming.enabled ? `on (${dreaming.schedule})` : "off"}`,
        `compact:   ${comp ? `${comp.count} sweep(s), ${comp.chars} chars folded (upto #${comp.upto})` : "0 (transcript still fits the budget)"}`,
        `providers: ${Object.keys(service.config.providers).join(", ") || "(none)"}`,
      ].join("\n");
    }

    case "/compact": {
      // Force a rolling-summarization sweep now; optional focus text keeps
      // chosen aspects in detail (their /compact [instructions]).
      return service.compactNow(payload.sessionKey, rest.trim() || undefined);
    }

    case "/exec": {
      // Identical semantics on every surface (previously TUI-only): session
      // override by default, "global <mode>" persists, "reset" clears.
      const arg = rest.trim();
      const current = service.getSessionExecMode(payload.sessionKey);
      const global = service.approvalsState().mode;
      if (!arg) {
        return `exec mode: ${current ?? global} (${current ? "session override" : "global"}) · /exec deny|allowlist|ask|full · /exec global <mode> · /exec reset`;
      }
      if (arg === "reset") {
        service.setSessionExecMode(payload.sessionKey, null);
        return `session override cleared — exec mode: ${service.approvalsState().mode}`;
      }
      let target = arg;
      let globalScope = false;
      if (arg.startsWith("global ")) {
        target = arg.slice(7).trim();
        globalScope = true;
      }
      const m = target as "deny" | "allowlist" | "ask" | "full";
      if (!["deny", "allowlist", "ask", "full"].includes(m)) {
        return `usage: /exec [deny|allowlist|ask|full|global <mode>|reset]`;
      }
      if (globalScope) {
        const r = service.configSvc.setPath("tools.exec.mode", m);
        if (!r.ok) return `config rejected: ${r.errors.join("; ")}`;
        await service.applyConfig();
        return `global exec mode: ${m}`;
      }
      service.setSessionExecMode(payload.sessionKey, m);
      return `session exec mode: ${m}`;
    }

    case "/tools": {
      const names = service.loop.tools.map((t) => t.name);
      return names.length > 0 ? `tools (${names.length}): ${names.join(", ")}` : "no tools registered";
    }

    case "/skills": {
      const lines = service.loop.skills.map(
        (s) => `${s.eligible ? "•" : "○"} ${s.name}${s.description ? ` — ${s.description}` : ""}${s.reason ? ` [${s.reason}]` : ""}`,
      );
      return lines.length > 0 ? lines.join("\n") : "(no skills installed)";
    }

    case "/dream": {
      const sub = rest.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      switch (sub) {
        case "": {
          // Bare /dream: run a sweep in the background (upstream dream.run).
          void service.dreamNow().catch((err) => service.log.warn(`dream sweep failed: ${(err as Error).message}`));
          return "dreaming sweep started — the Memory tab shows the verdict when it settles.";
        }
        case "run":
        case "now": {
          void service.dreamNow().catch((err) => service.log.warn(`dream sweep failed: ${(err as Error).message}`));
          return "dreaming sweep started — the Memory tab shows the verdict when it settles.";
        }
        case "on": {
          const r = service.configSvc.setPath("memory.dreaming.enabled", true);
          if (!r.ok) return `config rejected: ${r.errors.join("; ")}`;
          await service.applyConfig();
          return `dreaming enabled (${service.config.memory.dreaming.schedule})`;
        }
        case "off": {
          const r = service.configSvc.setPath("memory.dreaming.enabled", false);
          if (!r.ok) return `config rejected: ${r.errors.join("; ")}`;
          await service.applyConfig();
          return "dreaming disabled";
        }
        case "status":
        case "info": {
          const s = await service.dreamStatus();
          const lines = [
            `dreaming: ${s.enabled ? "on" : "off"} · schedule ${s.schedule}${s.scheduleError ? ` (${s.scheduleError})` : ""}`,
            s.enabled ? `next run: ${s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : "?"}` : null,
            s.lastDreamAt ? `last sweep: ${new Date(s.lastDreamAt).toLocaleString()}` : "last sweep: never",
            s.lastVerdict ? `verdict: ${s.lastVerdict.slice(0, 300)}` : null,
            `memory: ${s.counts.memoryLines} curated · ${s.counts.dailyNotes} daily notes · ${s.counts.diaryEntries} diary entries · ${s.counts.staged} staged`,
          ];
          return lines.filter(Boolean).join("\n");
        }
        case "log": {
          const full = /\bfull\b/i.test(rest);
          const ws = workspaceDir();
          const diary = readTextSafe(join(ws, "DREAMS.md")) ?? "";
          if (!diary.trim()) return "no diary yet — a dream sweep writes DREAMS.md in the workspace.";
          const cap = full ? 200 : 30;
          const lines = diary.trim().split("\n");
          const tail = lines.slice(-cap);
          const dip = tail.join("\n");
          return `${dip.slice(0, full ? 8000 : 2000)}${lines.length > cap ? `\n… (${lines.length - cap} earlier line(s) hidden — /dream log full)` : ""}`;
        }
        default:
          return "usage: /dream [on|off|status|run|log [full]]";
      }
    }

    case "/title": {
      const t = rest.trim();
      // The row must exist even when the very first thing typed is a command.
      const row = service.store.ensureSession(payload.sessionKey);
      if (!t) return `session ${payload.sessionKey} is named: ${row.name || "(auto, pending first reply)"} — rename with /title <text>`;
      service.store.renameSession(row.id, t);
      service.events.emit("event", { type: "session.updated", sessionKey: payload.sessionKey, name: t });
      return `renamed to: ${t}`;
    }

    case "/export-session":
    case "/export": {
      const row = service.store.getSessionByKey(payload.sessionKey);
      if (!row) return `no session row yet for ${payload.sessionKey}`;
      const msgs = service.store.recentMessages(row.id, 100000).map((m) => ({ role: m.role, content: m.content, createdAt: m.created_at }));
      if (msgs.length === 0) return "nothing to export — this session has no messages yet.";
      const wanted = rest
        .trim()
        .replace(/[^\w.-]+/g, "-")
        .replace(/\.{2,}/g, "-")
        .replace(/^[-.]+|[-.]+$/g, "")
        .replace(/\.html+$/i, "");
      const base = wanted || `session-${payload.sessionKey.replace(/[^\w.-]+/g, "-")}.${Date.now().toString(36)}`;
      const dir = join(workspaceDir(), "exports");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${base}.html`);
      writeFileSync(file, renderSessionHtml({ sessionKey: payload.sessionKey, name: row.name, messages: msgs }), "utf8");
      return `exported ${msgs.length} message(s) → ${file}`;
    }

    default:
      return null;
  }
}
