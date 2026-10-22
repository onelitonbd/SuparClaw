/**
 * P3 (row Missing!#22) — the agent-facing `pdf` tool body (their tools/pdf
 * contract): pdf/pdfs merged + deduped (cap 10), per-PDF maxBytes gate,
 * extraction fallback, optional model analysis hop; extraction failures fall
 * to capability-"pdf" CLI entries (their ladder), `pages` only honored there.
 */
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { ToolContext } from "./tools.js";
import { extractPdfFile } from "../util/pdf-text.js";
import { cliArgs, realRunCli, type MediaModelEntry } from "./media-understanding.js";
import type { Logger } from "../util/log.js";

export interface PdfToolArgs {
  pdf?: string;
  pdfs?: string[];
  prompt?: string;
  pages?: string;
  model?: string;
  maxBytesMb?: number;
}

interface PdfWorkItem {
  input: string;
  resolved: string;
}

async function resolveOne(input: string, ctx: ToolContext): Promise<PdfWorkItem | { error: string }> {
  let p = input.trim();
  if (!p) return { error: "empty path" };
  if (/^https?:\/\//i.test(p)) {
    // Their tool accepts URLs: fetch with a size gate like attachments.
    const max = maxBytesOf(ctx, null);
    const res = await fetch(p, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return { error: `fetch failed: HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max) return { error: `${basename(p)} is ${buf.length} bytes (cap ${max})` };
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmp = mkdtempSync(join(tmpdir(), "sc-pdf-url-"));
    p = join(tmp, basename(p.split("?")[0]!) || "document.pdf");
    writeFileSync(p, buf);
    return { input, resolved: p };
  }
  const full = isAbsolute(p) ? p : resolve(ctx.workspace, p);
  if (!existsSync(full)) return { error: `no such file: ${input}` };
  return { input, resolved: full };
}

function maxBytesOf(ctx: ToolContext, overrideMb: number | null): number {
  if (overrideMb && overrideMb > 0) return overrideMb * 1048576;
  return ctx.config.tools.media.pdf.maxBytes > 0 ? ctx.config.tools.media.pdf.maxBytes : 10485760;
}

/** The extraction+analysis body, injectable entry-runner for tests. */
export async function analyzePdfs(
  args: Record<string, unknown>,
  ctx: ToolContext,
  runCli: typeof realRunCli = realRunCli,
  log: Pick<Logger, "warn"> = ctx.log,
): Promise<string> {
  const a = args as PdfToolArgs;
  // pdf + pdfs merge + dedupe, at least one required, cap 10 (their rules).
  const inputs = [...(a.pdf ? [a.pdf] : []), ...(Array.isArray(a.pdfs) ? a.pdfs.map(String) : [])];
  const deduped = [...new Set(inputs.map((s) => s.trim()).filter(Boolean))];
  if (deduped.length === 0) return "Provide pdf or pdfs (up to 10).";
  if (deduped.length > 10) return `Too many PDFs (${deduped.length}) — cap is 10.`;

  const maxBytes = maxBytesOf(ctx, typeof a.maxBytesMb === "number" ? a.maxBytesMb : null);
  const entries = (ctx.config.tools.media.models ?? []).filter(
    (m): m is MediaModelEntry => Array.isArray(m.capabilities) && m.capabilities.includes("pdf"),
  );
  const out: string[] = [];
  for (const item of deduped) {
    const resolved = await resolveOne(item, ctx);
    if ("error" in resolved) {
      out.push(`### ${basename(item)}\nerror: ${resolved.error}`);
      continue;
    }
    const size = statSync(resolved.resolved).size;
    if (size > maxBytes) {
      out.push(`### ${basename(item)}\nerror: ${size} bytes exceeds the ${maxBytes}-byte cap (raise maxBytesMb or tools.media.pdf.maxBytes)`);
      continue;
    }
    let text = "";
    let extractionError: string | null = null;
    try {
      const r = await extractPdfFile(resolved.resolved, { maxChars: ctx.config.tools.media.pdf.maxChars || 4000 });
      text = r.text;
      if (r.truncated && r.text) text += "\n\n[excerpt — document truncated at the char budget]";
    } catch (err) {
      extractionError = (err as Error).message;
    }
    // CLI ladder (their entry fallback; covers encrypted/font-encoded files
    // and adds page filtering the builtin extractor cannot do).
    if (!text) {
      for (const entry of entries) {
        if (entry.type === "cli") {
          try {
            const cliText = (
              await runCli(
                entry.command,
                cliArgs(entry, { kind: "pdf", path: resolved.resolved }, {
                  maxChars: ctx.config.tools.media.pdf.maxChars || 4000,
                  prompt: String(a.prompt ?? "Analyze this PDF document."),
                  outputDir: "/tmp",
                  index: 0,
                }),
                (entry.timeoutSeconds > 0 ? entry.timeoutSeconds : ctx.config.tools.media.pdf.timeoutSeconds || 60) * 1000,
              )
            ).trim();
            if (cliText) {
              text = cliText;
              break;
            }
          } catch (err) {
            log.warn(`pdf cli entry ${entry.command} failed: ${(err as Error).message}`);
          }
        }
      }
    }
    if (!text) {
      out.push(`### ${basename(item)}\nerror: no extractable text${extractionError ? ` (${extractionError})` : ""}${entries.length === 0 ? " — configure a tools.media.models CLI entry (e.g. pdftotext) as the fallback lane" : ""}`);
      continue;
    }
    const prompt = String(a.prompt ?? "Analyze this PDF document.");
    if (ctx.llmText) {
      try {
        const analysis = await ctx.llmText(
          [{ role: "user", content: `${prompt}\n\n--- begin PDF "${basename(item)}" ---\n${text}\n--- end "${basename(item)}" ---` }],
          { model: typeof a.model === "string" && a.model.trim() ? a.model.trim() : undefined },
        );
        out.push(`### ${item}\n${analysis.trim()}`);
      } catch (err) {
        out.push(`### ${item}\n(analysis failed: ${(err as Error).message})\n\n${text}`);
      }
    } else {
      out.push(`### ${item}\n${text}`);
    }
  }
  return out.join("\n\n");
}
