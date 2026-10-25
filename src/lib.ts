// Test surface: internals are exported so the test suite can import the built bundle.
export { readTextSafe } from "./util/paths.js";
export { Screen, clipToWidth, rule } from "./tui/renderer.js";
export { renderMarkdown, renderInline } from "./tui/markdown.js";
export { palette, theme, detectLightMode, markdownTheme } from "./tui/theme.js";
export { Editor } from "./tui/editor.js";
export { parseKeys } from "./tui/keys.js";
export { parseConfig, validate, applyDefaults, emptyConfig, CONFIG_SCHEMA, modelProfiles, modelProfile, execModeOf, type ExecMode, type ExecAskFallback } from "./config/schema.js";
export { parseFrontmatter, discoverSkills, matchSkills, skillsCatalog, writeSkill, skillSlug, readSkillBody } from "./agent/skills.js";
export {
  CHARS_PER_TOKEN,
  WINDOW_SHARE,
  MAX_HISTORY_CHARS,
  MIN_HISTORY_CHARS,
  FALLBACK_HISTORY_CHARS,
  modelContextWindow,
  historyBudget,
  fallbackTuning,
  type HistoryBudget,
  type ModelTuning,
} from "./agent/context-budget.js";
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
export { parseWebAttachments, isImageMime, sanitizeAttachName, WEB_ATTACH_LIMITS } from "./gateway/web-attachments.js";
export { redactSecrets, resolveRedacted, resolveRedactedDeep, isRedacted, maskSecret, REDACTED_PREFIX } from "./config/redact.js";
export { auditConfig, type Finding } from "./cli/audit.js";
export { cmdChannels } from "./cli/channels.js";
export { runDoctorChecks, type DoctorCheck } from "./cli/doctor.js";
export { auditSecretsFile, type SecretsAuditResult } from "./cli/secrets.js";
export { systemUpdateCheck, systemUpdateApply, type UpdateStatus, type UpdateApplyResult } from "./cli/update.js";
export { splitForTelegram, telegramProxy, probeTelegramApi, describeError } from "./channels/telegram.js";
export { width, truncateToWidth, wrapText, sanitize, stripAnsi } from "./util/ansi.js";
export { AgentLoop } from "./agent/loop.js";
export { Subagents } from "./agent/subagents.js";
export { Service } from "./agent/service.js";export { renderMarkdown as renderUiMarkdown, escapeHtml } from "../ui/src/markdown.js";
export { fuzzy } from "../ui/src/dom.js";
export { fetchModels, PRESETS, formatProviders, addProvider, removeProvider, testProvider, maskKey, defaultModelLine, parseProviderAddArgs, canonicalModelRef } from "./config/providers.js";
export { ConfigService, readConfigFile, writeConfigFile } from "./config/load.js";
export { handleSlashExtension, slashHelp, slashCommands, SLASH_CATALOG } from "./agent/slash-commands.js";
export { handleHooksRequest, hookTokenFingerprint, type HookService } from "./gateway/webhooks.js";
export { handleOpenAiRequest, type OpenAiService } from "./gateway/openai-http.js";
export { isContextOverflowError, planCompactSpan, summarizerPrompt, renderSpan, clampSpanInput } from "./agent/compaction.js";
export { planInboundMedia, mediaPlaceholder, mediaFileName, downloadInboundMedia } from "./channels/telegram-media.js";
export { isVisionUnsupportedError } from "./agent/llm.js";
export { BotLoopGuard } from "./channels/bot-guard.js";
export { ToolLoopDetector, loopGuardPrompt, type ToolLoopBreak } from "./agent/loop-detector.js";
export { usageNumbers, runCost, fmtTokens, fmtCost, usageFooter, summarizeUsage, buildUsageReport } from "./util/usage.js";
export type { UsageRunInput, UsageReport } from "./util/usage.js";
export { jobTimezone } from "./cron/scheduler.js";
export { resolveDelivery, isEmptySummary, assertWebhookUrl, webhookPayload, errorStreak, shouldAlert } from "./cron/delivery.js";
export { parseLogLine, filterLogLines, readLogTail, readLogDelta } from "./cli/logs.js";
export { parseRepoSlug, resolveRef, currentSha, computeUpdatePlan, fetchRemoteHead } from "./cli/update.js";
export { parseUninstallArgs, planUninstall, deleteStateContents, cliRemovalHint, cmdUninstall } from "./cli/uninstall.js";
export { parseDurationMs, parseByteSize } from "./util/units.js";
export {
  settingsFromConfig,
  runSessionMaintenance,
  defaultDiskBytes,
  type MaintenanceReport,
  type MaintenanceOptions,
  type SessionMaintenanceConfig,
} from "./state/maintenance.js";
export { parseCleanupArgs, formatCleanupReport, cmdSessionsCleanup, type CleanupDeps } from "./cli/session-cleanup.js";
export { exportSlug, sessionStartDate, resolveSessionSelector, exportSessionTranscript, parseExportArgs, cmdSessionsExport } from "./cli/session-export.js";
export { sessionBackfill, rollbackBackfill, readRemSources, remBackfill, writeDiaryBlock, ingestHash, linesFromRows } from "./agent/backfill.js";
export { memoryCmd } from "./cli/memory-commands.js";
export { sandboxEnv, planSandbox, findPrlimit, findProot } from "./agent/exec-sandbox.js";
export { normalizeAskUserArgs, matchTextReply, renderQuestionText, ASK_LIMITS, type AskUserQuestion, type AskUserResult } from "./agent/ask-user.js";
export { createLogger } from "./util/log.js";
export { createBackup, verifyBackup, restoreBackup, listBackups, backupStamp, BACKUP_MANIFEST_VERSION, type BackupManifest, type BackupResult, type VerifyResult } from "./backup/backup.js";
export { resolveSecrets, substituteEnvText, isSecretRef, validateSecretRef, ENV_ID_RE, EXEC_ID_RE, PROVIDER_NAME_RE, type SecretRef } from "./config/secrets.js";
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
  touchEntries,
  resolveBinary,
  newEntryId,
  unattendedDecision,
  type AllowlistEntry,
  type ApprovalsDoc,
  type ExecVerdict,
  type ChainOp,
  type SegmentPlan,
  type UnattendedMode,
} from "./agent/exec-policy.js";
export {
  webSearch,
  renderSearchText,
  resolveProvider,
  backendById,
  kimiBaseUrl,
  WebSearchCache,
  WEB_SEARCH_BACKENDS,
  type WebSearchArgs,
  type WebSearchOutput,
  type WebSearchResultItem,
} from "./agent/web-search.js";
export {
  selectAttachments,
  resolveEntries,
  cliArgs,
  runUnderstanding,
  renderMediaBlocks,
  toolsMediaConfig,
  type MediaFact,
  type MediaOutcome,
} from "./agent/media-understanding.js";
export { analyzePdfs } from "./agent/pdf-tool.js";
export { extractPdfText } from "./util/pdf-text.js";
export { createTyping, type TypingHandle } from "./agent/typing.js";
export {
  ImapWatcher,
  gateMessage,
  readerPrompt,
  parseInternalDate,
  readImapState,
  writeImapState,
  IMAP_ACCOUNT_DEFAULTS,
  type ImapAccountState,
  type ImapConfig,
} from "./automation/imap.js";
export {
  Heartbeat,
  filterHeartbeatReply,
  stripStrayHeartbeatOk,
  parseHeartbeatEvery,
  heartbeatDecision,
  inActiveHours,
  DEFAULT_HEARTBEAT_PROMPT,
  HEARTBEAT_OK_BUDGET,
} from "./automation/heartbeat.js";
export {
  CodeMode,
  codeModeEngages,
  codeModeSurface,
  codeModePreferredFamilies,
  codeModeMatchedFamilies,
  codeModeExecutorBundled,
  isPreferredCodeModeModel,
  CODE_MODE_DEFAULTS,
  CODE_MODE_EXECUTORS,
  BUNDLED_CODE_MODE_EXECUTORS,
  type CodeModeConfig,
  type ExecCellResult,
} from "./agent/code-mode.js";
