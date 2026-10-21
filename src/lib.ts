// Test surface: internals are exported so the test suite can import the built bundle.
export { readTextSafe } from "./util/paths.js";
export { Screen, clipToWidth, rule } from "./tui/renderer.js";
export { renderMarkdown, renderInline } from "./tui/markdown.js";
export { palette, theme, detectLightMode, markdownTheme } from "./tui/theme.js";
export { Editor } from "./tui/editor.js";
export { parseKeys } from "./tui/keys.js";
export { parseConfig, validate, applyDefaults, emptyConfig, CONFIG_SCHEMA, modelProfiles, modelProfile, execModeOf, type ExecMode, type ExecAskFallback } from "./config/schema.js";
export { parseFrontmatter, discoverSkills, matchSkills, skillsCatalog, writeSkill, skillSlug, readSkillBody } from "./agent/skills.js";
export { Store } from "./state/db.js";
export {
  tokenize,
  chunkMarkdown,
  importanceOf,
  datedNoteDate,
  decayFactor,
  importanceMultiplier,
  mmrReorder,
  searchMemoryFiles,
  rankTranscriptHits,
  memoryFiles,
  type MemoryHit,
  type TranscriptRow,
} from "./agent/memory-search.js";
export { loadWorkspaceContext, writeWorkspaceTemplates, todayStamp } from "./agent/workspace.js";
export { buildRegistry, toolsToSchema, safePath } from "./agent/tools.js";
export { LlmClient, resolveModel, parseToolArgs, parseRetryAfter, parseRetryHint, LlmError, providerErrorText, googleThoughtSignature, reasoningTokens, SKIP_THOUGHT_SIGNATURE } from "./agent/llm.js";
export { hostAllowed, originAllowed, hostnameOf, type TrustPolicy } from "./gateway/trust.js";
export { redactSecrets, resolveRedacted, isRedacted, maskSecret, REDACTED_PREFIX } from "./config/redact.js";
export { auditConfig, type Finding } from "./cli/audit.js";
export { splitForTelegram } from "./channels/telegram.js";
export { width, truncateToWidth, wrapText, sanitize, stripAnsi } from "./util/ansi.js";
export { AgentLoop } from "./agent/loop.js";
export { Subagents } from "./agent/subagents.js";
export { Service } from "./agent/service.js";export { renderMarkdown as renderUiMarkdown, escapeHtml } from "../ui/src/markdown.js";
export { fuzzy } from "../ui/src/dom.js";
export { fetchModels, PRESETS, formatProviders, addProvider, removeProvider, testProvider, maskKey, defaultModelLine, parseProviderAddArgs, canonicalModelRef } from "./config/providers.js";
export { ConfigService } from "./config/load.js";
export { createLogger } from "./util/log.js";
export { parseCommand as parseBotCommand } from "./channels/telegram.js";

/**
 * Where a message arrived from, for the prompt's "Session:" line. OpenClaw
 * spells this out in a "Group Chat Context" section; the model must know a
 * DM vs a group vs a forum topic differs (a group reply should assume others
 * are reading). Derived from the session key — the host, never the model,
 * picks the channel.
 */
export function channelLabel(sessionKey: string): string {
  const k = String(sessionKey ?? "").trim();
  if (k === "main:main" || k === "main") return "the web chat (main session)";
  const parts = k.split(":");
  const head = parts[0] ?? "";
  if (head === "telegram") {
    if (parts.includes("topic")) return "Telegram (forum topic)";
    if (parts.includes("group")) return "Telegram (group chat)";
    return "Telegram (direct message)";
  }
  if (head === "web" || head === "ui") return "the web chat";
  if (head === "tui" || head === "term") return "the terminal UI";
  if (head === "system") return "a system/automation task";
  return `a ${head || "unknown"} chat`;
}

// Dreaming + auto-title helpers (also the test-facing surface — dist/ bundles
// only sc and lib entries, so tests reach these through dist/lib.js).
export {
  titlePrompt,
  cleanTitle,
  DREAM_SESSION_KEY,
  runSweep,
  lightFromFiles,
  lightFromTranscripts,
  lightStage,
  remThemes,
  deepCluster,
  deepSignals,
  deepDecide,
  consolidationPrompt,
  parseConsolidation,
  applyConsolidationOps,
  appendOnlyPromotion,
  consolidateGated,
  promotePreview,
  backfillPreview,
  type RawLine,
  type DeepDecision,
  type DreamTheme,
  type SweepVerdict,
} from "./agent/dream.js";



// Auth profiles + provider plugins (Partial #6)
export {
  resolveConfiguredProviders,
  resolveAuthProfileOrder,
  resolveProviderCredential,
  boundProfileIds,
  profileCheck,
  profileStatus,
  profileId,
  markAuthOutcome,
  type AuthReason,
  type ProfileStatus,
} from "./agent/auth.js";
export { PROVIDER_PLUGINS, pluginById, pluginSummaries, type ProviderPlugin, type AuthMethodId } from "./agent/provider-plugins.js";
export {
  requestDeviceAuthorization,
  pollDeviceToken,
  deviceLogin,
  DeviceFlowError,
  type DeviceAuthorization,
  type TokenSuccess,
} from "./agent/oauth-device.js";

// Local services (Partial #7)
export { LOCAL_SERVICES, localServiceById, probeLocalService, scanLocalServices, addLocalService, type LocalServiceInfo, type LocalScanResult } from "./agent/local-services.js";
export {
  evaluateExec,
  splitChain,
  tokenizeArgv,
  globMatcher,
  hashArgv,
  safeBinCheck,
  inlineEvalCarrier,
  runDirectChain,
  emptyApprovalsDoc,
  loadApprovalsDoc,
  saveApprovalsDoc,
  ledgerEntries,
  mintAlwaysEntry,
  addManualEntry,
  revokeEntry,
  resolveBinary,
  newEntryId,
  type AllowlistEntry,
  type ApprovalsDoc,
  type ExecVerdict,
  type ChainOp,
  type SegmentPlan,
} from "./agent/exec-policy.js";
