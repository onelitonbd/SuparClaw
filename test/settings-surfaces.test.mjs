// P4 (Missing!#38, #39, #40) — exec & tools settings, agent identity &
// defaults, complete Gateway tab.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../ui/src/settings.ts", import.meta.url), "utf8");

test("#38 exec settings expose only direct availability and timeout", () => {
  const start = src.indexOf("async #execCard(");
  const end = src.indexOf("\n  /** Code Mode card", start);
  const card = src.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(card, /exec-settings-save/);
  assert.match(card, /path: "tools\.exec"/);
  assert.match(card, /value: \{ enabled: enabledCb\.checked, timeoutMs \}/);
  assert.match(card, /1000–1800000 ms/);
  assert.doesNotMatch(card, /approvals|allowlist|\bmode\b|askFallback|safeBins|unattended|exec-policy/i);
  assert.match(card, /When enabled, shell commands run in the daemon user's environment and permissions/);
  assert.match(card, /This cap limits how long one command can run/);
});

test("#38 code mode + media cards cover their config surfaces", () => {
  // Code mode had the same two-card seven-half-saves shape the exec section had:
  // it is now one draft and one merged write.
  assert.match(src, /#codeModeCard\(config: any, tools: any\[\] = \[\]\): Promise<HTMLElement>/);
  assert.match(src, /id: "codemode-save"/);
  assert.match(src, /gateway\.request\("config\.set", \{ path: "tools\.codeMode", value: block \}\)/);
  assert.doesNotMatch(src, /\["tools\.codeMode\./, "no leaf writes left for the code-mode block");
  assert.match(src, /\.\.\.structuredClone\(x\),/);
  // the stored enum is text; writing a boolean would silently disable code mode
  for (const key of ["executor,", "timeoutMs,", "maxCodeChars,", "maxOutputBytes,", "maxPendingToolCalls,", "directOnly:"]) {
    assert.ok(src.includes(key), `missing merged key ${key}`);
  }
  assert.match(src, /enabled: modeValue,/);
  assert.match(src, /auto \(preferred models only\)/);
  // refuse, never clamp
  assert.match(src, /readInt\(nTimeout, "timeout", 100, 60000\)/);
  assert.match(src, /readInt\(nChars, "max code chars", 1024, null\)/);
  assert.match(src, /readInt\(nOut, "max output bytes", 1024, 10485760\)/);
  assert.match(src, /readInt\(nPend, "max pending tool calls", 1, 128\)/);
  // engagement comes from the engine's predicate through the gateway, not a UI copy
  assert.match(src, /gateway\.request\("codeMode\.get"\)/);
  assert.match(src, /executor_unavailable/);
  const cmStart = src.indexOf("async #codeModeCard(");
  const cmEnd = src.indexOf("async #mediaCard(", cmStart);
  assert.ok(cmStart >= 0 && cmEnd > cmStart);
  assert.doesNotMatch(src.slice(cmStart, cmEnd), /exec policy|approval/i);

  // Media understanding: three whole-object writes became one merged block.
  assert.match(src, /#mediaCard\(config: any\): Promise<HTMLElement>/);
  assert.match(src, /id: "media-save"/);
  assert.match(src, /gateway\.request\("config\.set", \{ path: "tools\.media", value: block \}\)/);
  assert.doesNotMatch(src, /\["tools\.media\./, "no leaf writes left for the media block");
  // each capability spreads what is stored, so a key this page does not render survives
  assert.match(src, /\.\.\.\(x\.image \?\? \{\}\),/);
  assert.match(src, /\.\.\.\(x\.audio \?\? \{\}\),/);
  assert.match(src, /\.\.\.\(x\.pdf \?\? \{\}\),/);
  assert.match(src, /concurrency,/);
  assert.match(src, /attachments_all: attachAll/);
  assert.match(src, /"md-aud-echo"/); // transcript echo toggle (their echo surface)
  assert.match(src, /preferredModel: this\.#selValue\(imgModel\.sel\)/);
  assert.match(src, /preferredModel: this\.#selValue\(audModel\.sel\)/);
  // the model pickers are this app's menu, not a platform select
  assert.match(src, /this\.#dropdown\(\{ id, value: cur, label, placeholder: "— choose a model —", options \}\)/);
  // "0 = the runtime default" comes from the engine, and the echo says which
  assert.match(src, /gateway\.request\("media\.get"\)/);
  assert.match(src, /default \(\$\{/);
  // the echo format is only checked while it is reachable
  assert.match(src, /if \(echoOn && fmt && !fmt\.includes\("\{transcript\}"\)\)/);
});

test("#38 web search card: one draft over the whole tools.web.search block", () => {
  assert.match(src, /#webSearchCard\(config: any = \{\}\): Promise<HTMLElement>/);
  assert.match(src, /id: "websearch-save"/);
  assert.match(src, /gateway\.request\("config\.set", \{ path: "tools\.web\.search", value: block \}\)/);
  // every credential and the provider choice stage in the draft, not on click
  assert.doesNotMatch(src, /path: `tools\.web\.search\./, "no per-provider leaf writes left");
  assert.match(src, /providerOptions/);
  assert.match(src, /autoCandidates/);
  assert.match(src, /no fallback/);
  // the two limits the card used to hide
  assert.match(src, /num\("ws-max", "Results per search"/);
  assert.match(src, /num\("ws-cache", "Cache TTL \(minutes\)"/);
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
  assert.match(src, /0 = no limit \(the default\)/); // Task 38: the default is genuinely unlimited
  assert.match(src, /nudged, and only a second repetition stops the turn/);
  assert.ok(!src.includes("Math.min(40,"), "the 40-round clamp is gone");
  // No queue row: agents.defaults.queueMode was superseded by messages.queue.mode,
  // which the loop actually reads (see the migration case in core.test.mjs). A
  // second control here could only disagree with the one place that decides.
  assert.ok(!src.includes("ad-queue"), "the dead legacy queue control is gone");
  assert.ok(!src.includes('["agents.defaults.queueMode"'), "and nothing writes the legacy leaf");
  for (const path of [
    "agents.defaults.maxToolIterations",
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
  assert.match(src, /never a guess/);
  assert.match(src, /prompt guidance only/);
});

test("#40 gateway tab: full surface incl. bind, hosts/origins, controlUi, openai endpoint, config path", () => {
  assert.match(src, /#renderGateway\(gw: any, configPath = ""\)/);
  assert.match(src, /configPath = String\(\(cfg as any\)\.path \?\? ""\)/);
  // The file is a labelled fact row now, not a `Config: /path` line after the actions.
  assert.match(src, /#factRow\("Config file", configPath,/);
  assert.ok(!src.includes("Config: ${configPath}"), "the stray path line is gone");
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
  // Token stays write-only; the two enums are read through #selValue and coerced,
  // so a garbage store can never reach the config file.
  assert.match(src, /if \(tokenIn\.value\.trim\(\)\) pairs\.push\(\["gateway\.auth\.token"/);
  assert.match(src, /const currentBind = \(\): "loopback" \| "lan" =>/);
  assert.match(src, /const currentMode = \(\): "token" \| "none" =>/);
  // Both choices are our own dropdown, never the browser's.
  assert.match(src, /id: "gw-bind",\s*\n\s*value: savedBind/);
  assert.match(src, /id: "gw-mode",\s*\n\s*value: savedMode/);
  // The operator warning for the HTTP endpoint, in words rather than a repo key.
  assert.match(src, /hands full agent access to anything holding that token/);
  // loopback bypass + base path hints
  assert.match(src, /Skip the token for local clients/);
  assert.match(src, /Mount the web app under a prefix for a reverse proxy\./);
  // A save never reloads the page: that hid a refused write.
  const region = src.slice(src.indexOf("#renderGateway(gw: any"), src.indexOf("/* ---------------- automations"));
  assert.ok(!/location\.reload/.test(region), "no reload on save");
});

test("#42 models tab: one panel of rows, and every action it used to offer", () => {
  // A card per provider became one panel of rows, so the summary line and the
  // rows are built from the same facts and cannot disagree.
  assert.match(src, /#providerFacts\(/);
  assert.match(src, /id: "models-summary"/);
  assert.match(src, /"data-provider": name/);
  assert.ok(!src.includes("prov-card"), "the card-per-provider layout is gone");

  // The empty state used to be built into a node that was never appended.
  assert.match(src, /id: "models-empty-providers"/);

  // A redesign may move things; it may not quietly drop an action.
  for (const rpc of ["models.auth.order", "models.auth.remove", "models.local.scan", "models.local.add"]) {
    assert.ok(src.includes(rpc), `missing ${rpc}`);
  }
  assert.match(src, /#connectProvider\(name: string, plugin: any \| null, currentBinding: string\)/);

  // The stale-catalog reason now reaches this tab instead of only the detail page.
  assert.match(src, /#renderModels\(providers, configured, models, authProfiles, plugins, modelsWarning\)/);
});

test("#43 models list rows keep their padding, and stack on a phone", () => {
  const css = readFileSync(new URL("../ui/styles.css", import.meta.url), "utf8");

  // The regression this guards: `.pickrow`s sit inside a `.list` wrapper, so a
  // child combinator never matched and every row ran flush into the next one.
  assert.ok(css.includes(".settings .card--flush .pickrow {"), "row padding is a descendant rule");
  assert.ok(css.includes(".settings .card--flush .pickrow + .pickrow {"), "hairline between rows");
  assert.ok(!css.includes(".card--flush > .pickrow"), "no child-combinator row rules left");

  // Phone: name on its own line, meta + action on the next, 44px action.
  assert.match(css, /\.settings \.pickrow__name \{ grid-area: name; \}/);
  assert.match(css, /\.settings \.pickrow > \.btn \{ grid-area: action; min-height: var\(--tap\); \}/);

  // Detail header collapses to one column instead of stacking two buttons beside
  // a squeezed name.
  assert.match(css, /\.settings \.models__detailhead \{[^}]*flex-direction: column;/);
});
