import type { Store, JobRow } from "../state/db.js";
import type { Logger } from "../util/log.js";
import type { SuparClawConfig } from "../config/schema.js";

export interface SchedulerDeps {
  store: Store;
  log: Logger;
  fire: (job: JobRow) => Promise<void>;
}

/** Cron jobs live in SQLite; a single timer per job, restored on daemon start. */
interface CronHandle {
  stop(): void;
  nextRun(): Date | null;
}

async function createCron(schedule: string, handler: () => void | Promise<void>, protect: boolean, timezone?: string): Promise<CronHandle> {
  const { Cron } = await import("croner");
  // P2 #14: croner interprets the schedule in `timezone` when given (their
  // per-job timezone option); undefined keeps the host zone ("local").
  return new Cron(schedule, { protect, timezone }, handler) as unknown as CronHandle;
}

/** Effective zone for a job: per-job tz → cron.timezone → host (their layering). */
export function jobTimezone(job: Pick<JobRow, "tz">, globalTz: string): string | undefined {
  const tz = job.tz || (globalTz !== "local" ? globalTz : "");
  return tz || undefined;
}

export class Scheduler {
  /** job id -> armed timer + the signature it was armed with (cheap diffs). */
  #jobs = new Map<string, { handle: CronHandle; signature: string }>();
  readonly store: Store;
  readonly log: Logger;
  readonly fire: (job: JobRow) => Promise<void>;
  /** Live config accessor (watchConfig swaps the object under the service). */
  readonly #cronCfg: () => SuparClawConfig["cron"];

  constructor(store: Store, log: Logger, cronCfg: () => SuparClawConfig["cron"], fire: (job: JobRow) => Promise<void>) {
    this.store = store;
    this.log = log;
    this.#cronCfg = cronCfg;
    this.fire = fire;
  }

  get count(): number {
    return this.#jobs.size;
  }

  async start(): Promise<void> {
    for (const job of this.store.listJobs()) {
      if (!job.enabled) continue;
      await this.#schedule(job);
    }
  }

  async #schedule(job: JobRow): Promise<void> {
    const tz = jobTimezone(job, this.#cronCfg().timezone);
    const signature = `${job.schedule}${tz ? `|tz:${tz}` : ""}`;
    const armed = this.#jobs.get(job.id);
    if (armed?.signature === signature) return; // already armed correctly
    armed?.handle.stop();
    try {
      const cron = await createCron(job.schedule, async () => {
        try {
          await this.fire(job);
          // Success is recorded once — by the service's reply path (with the
          // reply text). Recording here too produced two rows per run.
        } catch (err) {
          this.store.recordJobRun(job.id, "error", (err as Error).message);
          this.log.error(`cron ${job.name} failed: ${(err as Error).message}`);
        }
      }, true, tz);
      this.#jobs.set(job.id, { handle: cron, signature });
      this.log.info(`cron armed: ${job.name} (${job.schedule}${tz ? `, ${tz}` : ""})`);
    } catch (err) {
      this.log.error(`cron ${job.name} has an invalid schedule or timezone: ${(err as Error).message}`);
    }
  }

  /**
   * Re-arm job changes made by other processes (`sc cron add` etc write
   * SQLite directly). Cheap diff: nothing already armed is touched.
   */
  async reconcile(): Promise<void> {
    const current = new Map(this.store.listJobs().map((j) => [j.id, j] as const));
    for (const [id, armed] of this.#jobs) {
      const job = current.get(id);
      if (!job || !job.enabled) {
        armed.handle.stop();
        this.#jobs.delete(id);
      }
    }
    for (const job of current.values()) {
      if (job.enabled) await this.#schedule(job);
    }
  }

  async reload(): Promise<void> {
    this.stop();
    await this.start();
  }

  async upsert(job: Omit<JobRow, "created_at" | "last_run_at"> & { last_run_at?: number | null }): Promise<JobRow> {
    const saved = this.store.upsertJob(job);
    if (saved.enabled) await this.#schedule(saved);
    else {
      this.#jobs.get(saved.id)?.handle.stop();
      this.#jobs.delete(saved.id);
    }
    return saved;
  }

  remove(id: string): boolean {
    const existed = this.store.getJob(id) !== undefined;
    this.#jobs.get(id)?.handle.stop();
    this.#jobs.delete(id);
    this.store.deleteJob(id);
    return existed;
  }

  stop(): void {
    for (const armed of this.#jobs.values()) armed.handle.stop();
    this.#jobs.clear();
  }
}
