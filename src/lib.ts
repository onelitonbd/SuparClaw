// Test surface: internals are exported so the test suite can import the built bundle.
export { Screen, clipToWidth, rule } from "./tui/renderer.js";
export { renderMarkdown, renderInline } from "./tui/markdown.js";
export { palette, theme, detectLightMode, markdownTheme } from "./tui/theme.js";
export { Editor } from "./tui/editor.js";
export { parseKeys } from "./tui/keys.js";
export { parseConfig, validate, applyDefaults, emptyConfig, CONFIG_SCHEMA } from "./config/schema.js";
export { parseFrontmatter, discoverSkills, matchSkills, skillsCatalog } from "./agent/skills.js";
export { Store } from "./state/db.js";
export { loadWorkspaceContext, writeWorkspaceTemplates, todayStamp } from "./agent/workspace.js";
export { buildRegistry, toolsToSchema, safePath } from "./agent/tools.js";
export { LlmClient, resolveModel, parseToolArgs } from "./agent/llm.js";
export { splitForTelegram } from "./channels/telegram.js";
export { width, truncateToWidth, wrapText, sanitize, stripAnsi } from "./util/ansi.js";
export { AgentLoop } from "./agent/loop.js";
export { Service } from "./agent/service.js";export { renderMarkdown as renderUiMarkdown, escapeHtml } from "../ui/src/markdown.js";
export { fuzzy } from "../ui/src/dom.js";
