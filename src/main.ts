#!/usr/bin/env node
// SuparClaw entrypoint: enable V8 compile cache, then dispatch.
import module from "node:module";

try {
  (module as unknown as { enableCompileCache?: (dir?: string) => void }).enableCompileCache?.();
} catch {
  /* older runtimes: skip */
}

const { main } = await import("./cli/index.js");
const code = await main(process.argv.slice(2));
process.exitCode = code ?? 0;