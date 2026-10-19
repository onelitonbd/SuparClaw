import type { Store, JobRow } from "../state/db.js";
import type { Logger } from "../util/log.js";

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

async function createCron(schedule: string, handler: () => void | Promise<void>, protect: boolean): Promise<CronHandle> {
  const { Cron } = await import("croner");
  return new Cron(schedule, { protect }, handler) as unknown as CronHandle;
}

export class Scheduler {
  #jobs = new Map<string, CronHandle>();
  readonly store: Store;
  readonly log: Logger;
  readonly fire: (job: JobRow) => Promise<void>;

  constructor(store: Store, log: Logger, fire: (job: JobRow) => Promise<void>) {
    this.store = store;
    this.log = log;
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
    this.#jobs.get(job.id)?.stop();
    try {
      const cron = await createCron(job.schedule, async () => {
        try {
          await this.fire(job);
          this.store.recordJobRun(job.id, "done", "");
        } catch (err) {
          this.store.recordJobRun(job.id, "error", (err as Error).message);
          this.log.error(`cron ${job.name} failed: ${(err as Error).message}`);
        }
      }, true);
      this.#jobs.set(job.id, cron);
      this.log.info(`cron armed: ${job.name} (${job.schedule})`);
    } catch (err) {
      this.log.error(`cron ${job.name} has an invalid schedule: ${(err as Error).message}`);
    }
  }

  async reload(): Promise<void> {
    this.stop();
    await this.start();
  }

  async upsert(job: Omit<JobRow, "created_at" | "last_run_at"> & { last_run_at?: number | null }): Promise<JobRow> {
    const saved = this.store.upsertJob(job);
    if (saved.enabled) await this.#schedule(saved);
    else this.#jobs.get(saved.id)?.stop();
    return saved;
  }

  remove(id: string): boolean {
    const existed = this.store.getJob(id) !== undefined;
    this.#jobs.get(id)?.stop();
    this.#jobs.delete(id);
    this.store.deleteJob(id);
    return existed;
  }

  stop(): void {
    for (const cron of this.#jobs.values()) cron.stop();
    this.#jobs.clear();
  }
}