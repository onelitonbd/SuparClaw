import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ui = readFileSync(new URL("../ui/src/settings.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../src/config/schema.ts", import.meta.url), "utf8");

test("Exec Settings expose availability and timeout only", () => {
  const start = ui.indexOf("async #execCard(");
  const end = ui.indexOf("\n  /** Code Mode card", start);
  assert.ok(start >= 0 && end > start, "Exec card exists before Code Mode card");
  const card = ui.slice(start, end);
  assert.match(card, /path: \"tools\.exec\"/);
  assert.match(card, /value: \{ enabled: enabledCb\.checked, timeoutMs \}/);
  assert.match(card, /1000–1800000 ms/);
  assert.match(card, /exec-settings-save/);
  assert.doesNotMatch(card, /approvals|allowlist|\bmode\b|askFallback|safeBins|unattended|exec-policy/i);
});

test("legacy exec policy keys are stripped from loaded configuration", () => {
  assert.match(schema, /for \(const key of \[\"approvals\", \"mode\", \"askFallback\", \"strictInlineEval\", \"safeBins\", \"safeBinTrustedDirs\", \"sandbox\", \"sandboxProot\", \"unattended\"\]\)/);
});
