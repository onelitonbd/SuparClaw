import { deflateSync } from "node:zlib";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const m = await import("/home/user/SuparClaw/dist/lib.js");
function tinyPdf(content) {
  const stream = deflateSync(Buffer.from(`BT /F1 12 Tf 72 720 Td (${content}) Tj ET`, "latin1"));
  const parts = ["%PDF-1.4\n", "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n", "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n", "3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n", `4 0 obj << /Length ${stream.length} /Filter /FlateDecode >> stream\n`, stream.toString("latin1"), "\nendstream endobj\n"];
  return Buffer.from(parts.join(""), "latin1");
}
const buf = tinyPdf("the budget grew by twelve percent");
console.log("pure:", JSON.stringify(m.extractPdfText(buf)));
console.log("withMax:", JSON.stringify(m.extractPdfText(buf, { maxChars: 4000 })));
const dir = mkdtempSync(join(".arena/dbg/", "w-"));
writeFileSync(join(dir, "a.pdf"), buf);
const ctx = { workspace: dir, log: { warn() {} }, config: { tools: { media: { pdf: { maxBytes: 10485760, maxChars: 4000, timeoutSeconds: 60, enabled: true }, models: [] } } }, llmText: async (msgs) => `analysis of [${msgs[0].content.slice(0, 40)}…]` };
console.log("analyze:", JSON.stringify(await m.analyzePdfs({ pdf: "a.pdf", pdfs: ["a.pdf", "a.pdf"] }, ctx)));
