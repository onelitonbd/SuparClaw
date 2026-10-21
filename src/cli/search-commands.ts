// `sc search` — one-shot web_search probe with the same resolution the tool
// uses (explicit provider never falls back; auto walks ready candidates).
import { ConfigService } from "../config/load.js";
import { createLogger } from "../util/log.js";
import { configPath } from "../util/paths.js";
import { webSearch, WEB_SEARCH_BACKENDS, renderSearchText } from "../agent/web-search.js";

const openConfig = () => new ConfigService(createLogger({ level: "error" }), configPath());

export async function searchCmd(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const clean = args.filter((a) => a !== "--json");
  const pIdx = clean.indexOf("--provider");
  const cIdx = clean.indexOf("--count");
  const provider = pIdx >= 0 ? clean[pIdx + 1] : undefined;
  const count = cIdx >= 0 ? Number(clean[cIdx + 1]) : undefined;
  const skip = new Set<number>();
  if (pIdx >= 0) { skip.add(pIdx).add(pIdx + 1); }
  if (cIdx >= 0) { skip.add(cIdx).add(cIdx + 1); }
  const query = clean.filter((_, i) => !skip.has(i)).join(" ").trim();

  if (!query) {
    console.error("usage: sc search <query> [--provider id] [--count n] [--json]");
    console.error(`providers: auto, ${WEB_SEARCH_BACKENDS.map((b) => b.id).join(", ")}`);
    return 1;
  }
  if (count !== undefined && (!Number.isFinite(count) || count < 1 || count > 10)) {
    console.error("--count must be 1..10");
    return 1;
  }

  const config = openConfig().current;
  const out = await webSearch(config, { query, count, provider });
  if (json) {
    console.log(JSON.stringify(out, null, 2));
  } else if (out.kind === "results") {
    console.log(`provider: ${out.provider} · ${out.count} result(s) · ${out.tookMs ?? 0}ms${out.cached ? " · cached" : ""}`);
    console.log(renderSearchText(out));
  } else {
    console.error(`error: ${out.message}`);
  }
  return out.kind === "error" ? 1 : 0;
}
