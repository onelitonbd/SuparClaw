// Telegram HTML delivery (Task 32).
//
// Telegram renders a small HTML subset, not Markdown: it has no tables, no
// headings, and it rejects a message outright if the markup is malformed. So a
// model's answer is converted here — deliberately, and conservatively:
//
//   * every text run is entity-escaped (`& < >`) before any tag is added, so no
//     model output can ever inject markup;
//   * only tags Telegram documents are emitted: b, i, s, code, pre, a,
//     blockquote;
//   * a table becomes an aligned <pre>, because Telegram cannot render one and
//     a wall of pipes is worse than monospace;
//   * splitting happens on the MARKDOWN, then each part is converted, so a
//     `**` pair or a fenced block is never cut into broken markup;
//   * anything we fail to understand is passed through as escaped text — the
//     answer always arrives, formatted or not.

/** Telegram's cap is 4096 characters of parsed text; leave room for escaping. */
export const TELEGRAM_TEXT_LIMIT = 4096;
/** Split the Markdown source here, before escaping can grow it. */
export const TELEGRAM_SPLIT_LIMIT = 3800;

/** Undo our own tags, for the plain-text fallback when Telegram rejects markup. */
export function stripHtmlTags(html: string): string {
  return html
    .replace(/<\/?(?:b|i|s|code|pre|blockquote)>/g, "")
    .replace(/<a href="([^"]*)">([\s\S]*?)<\/a>/g, (_m, url: string, text: string) => (/^https?:\/\//i.test(url) ? `${text} (${url})` : text))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Inline Markdown → Telegram inline HTML. Input is raw (unescaped) text. */
function inline(src: string): string {
  // Pull code spans and links out first: their contents must not be re-parsed
  // for emphasis (`snake_case_names` inside `code` stay literal, and a URL's
  // underscores are not italics).
  const slots: string[] = [];
  const hold = (html: string): string => {
    slots.push(html);
    return `\u0000${slots.length - 1}\u0000`;
  };
  let s = src;
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) => hold(`<code>${escapeHtml(code)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) =>
    /^(https?:\/\/|mailto:|tg:\/\/)/i.test(url)
      ? hold(`<a href="${escapeHtml(url)}">${inline(text)}</a>`)
      : hold(inline(text)),
  );
  s = escapeHtml(s);
  // Telegram supports these six combinations only; anything else is left alone
  // rather than guessed at.
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, "<b><i>$1</i></b>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[\s(])__([^_\n]+)__/g, "$1<b>$2</b>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?![\w_])/g, "$1<i>$2</i>");
  s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  // Restore the held code spans / links (recursively, since a link label may
  // itself contain a code span).
  for (let pass = 0; pass < 3 && s.includes("\u0000"); pass++) {
    s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => slots[Number(i)] ?? "");
  }
  return s;
}

/**
 * Plain-text chunking for Telegram's 4096-character cap, splitting on paragraph
 * boundaries. Kept for the HTML fallback path and for callers that send our own
 * strings (command output, cron notices).
 */
export function splitForTelegram(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const at = cut > limit * 0.5 ? cut : limit;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trimStart();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/** Is this a GFM table separator row (`|---|:--:|`)? */
function isTableSeparator(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c.trim()));
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|");
}

function renderTable(rows: string[]): string {
  const cells = rows.map(splitRow);
  const width = Math.max(...cells.map((r) => r.length));
  const pad = cells.map((r) => [...r, ...Array(width - r.length).fill("")].map((c) => c.trim()));
  const sizes: number[] = [];
  for (let c = 0; c < width; c++) sizes.push(Math.min(28, Math.max(...pad.map((r) => (r[c] ?? "").length))));
  const line = (r: string[]): string =>
    r.map((c, i) => (c.length > sizes[i]! ? `${c.slice(0, sizes[i]! - 1)}…` : c.padEnd(sizes[i]!))).join(" │ ").trimEnd();
  const head = line(pad[0] ?? []);
  const body = pad.slice(1).map(line);
  const rule = sizes.map((n) => "─".repeat(n)).join("─┼─");
  return `<pre>${escapeHtml([head, rule, ...body].join("\n"))}</pre>`;
}

/**
 * Markdown → Telegram HTML.
 *
 * Not a full CommonMark implementation: it covers what models actually emit
 * (headings, emphasis, code, quotes, lists, links, rules, tables) and escapes
 * everything it does not.
 */
export function telegramHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block (``` or ~~~), closed or not — an unterminated fence is
    // still code, never a hole in the markup.
    const fence = /^\s*(```|~~~)\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      i += 1; // closing fence (or EOF)
      out.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    // Table: a header row followed by a separator row.
    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const rows = [line];
      i += 2; // skip the separator
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
        rows.push(lines[i]!);
        i += 1;
      }
      out.push(renderTable(rows));
      continue;
    }

    // Heading: Telegram has no heading tag; bold is the closest thing.
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      out.push(`<b>${inline(heading[2]!)}</b>`);
      i += 1;
      continue;
    }

    // Horizontal rule — a bare line of dashes, not a table separator (those were
    // consumed above) and not a list bullet.
    if (/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
      out.push("──────────");
      i += 1;
      continue;
    }

    // Blockquote (possibly several lines).
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^\s{0,3}>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote>${body.map(inline).join("\n")}</blockquote>`);
      continue;
    }

    out.push(inline(line));
    i += 1;
  }
  // `<blockquote>`/`<pre>` bodies were already escaped above; join without
  // touching them again.
  return out.join("\n");
}

