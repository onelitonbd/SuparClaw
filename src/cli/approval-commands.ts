// `sc approvals` — the exec-approval policy surface + durable include ledger
// (their `openclaw approvals get|allowlist|resolve` + presets, our scale).
//
//   sc approvals get [--json]                     effective policy + entries
//   sc approvals list [--json]                    ledger rows only
//   sc approvals mode <deny|allowlist|ask|full>   set the global mode (config)
//   sc approvals allow <pattern> [--arg-regex re] add a manual ledger entry
//   sc approvals revoke <id>                      remove one entry
//   sc approvals preset cautious|deny-all|yolo    mode + askFallback pairing
//
// Everything works offline: the mode lands in config.json5 (a running gateway
// hot-reloads it via the directory watcher) and the ledger lives in the SQLite
// meta row the gateway reads for every decision (sc cron add precedent).
import { ConfigService } from "../config/load.js";
import { createLogger } from "../util/log.js";
import { configPath, dbPath } from "../util/paths.js";
import { Store } from "../state/db.js";
import { execModeOf } from "../config/schema.js";
import {
  addManualEntry,
  ledgerEntries,
  loadApprovalsDoc,
  revokeEntry,
} from "../agent/exec-policy.js";
import { fg } from "./brand.js";

const openConfig = () => new ConfigService(createLogger({ level: "error" }), configPath());
const openStore = () => Store.open(dbPath());

const MODES = ["deny", "allowlist", "ask", "full"] as const;

function usage(): string {
  return [
    "usage: sc approvals <get|list|mode|allow|revoke|preset>",
    "  get [--json]                         effective policy + entries",
    "  list [--json]                        allowlist ledger rows",
    "  mode <deny|allowlist|ask|full>       set the global host-exec mode",
    "  allow <pattern> [--arg-regex <re>]   trust a binary (path glob or bare name)",
    "  revoke <id>                          remove an entry (id from list)",
    "  preset <cautious|deny-all|yolo>      mode + askFallback in one step",
  ].join("\n");
}

function fmtLastUsed(ts?: number): string {
  if (!ts) return "never";
  return new Date(ts).toISOString().replace(/\.\d+Z$/, "Z");
}

export async function approvalsCmd(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const [sub = "get", ...rest] = args.filter((a) => a !== "--json");

  switch (sub) {
    case "get": {
      const cfg = openConfig();
      const exec = cfg.current.tools.exec;
      const store = openStore();
      const doc = loadApprovalsDoc(store);
      const body = {
        enabled: exec.enabled,
        mode: execModeOf(exec),
        askFallback: exec.askFallback,
        strictInlineEval: exec.strictInlineEval,
        safeBins: exec.safeBins,
        safeBinTrustedDirs: exec.safeBinTrustedDirs,
        timeoutMs: exec.timeoutMs,
        legacyBool: exec.approvals === false && exec.mode === undefined,
        entries: ledgerEntries(doc),
      };
      if (json) {
        console.log(JSON.stringify(body, null, 2));
        return 0;
      }
      console.log(`exec: enabled=${body.enabled} mode=${fg.accent(String(body.mode))} askFallback=${body.askFallback} strictInlineEval=${body.strictInlineEval}`);
      console.log(`safeBins: ${(body.safeBins ?? []).join(", ") || "(none)"} · trusted dirs: ${(body.safeBinTrustedDirs ?? []).join(", ")}`);
      if (body.legacyBool) console.log(fg.muted("note: legacy approvals:false maps to mode=full — set tools.exec.mode to make it explicit"));
      if (!body.entries.length) console.log(fg.muted("allowlist is empty — every un-matched command prompts (ask) or is denied (allowlist mode)"));
      for (const e of body.entries) {
        const kind = e.source === "allow-always" ? "always " : "manual ";
        const extra = e.source === "allow-always" ? ` cwd=${e.cwd}` : e.argPattern ? ` argv=/${e.argPattern}/` : "";
        console.log(`  ${kind}${e.id}\n    ${e.pattern}${extra}\n    last used: ${fmtLastUsed(e.lastUsedAt)}`);
      }
      return 0;
    }

    case "list": {
      const store = openStore();
      const rows = ledgerEntries(loadApprovalsDoc(store));
      if (json) {
        console.log(JSON.stringify(rows, null, 2));
        return 0;
      }
      if (!rows.length) console.log("(no allowlist entries)");
      for (const e of rows) {
        console.log(`${e.id}  ${e.source === "allow-always" ? "always" : "manual"}  ${e.pattern}${e.argPattern ? `  argv=/${e.argPattern}/` : ""}${e.cwd ? `  cwd=${e.cwd}` : ""}`);
      }
      return 0;
    }

    case "mode": {
      const mode = rest[0] ?? "";
      if (!MODES.includes(mode as (typeof MODES)[number])) {
        console.error(`mode must be one of: ${MODES.join(", ")}\n${usage()}`);
        return 1;
      }
      const cfg = openConfig();
      const result = cfg.setPath("tools.exec.mode", mode);
      if (!result.ok) {
        console.error(result.errors.join("; "));
        return 1;
      }
      console.log(`exec mode: ${mode} (a running gateway hot-reloads this instantly)`);
      return 0;
    }

    case "allow": {
      const pattern = rest.find((a) => !a.startsWith("--"));
      const argIdx = rest.indexOf("--arg-regex");
      const argPattern = argIdx >= 0 ? rest[argIdx + 1] : undefined;
      if (!pattern) {
        console.error(`allow needs a pattern\n${usage()}`);
        return 1;
      }
      const added = addManualEntry(openStore(), pattern, argPattern);
      if (!added.ok) {
        console.error(added.error ?? "invalid entry");
        return 1;
      }
      console.log(`${fg.success("trusted")} ${pattern}${argPattern ? ` (argv /${argPattern}/)` : ""} → entry ${added.entry?.id}`);
      return 0;
    }

    case "revoke": {
      const id = rest[0] ?? "";
      if (!id) {
        console.error(`revoke needs an entry id (see \`sc approvals list\`)`);
        return 1;
      }
      const removed = revokeEntry(openStore(), id);
      console.log(removed ? `${fg.success("revoked")} ${id}` : `no entry ${id}`);
      return removed ? 0 : 1;
    }

    case "preset": {
      const name = rest[0] ?? "";
      const presets: Record<string, { mode: string; askFallback: string }> = {
        cautious: { mode: "ask", askFallback: "deny" },
        "deny-all": { mode: "deny", askFallback: "deny" },
        yolo: { mode: "full", askFallback: "full" },
      };
      const preset = presets[name];
      if (!preset) {
        console.error(`preset must be one of: ${Object.keys(presets).join(", ")}`);
        return 1;
      }
      const cfg = openConfig();
      cfg.setPath("tools.exec.mode", preset.mode);
      cfg.setPath("tools.exec.askFallback", preset.askFallback);
      console.log(`preset ${name}: mode=${preset.mode} askFallback=${preset.askFallback}`);
      return 0;
    }

    default:
      console.error(usage());
      return 1;
  }
}
