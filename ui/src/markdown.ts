// Minimal, safe markdown → HTML. Input is escaped first, so nothing raw can
// reach innerHTML. Supports headings, lists, code fences, quotes, tables and
// inline emphasis/link/code — enough for chat output without a 40 KB library.

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c] as string);
}

function inline(src: string): string {
  let s = src;
  // code spans first so their contents are never re-processed
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t: string, href: string) =>
    `<a href="${href}" target="_blank" rel="noreferrer noopener">${t}</a>`);
  // bare URLs (not already inside a tag)
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, pre: string, url: string) =>
    `${pre}<a href="${url}" target="_blank" rel="noreferrer noopener">${url}</a>`);
  return s;
}

export function renderMarkdown(src: string): string {
  const out: string[] = [];
  const lines = escapeHtml(src).split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] as string;

    // fenced code
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] as string)) {
        body.push(lines[i] as string);
        i++;
      }
      i++; // closing fence
      out.push(`<pre data-lang="${lang}"><code>${body.join("\n")}</code></pre>`);
      continue;
    }

    // heading
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = (h[1] as string).length;
      out.push(`<h${level}>${inline(h[2] as string)}</h${level}>`);
      i++;
      continue;
    }

    // blockquote
    if (/^\s*&gt;\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i] as string)) {
        body.push((lines[i] as string).replace(/^\s*&gt;\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${inline(body.join(" "))}</blockquote>`);
      continue;
    }

    // table (header row + separator row)
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const cells = (r: string) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] as string)) {
        rows.push(cells(lines[i] as string));
        i++;
      }
      const thead = head.map((c) => `<th>${c}</th>`).join("");
      const tbody = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
      out.push(`<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`);
      continue;
    }

    // lists
    const ul = /^\s*[-*]\s+/;
    const ol = /^\s*\d+[.)]\s+/;
    if (ul.test(line) || ol.test(line)) {
      const ordered = ol.test(line);
      const re = ordered ? ol : ul;
      const items: string[] = [];
      while (i < lines.length && re.test(lines[i] as string)) {
        items.push(inline((lines[i] as string).replace(re, "")));
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((it) => `<li>${it}</li>`).join("")}</${tag}>`);
      continue;
    }

    // blank line → paragraph break
    if (!line.trim()) {
      i++;
      continue;
    }

    // paragraph: gather consecutive plain lines
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,4}\s|\s*```|\s*[-*]\s|\s*\d+[.)]\s|\s*&gt;|\s*\|)/.test(lines[i] as string)) {
      para.push(lines[i] as string);
      i++;
    }
    out.push(`<p>${inline(para.join("<br>"))}</p>`);
  }

  return out.join("");
}
