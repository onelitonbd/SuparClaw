import { Service } from "../agent/service.js";

/**
 * `sc dream [promote|backfill]` — the dreaming surface.
 *
 * Bare `sc dream` runs one full sweep now (light stage → REM themes → deep
 * scoring/gates → consolidation into MEMORY.md + DREAMS.md diary), the same
 * pipeline the nightly schedule runs.
 *   promote [--limit N] [--apply]  — their `memory promote`: deep-phase
 *     preview over the staged recall store; --apply consolidates the gated
 *     candidates now.
 *   backfill [--days N] [--apply] [--rollback] — their rem-backfill: replay
 *     notes older than the live sweep window; --apply stages them (tagged so
 *     rollback removes only those artifacts); --rollback removes them.
 */
export async function dreamCmd(argv: string[]): Promise<number> {
  const sub = argv[0] ?? "";
  const flag = (name: string) => argv.includes(name);
  const optNum = (name: string, def: number) => {
    const i = argv.indexOf(name);
    if (i === -1) return def;
    const n = Number(argv[i + 1]);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : def;
  };

  const service = new Service();
  service.bootstrap();
  try {
    switch (sub) {
      case "promote": {
        const limit = optNum("--limit", 10);
        if (flag("--apply")) {
          const res = await service.dreamPromoteApply(limit);
          console.log(`promote --apply: promoted ${res.promoted}, merged ${res.merged}, superseded ${res.superseded}${res.modelUsed ? "" : " (append-only fallback)"}`);
          return 0;
        }
        const rows = service.dreamPromotePreview(limit);
        if (rows.length === 0) {
          console.log("no staged candidates within the deep-phase window");
          return 0;
        }
        if (flag("--json")) {
          console.log(
            JSON.stringify(
              rows.map((d) => ({
                verdict: d.verdict,
                score: Number(d.signals.score.toFixed(3)),
                signals: d.cluster.members.length,
                days: d.cluster.days.size,
                source: d.cluster.rep.source,
                text: d.cluster.rep.text,
              })),
              null,
              2,
            ),
          );
          return 0;
        }
        for (const d of rows) {
          const mark = d.verdict === "promote" ? "✅" : "—";
          console.log(
            `${mark} ${d.signals.score.toFixed(2)} [${d.verdict}] signals:${d.cluster.members.length} days:${d.cluster.days.size} ${d.cluster.rep.source} · ${d.cluster.rep.text.slice(0, 90)}`,
          );
        }
        console.log("(preview — run `sc dream promote --apply` to consolidate)");
        return 0;
      }
      case "backfill": {
        if (flag("--rollback")) {
          const removed = service.dreamBackfillRollback();
          console.log(`rollback: removed ${removed} backfill-staged candidate(s)`);
          return 0;
        }
        const days = optNum("--days", 30);
        if (flag("--apply")) {
          const res = service.dreamBackfillApply(days);
          console.log(`backfill: staged ${res.staged} candidate(s) from notes older than the live window${Object.keys(res.rejected).length ? ` (masked ${res.rejected["secret-masked"] ?? 0}, dupes ${res.rejected["deduped"] ?? 0})` : ""}`);
          return 0;
        }
        const lines = service.dreamBackfillPreview(days);
        if (lines.length === 0) {
          console.log("nothing to backfill beyond the live sweep window");
          return 0;
        }
        for (const l of lines.slice(0, 20)) console.log(`[${l.day} · ${l.source}] ${l.text.slice(0, 100)}`);
        if (lines.length > 20) console.log(`… ${lines.length - 20} more`);
        console.log(`(${lines.length} candidate(s) — run \`sc dream backfill --days ${days} --apply\` to stage)`);
        return 0;
      }
      default: {
        console.log("dreaming sweep: light → REM → deep, consolidating into MEMORY.md ...");
        const summary = await service.dreamNow();
        console.log(summary);
        return 0;
      }
    }
  } finally {
    await service.stop();
  }
}
