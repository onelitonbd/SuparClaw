import { Service } from "../agent/service.js";

/**
 * `sc dream` — run one memory-dreaming sweep now (the same pass the nightly
 * schedule runs): consolidate memory/YYYY-MM-DD.md notes into MEMORY.md and
 * append the dated "Deep Sleep" entry to DREAMS.md. A "nothing new" outcome is
 * normal and healthy.
 */
export async function dreamCmd(_argv: string[]): Promise<number> {
  const service = new Service();
  service.bootstrap();
  console.log("dreaming sweep: consolidating daily notes into MEMORY.md ...");
  const summary = await service.dreamNow();
  console.log(summary);
  await service.stop();
  return 0;
}
