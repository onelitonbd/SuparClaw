// SuparClaw TUI palette.
//
// The color values and light/dark detection follow OpenClaw's terminal theme
// (src/tui/theme/theme.ts), which is MIT licensed, Copyright OpenClaw contributors.
// Adapted here: chalk -> raw ANSI, no third-party TUI dependency.
//
// SPDX-License-Identifier: MIT

export interface TuiPalette {
  text: string;
  dim: string;
  accent: string;
  accentSoft: string;
  border: string;
  userBg: string;
  userText: string;
  systemText: string;
  toolPendingBg: string;
  toolSuccessBg: string;
  toolErrorBg: string;
  toolTitle: string;
  toolOutput: string;
  quote: string;
  quoteBorder: string;
  code: string;
  codeBorder: string;
  link: string;
  error: string;
  success: string;
}

const DARK: TuiPalette = {
  text: "#E8E3D5",
  dim: "#7B7F87",
  accent: "#F6C453",
  accentSoft: "#F2A65A",
  border: "#3C414B",
  userBg: "#2B2F36",
  userText: "#F3EEE0",
  systemText: "#9BA3B2",
  toolPendingBg: "#1F2A2F",
  toolSuccessBg: "#1E2D23",
  toolErrorBg: "#2F1F1F",
  toolTitle: "#F6C453",
  toolOutput: "#E1DACB",
  quote: "#8CC8FF",
  quoteBorder: "#3B4D6B",
  code: "#F0C987",
  codeBorder: "#343A45",
  link: "#7DD3A5",
  error: "#F97066",
  success: "#7DD3A5",
};

const LIGHT: TuiPalette = {
  text: "#1E1E1E",
  dim: "#5B6472",
  accent: "#B45309",
  accentSoft: "#C2410C",
  border: "#5B6472",
  userBg: "#F3F0E8",
  userText: "#1E1E1E",
  systemText: "#4B5563",
  toolPendingBg: "#EFF6FF",
  toolSuccessBg: "#ECFDF5",
  toolErrorBg: "#FEF2F2",
  toolTitle: "#B45309",
  toolOutput: "#374151",
  quote: "#1D4ED8",
  quoteBorder: "#2563EB",
  code: "#92400E",
  codeBorder: "#92400E",
  link: "#047857",
  error: "#DC2626",
  success: "#047857",
};

function xtermCubeLevel(index: number): number {
  return index === 0 ? 0 : 55 + index * 40;
}

function channelToSrgb(value: number): number {
  const n = value / 255;
  return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * channelToSrgb(r) + 0.7152 * channelToSrgb(g) + 0.0722 * channelToSrgb(b);
}

function contrastRatio(bg: number, fgHex: string): number {
  const fg = relativeLuminance(
    Number.parseInt(fgHex.slice(1, 3), 16),
    Number.parseInt(fgHex.slice(3, 5), 16),
    Number.parseInt(fgHex.slice(5, 7), 16),
  );
  const lighter = Math.max(bg, fg);
  const darker = Math.min(bg, fg);
  return (lighter + 0.05) / (darker + 0.05);
}

/** SUPARCLAW_THEME=light|dark wins; otherwise infer from the terminal background. */
export function detectLightMode(env: Record<string, string | undefined> = process.env): boolean {
  const explicit = env["SUPARCLAW_THEME"]?.toLowerCase();
  if (explicit === "light") return true;
  if (explicit === "dark") return false;

  const colorfgbg = env["COLORFGBG"];
  if (colorfgbg && colorfgbg.length <= 64) {
    const sep = colorfgbg.lastIndexOf(";");
    const bg = Number.parseInt(colorfgbg.slice(sep + 1), 10);
    if (Number.isFinite(bg) && bg >= 0 && bg <= 255) {
      if (bg <= 15) return bg === 7 || bg === 15;
      if (bg >= 232) return bg >= 244;
      const cube = bg - 16;
      const luminance = relativeLuminance(
        xtermCubeLevel(Math.floor(cube / 36)),
        xtermCubeLevel(Math.floor(cube / 6) % 6),
        xtermCubeLevel(cube % 6),
      );
      return contrastRatio(luminance, LIGHT.text) >= contrastRatio(luminance, DARK.text);
    }
  }
  return false;
}

export const isLight = detectLightMode();
export const palette: TuiPalette = isLight ? LIGHT : DARK;

// --- ANSI helpers ---------------------------------------------------------

function sgr(open: number, close: number) {
  return (text: string) => `\x1b[${open}m${text}\x1b[${close}m`;
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

export const fg = (hex: string) => (text: string) => {
  if (!text) return "";
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
};

export const bg = (hex: string) => (text: string) => {
  if (!text) return "";
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[48;2;${r};${g};${b}m${text}\x1b[49m`;
};

export const bold = sgr(1, 22);
export const dimAnsi = sgr(2, 22);
export const italic = sgr(3, 23);
export const underline = sgr(4, 24);
export const inverse = sgr(7, 27);
export const strike = sgr(9, 29);

export const theme = {
  text: fg(palette.text),
  dim: fg(palette.dim),
  accent: fg(palette.accent),
  accentSoft: fg(palette.accentSoft),
  border: fg(palette.border),
  system: fg(palette.systemText),
  link: fg(palette.link),
  quote: fg(palette.quote),
  code: fg(palette.code),
  error: fg(palette.error),
  success: fg(palette.success),
  toolTitle: fg(palette.toolTitle),
  toolOutput: fg(palette.toolOutput),
  toolPendingBg: bg(palette.toolPendingBg),
  toolSuccessBg: bg(palette.toolSuccessBg),
  toolErrorBg: bg(palette.toolErrorBg),
  userBg: bg(palette.userBg),
  userText: fg(palette.userText),
  header: (text: string) => bold(fg(palette.accent)(text)),
  bold,
  italic,
  underline,
  strike,
};

export const markdownTheme = {
  heading: theme.header,
  link: fg(palette.link),
  linkUrl: (t: string) => fg(palette.dim)(t),
  code: fg(palette.code),
  codeBlock: fg(palette.code),
  codeBlockBorder: fg(palette.codeBorder),
  quote: fg(palette.quote),
  quoteBorder: fg(palette.quoteBorder),
  hr: fg(palette.border),
  listBullet: fg(palette.accentSoft),
  bold,
  italic,
  strikethrough: strike,
  underline,
};