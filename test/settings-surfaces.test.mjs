// P4 (Missing!#38, #39, #40) — exec & tools settings, agent identity &
// defaults, complete Gateway tab.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../ui/src/settings.ts", import.meta.url), "utf8");

test("#38 exec & tools settings: policy card covers every tools.exec key", () => {
  assert.match(src, /#execPolicyCard\(config: any\)/);
  assert.match(src, /id: "exec-policy-save"/);
  for (const path of [
    "tools.exec.enabled",
    "tools.exec.approvals",
    "tools.exec.mode",
    "tools.exec.askFallback",
    "tools.exec.strictInlineEval",
    "tools.exec.safeBins",
    "tools.exec.safeBinTrustedDirs",
    "tools.exec.timeoutMs",
    "tools.exec.sandbox",
    "tools.exec.sandboxProot",
    "tools.exec.unattended",
  ]) {
    assert.ok(src.includes(`["${path}"`), `missing leaf write ${path}`);
  }
  // their unset-is-a-state rule for exec mode: blank follows the approvals bool
  assert.match(src, /tools\.exec\.mode", \/\^\(deny\|allowlist\|ask\|full\)\$\//);
  // sandbox hints
  assert.match(src, /strict \(scrubbed env \+ prlimit caps\)/);
  assert.match(src, /unattended auto-decision is audited/);
  // tools tab gets the config so the cards can render
  assert.match(src, /this\.#tab === "tools"\) await this\.#renderTools\(tools, config\)/);
});

test("#38 code mode + media cards cover their config surfaces", () => {
  assert.match(src, /#codeModeCard\(config: any\)/);
  assert.match(src, /id: "codemode-save"/);
  for (const path of [
    "tools.codeMode.enabled",
    "tools.codeMode.executor",
    "tools.codeMode.timeoutMs",
    "tools.codeMode.maxCodeChars",
    "tools.codeMode.maxOutputBytes",
    "tools.codeMode.maxPendingToolCalls",
    "tools.codeMode.directOnly",
  ]) {
    assert.ok(src.includes(`["${path}"`), `missing leaf write ${path}`);
  }
  assert.match(src, /auto \(preferred models only\)/);

  assert.match(src, /#mediaCard\(config: any\)/);
  assert.match(src, /id: "media-save"/);
  for (const path of ["tools.media.concurrency", "tools.media.image", "tools.media.audio", "tools.media.pdf"]) {
    assert.ok(src.includes(`["${path}"`), `missing leaf write ${path}`);
  }
  assert.match(src, /"md-aud-echo"/); // transcript echo toggle (their echo surface)
  assert.match(src, /attachments_all: imgAllCb\.input\.checked/);
  assert.match(src, /preferredModel/);
});

test("#39 agent identity + defaults on the Defaults tab", () => {
  assert.match(src, /this\.#renderAgentIdentity\(config\);/);
  // The card now also receives the enabled profiles, so its caption can say which
  // model's window the history budget came from.
  assert.match(src, /this\.#renderAgentDefaults\(defaults, configured\.filter\(\(m\) => m\.enabled\)\);/);
  // identity (their Personal identity page)
  assert.match(src, /id: "identity-save"/);
  assert.match(src, /id: iid, value, placeholder/);
  for (const path of ["agents.identity.name", "agents.identity.emoji", "agents.identity.theme"]) {
    assert.ok(src.includes(`["${path}"`), `missing leaf write ${path}`);
  }
  // defaults — every named key from the row
  assert.match(src, /id: "agent-defaults-save"/);
  // The context budget is no longer written from here: the window is per model
  // (Models → Tune) and the budget is derived from it. Nothing on this page may
  // offer a second knob that could disagree with the model.
  assert.ok(!src.includes("ad-budget"), "the context budget field is gone");
  assert.ok(src.includes("Models → Tune"), "the card says where the window is set");
  assert.ok(!src.includes('["agents.defaults.contextBudgetChars"'), "and it writes no budget leaf");
  assert.match(src, /No ceiling/); // iterations: no 1-40 rating any more
  assert.ok(!src.includes("Math.min(40,"), "the 40-round clamp is gone");
  for (const path of [
    "agents.defaults.maxToolIterations",
    "agents.defaults.queueMode",
    "agents.defaults.maxConcurrent",
    "agents.defaults.reasoningEffort",
    "agents.defaults.reasoningView",
    "agents.defaults.usage",
    "agents.defaults.subagents.maxConcurrent",
    "agents.defaults.subagents.model",
    "agents.defaults.subagents.maxDepth",
    "agents.defaults.subagents.thinking",
    "agents.defaults.subagents.delegationMode",
  ]) {
    assert.ok(src.includes(`["${path}"`), `missing leaf write ${path}`);
  }
  // honesty hints
  assert.match(src, /superseded by messages\.queue\.mode/);
  assert.match(src, /never a guess/);
  assert.match(src, /prompt guidance only/);
});

test("#40 gateway tab: full surface incl. bind, hosts/origins, controlUi, openai endpoint, config path", () => {
  assert.match(src, /#renderGateway\(gw: any, configPath = ""\)/);
  assert.match(src, /configPath = String\(\(cfg as any\)\.path \?\? ""\)/);
  assert.match(src, /Config: \$\{configPath\}`/);
  assert.match(src, /id: "gw-bind"/);
  assert.match(src, /id: "gw-hosts"/);
  assert.match(src, /id: "gw-origins"/);
  assert.match(src, /id: "gw-cui"/);
  assert.match(src, /id: "gw-basepath"/);
  assert.match(src, /id: "gw-openai"/);
  assert.match(src, /id: "gw-bypass"/);
  assert.match(src, /id: "gateway-save"/);
  for (const path of [
    "gateway.port",
    "gateway.bind",
    "gateway.auth.mode",
    "gateway.auth.loopbackBypass",
    "gateway.allowedHosts",
    "gateway.allowedOrigins",
    "gateway.controlUi.enabled",
    "gateway.controlUi.basePath",
    "gateway.http.endpoints.chatCompletions.enabled",
  ]) {
    assert.ok(src.includes(`["${path}"`), `missing leaf write ${path}`);
  }
  // token stays write-only; auth mode stays a constrained enum
  assert.match(src, /if \(tokenNew\.value\.trim\(\)\) pairs\.push\(\["gateway\.auth\.token"/);
  assert.match(src, /\/\^\(token\|none\)\$\//);
  // their operator-grade warning for the HTTP endpoint
  assert.match(src, /grants full agent access over plain HTTP/);
  // loopback bypass + base path hints
  assert.match(src, /no token needed from localhost/);
  assert.match(src, /their controlUi\.basePath/);
});
