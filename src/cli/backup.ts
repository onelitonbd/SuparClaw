// `sc backup` CLI (P3 #29) — local archives, verify and restore.
import { resolve } from "node:path";
import { createBackup, listBackups, restoreBackup, verifyBackup } from "../backup/backup.js";
import { fg } from "./brand.js";

const USAGE = `usage: sc backup <subcommand> [options]

subcommands:
  create [--output <dir>] [--no-include-workspace] [--only-config] [--dry-run] [--verify] [--json]
  list [dir] [--json]
  verify <archive.tar.gz> [--json]
  restore <archive.tar.gz> --target <dir> [--force] [--json]

Creates a timestamped .tar.gz of your config, state (with a consistent
SQLite snapshot) and workspace. Existing archives are never overwritten.`;

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function flagValue(args: string[], names: string[]): string | undefined {
  for (const n of names) {
    const i = args.indexOf(n);
    if (i >= 0 && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}

export async function cmdBackup(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  const asJson = flag(rest, "--json");
  try {
    switch (sub) {
      case "create": {
        const result = await createBackup({
          outputDir: flagValue(rest, ["--output", "-o"]),
          includeWorkspace: !flag(rest, "--no-include-workspace"),
          onlyConfig: flag(rest, "--only-config"),
          dryRun: flag(rest, "--dry-run"),
          verify: flag(rest, "--verify"),
        });
        if (asJson) {
          console.log(JSON.stringify(result, null, 2));
        } else if (result.dryRun) {
          console.log(`${result.files} file(s), ${(result.bytes / 1048576).toFixed(2)} MiB would be archived`);
          for (const w of result.warnings) console.log(fg.warn(`warn: ${w}`));
        } else {
          console.log(`${fg.success("✔")} backup written: ${result.archivePath}`);
          console.log(`  ${result.files} file(s), ${(result.bytes / 1048576).toFixed(2)} MiB payload`);
          if (result.verified === true) console.log(fg.success("  verified"));
          if (result.verified === false) console.log(fg.warn("  verification reported problems (see warnings)"));
          for (const w of result.warnings) console.log(fg.warn(`  warn: ${w}`));
        }
        return result.verified === false ? 1 : 0;
      }
      case "list": {
        const dir = resolve(rest.find((a) => !a.startsWith("-")) ?? process.cwd());
        const rows = listBackups(dir);
        if (asJson) {
          console.log(JSON.stringify({ backups: rows }, null, 2));
        } else if (rows.length === 0) {
          console.log(`no suparclaw backup archives in ${dir}`);
        } else {
          for (const r of rows) {
            console.log(`${(r.size / 1048576).toFixed(2).padStart(8)} MiB  ${r.mtime.slice(0, 19).replace("T", " ")}  ${r.file}`);
          }
        }
        return 0;
      }
      case "verify": {
        const file = rest.find((a) => !a.startsWith("-"));
        if (!file) {
          console.error("usage: sc backup verify <archive.tar.gz> [--json]");
          return 2;
        }
        const v = await verifyBackup(resolve(file));
        if (asJson) {
          console.log(JSON.stringify(v, null, 2));
        } else if (v.ok) {
          console.log(`${fg.success("✔")} archive ok: ${v.files} file(s), ${(v.bytes / 1048576).toFixed(2)} MiB${v.sqliteOk === true ? ", sqlite integrity ok" : ""}`);
        } else {
          console.error(fg.error("✖ archive verification failed:"));
          for (const e of v.errors) console.error(`  - ${e}`);
        }
        return v.ok ? 0 : 1;
      }
      case "restore": {
        const file = rest.find((a) => !a.startsWith("-") && a !== flagValue(rest, ["--target"]));
        const target = flagValue(rest, ["--target"]);
        if (!file || !target) {
          console.error("usage: sc backup restore <archive.tar.gz> --target <dir> [--force] [--json]");
          return 2;
        }
        const r = await restoreBackup(resolve(file), resolve(target), { force: flag(rest, "--force") });
        if (asJson) {
          console.log(JSON.stringify(r, null, 2));
        } else {
          console.log(`${fg.success("✔")} restored ${r.restored} file(s) into ${r.target}`);
          console.log("  to use it: point SUPARCLAW_HOME at the parent of this state dir,");
          console.log("  or move the contents over ~/.suparclaw (gateway stopped).");
          for (const w of r.warnings) console.log(fg.warn(`  warn: ${w}`));
        }
        return 0;
      }
      default:
        console.log(USAGE);
        return sub === undefined || sub === "help" || sub === "--help" ? 0 : 2;
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (asJson) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(fg.error(`✖ ${msg}`));
    return 1;
  }
}
