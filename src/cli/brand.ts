// SuparClaw identity for CLI surfaces: the same mark, palette and voice the
// installer uses — the claw as half-block art, the wordmark, the tagline, 🦀.
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

// Colours are the product palette (ui/styles.css), not an invented terminal
// theme: a terminal is a dark surface, so it uses the dark-theme accent and ink.
// Semantic colours (ok/warn/error) stay semantic. `brand-mark.test.mjs` keeps
// brand/info in step with the stylesheet.
export const PALETTE = {
  accent: "38;2;142;160;255", // #8EA0FF  --accent (dark)
  accentBright: "38;2;237;237;240", // #EDEDF0  --ink (dark)
  success: "38;2;52;211;153", // mint    #34d399
  warn: "38;2;251;191;36", // amber   #fbbf24
  error: "38;2;248;113;113", // red     #f87171
  info: "38;2;148;163;184", // slate   #94a3b8
  muted: "38;2;143;143;153", // #8F8F99  --ink3 (dark)
  bold: "1",
} as const;

export const fg = {
  accent: c(PALETTE.accent),
  accentBright: c(PALETTE.accentBright),
  success: c(PALETTE.success),
  warn: c(PALETTE.warn),
  error: c(PALETTE.error),
  info: c(PALETTE.info),
  muted: c(PALETTE.muted),
  bold: c(PALETTE.bold),
};

/**
 * The claw, as terminal art: 30 columns × 9 rows, half blocks.
 *
 * Generated from the same geometry as every other mark in the repo — never
 * hand-typed. Regenerate with `node brand/tools/ascii.mjs` after changing
 * brand/tools/claw.mjs (brand-mark.test.mjs fails if this drifts).
 */
export const CLAW_ART: readonly string[] = [
  "                  ▄▄███████▄▄",
  "          ▄▄███████████▀▀▀▀▀",
  "        ▄███████████",
  "    ▄▄▄█████████████",
  "  ▄█████████████████",
  "▄██████████████████▀",
  "▀███████████████████▄▄",
  "  ▀██████████████████████▄▄",
  "    ▀██▀         ▀▀▀██████▀▀▀",
];

/**
 * The full banner: the claw, the wordmark, the tagline. Printed once per
 * command — `sc init` and `sc gateway` — so it never spams a log.
 */
export function banner(suffix = ""): string {
  const art = CLAW_ART.map((line) => `  ${fg.accent(line)}`);
  const word = `  ${fg.bold(fg.accentBright(BRAND.name))}${suffix ? `  ${fg.muted(`· ${suffix}`)}` : ""}`;
  return [...art, "", word, `  ${fg.muted(BRAND.tagline)}`].join("\n");
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
