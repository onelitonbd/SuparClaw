import { markdownTheme as md, theme } from "./theme.js";
import { wrapText } from "../util/ansi.js";

// Compact Markdown -> ANSI renderer (headings, emphasis, code, quotes, lists,
// links, rules). Kept parser-free so the TUI starts without extra deps.

const INLINE =
  /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`|~~[^~]+~~|\[[^\]]+\]\([^)\s]+\))/g;

export function renderInline(text: string): string {
  return text
    .split(INLINE)
    .map((part) => {
      if (!part) return "";
      if (/^(\*\*|__)/.test(part)) return md.bold(part.replace(/^(\*\*|__)|(\*\*|__)$/g, ""));
      if (/^~~/.test(part)) return md.strikethrough(part.slice(2, -2));
      if (/^`/.test(part)) return md.code(part.slice(1, -1));
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
      if (link) return `${md.link(link[1] as string)} ${md.linkUrl(`(${link[2]})`)}`;
      if (/^(\*|_)/.test(part)) return md.italic(part.slice(1, -1));
      return part;
    })
    .join("");
}

/** Render Markdown into styled terminal lines, wrapped to `cols`. */
export function renderMarkdown(input: string, cols: number): string[] {
  const lines: string[] = [];
  const src = input.replace(/\r\n?/g, "\n").split("\n");
  let inCode = false;
  let codeBuffer: string[] = [];

  const flushCode = () => {
    const bar = md.codeBlockBorder("─".repeat(Math.max(1, Math.min(cols, 80))));
    lines.push(bar);
    for (const codeLine of codeBuffer.slice(0, 24)) {
      lines.push(md.codeBlock(`  ${codeLine}`));
    }
    if (codeBuffer.length > 24) lines.push(md.codeBlock(`  … ${codeBuffer.length - 24} more lines`));
    lines.push(bar);
    codeBuffer = [];
  };

  for (const raw of src) {
    if (raw.trim().startsWith("```")) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuffer.push(raw);
      continue;
    }

    if (raw.trim() === "") {
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(raw);
    if (heading) {
      const text = renderInline((heading[2] as string).trim());
      const level = (heading[1] as string).length;
      lines.push(level <= 2 ? md.heading(text) : md.bold(text));
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(raw)) {
      lines.push(md.hr("─".repeat(Math.max(1, Math.min(cols, 80)))));
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(raw);
    if (quote) {
      for (const line of wrapText(renderInline(quote[1] as string), Math.max(8, cols - 4))) {
        lines.push(`${md.quoteBorder("│")} ${md.quote(line)}`);
      }
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(raw);
    if (bullet) {
      for (const line of wrapText(renderInline(bullet[1] as string), Math.max(8, cols - 4))) {
        lines.push(`${md.listBullet("•")} ${line}`);
      }
      continue;
    }

    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(raw);
    if (numbered) {
      const prefix = `${theme.dim(`${numbered[1]}.`)} `;
      const wrapped = wrapText(renderInline(numbered[2] as string), Math.max(8, cols - 4));
      wrapped.forEach((line, i) => {
        lines.push(i === 0 ? `${prefix}${line}` : `  ${line}`);
      });
      continue;
    }

    for (const line of wrapText(renderInline(raw), cols)) lines.push(line);
  }

  if (inCode && codeBuffer.length > 0) flushCode();
  return lines;
}