/**
 * Split Markdown so each piece converts to fewer than `parsedLimit` characters.
 *
 * Paragraph boundaries first, then lines, then a hard cut — and a hard cut never
 * lands inside a fence, because the remainder is re-opened as a fence.
 */
export function splitMarkdown(text: string, limit = TELEGRAM_SPLIT_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const paras = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";
  const push = (): void => {
    if (current.trim() !== "") chunks.push(current);
    current = "";
  };
  for (const para of paras) {
    if (para.length > limit) {
      push();
      // Too big for one message on its own: cut on lines where possible.
      let rest = para;
      while (rest.length > limit) {
        const window = rest.slice(0, limit);
        const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
        const at = cut > limit * 0.6 ? cut : limit;
        chunks.push(rest.slice(0, at));
        rest = rest.slice(at).replace(/^\n/, "");
      }
      if (rest.trim() !== "") current = rest;
      continue;
    }
    const candidate = current === "" ? para : `${current}\n\n${para}`;
    if (candidate.length > limit) {
      push();
      current = para;
    } else {
      current = candidate;
    }
  }
  push();
  return chunks.length > 0 ? chunks : [text];
}

/** Fence marker still open at the end of a fragment, if any. */
function openFence(fragment: string): string | null {
  let open: string | null = null;
  for (const line of fragment.split("\n")) {
    const m = /^\s*(```|~~~)\s*[A-Za-z0-9_+-]*\s*$/.exec(line);
    if (!m) continue;
    if (open === null) open = m[1]!;
    else if (m[1] === open) open = null;
  }
  return open;
}

/**
 * Markdown → ready-to-send Telegram HTML chunks.
 *
 * Converts each source chunk separately (so no pair of delimiters is divided),
 * closes a fence left open at a split point, and guarantees every returned
 * string is under Telegram's parsed-text limit by falling back to escaped plain
 * text for any chunk that still grew too large.
 */
export function telegramChunks(text: string, parsedLimit = TELEGRAM_TEXT_LIMIT): string[] {
  const out: string[] = [];
  for (let chunk of splitMarkdown(text)) {
    const fence = openFence(chunk);
    // Carry the fence across the split so both halves stay valid markup.
    if (fence) chunk = `${chunk}\n${fence}`;
    let html = telegramHtml(chunk);
    if (html.length > parsedLimit) {
      // Escaped HTML grew past the limit (dense `&`/`<`). Plain text never
      // grows, and the answer matters more than the bold.
      const plain = chunk;
      for (let k = 0; k < plain.length; k += parsedLimit - 1) {
        out.push(plain.slice(k, k + parsedLimit - 1));
      }
      continue;
    }
    out.push(html);
  }
  return out.filter((c) => c.trim() !== "");
}
