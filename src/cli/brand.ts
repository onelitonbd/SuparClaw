// SuparClaw identity for CLI surfaces: the same mark, palette and voice the
// installer uses. /// claw swipes + 🦀 + "your phone is the machine."
// Truecolor like the installer; NO_COLOR/TERM=dumb degrade to plain text.

export const BRAND = {
  name: "suparclaw",
  mark: "///",
  emoji: "🦀",
  tagline: "your phone is the machine.",
} as const;

const useColor =
  !process.env["NO_COLOR"] && process.env["TERM"] !== "dumb" && Boolean(process.stdout.isTTY);

const c = (code: string) => (useColor ? (s: string) => `\x1b[${code}m${s}\x1b[0m` : (s: string) => s);

export const fg = {
  accent: c("38;2;167;139;250"), // violet  #a78bfa
  accentBright: c("38;2;196;181;253"),
  success: c("38;2;52;211;153"), // mint    #34d399
  warn: c("38;2;251;191;36"), // amber   #fbbf24
  error: c("38;2;248;113;113"), // red     #f87171
  info: c("38;2;148;163;184"), // slate   #94a3b8
  muted: c("38;2;100;116;139"),
  bold: c("1"),
};

/** `/// suparclaw` — the compact banner used at command tops. */
export function brandLine(suffix = ""): string {
  return `  ${fg.accentBright(BRAND.mark)}  ${fg.bold(fg.accent(BRAND.name))}${suffix ? ` ${fg.muted(suffix)}` : ""}`;
}

/** The tagline card (open right edge — safe at phone widths). */
export function card(lines: string[], border: (s: string) => string = fg.accent): string {
  const out = [`  ${border("┌" + "─".repeat(44))}`];
  for (const line of lines) out.push(`  ${border("│")} ${line}`);
  out.push(`  ${border("└" + "─".repeat(44))}`);
  return out.join("\n");
}

export function kv(label: string, value: string): string {
  return `    ${fg.muted(label.padEnd(13))} ${value}`;
}

/** One snippy line — installers and inits should have a pulse. */
export function voiceLine(): string {
  const lines = [
    "Snip snip. Workspace ready.",
    "Small footprint. Big claw.",
    "One phone. One daemon. Zero drama.",
    "Freshly molted and ready to work.",
    "You bring the problems. I'll bring the claws.",
  ];
  return lines[Math.floor(Math.random() * lines.length)] as string;
}

export function celebrate(line: string): string {
  return `  ${fg.accentBright(BRAND.emoji)}  ${fg.bold(line)}`;
}

export interface SubsystemCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

/** `✓ store   sqlite open` — the subsystem readiness row. */
export function checkRow(check: SubsystemCheck): string {
  const mark =
    check.status === "ok"
      ? fg.success("✓")
      : check.status === "warn"
        ? fg.warn("▲")
        : fg.error("✗");
  return `    ${mark} ${check.name.padEnd(10)} ${fg.muted(check.detail)}`;
}

/** The full readiness block + an honest closing line. */
export function checklist(checks: SubsystemCheck[], title = "subsystems"): string {
  const out = [`  ${fg.muted(title)}`, ...checks.map(checkRow)];
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  if (fails > 0) {
    out.push(`\n  ${fg.error("✗")} ${fails} subsystem${fails > 1 ? "s" : ""} need${fails > 1 ? "" : "s"} attention`);
  } else if (warns > 0) {
    out.push(`\n  ${fg.warn("▲")} ready, with ${warns} note${warns > 1 ? "s" : ""}`);
  } else {
    out.push(`\n  ${fg.success("✓")} all systems connected ${BRAND.emoji}`);
  }
  return out.join("\n");
}
