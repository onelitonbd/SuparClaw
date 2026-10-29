// Provider plugins — OpenClaw's declarative provider registry at our scale.
// A descriptor declares a provider's auth methods ("every login flow runs
// through one entry point"), endpoint facts, and a model-credential hint.
// Built-ins ship for the common providers; config-defined custom providers
// interoperate via profile binding (providers.<name>.apiKey names a profile).

export type AuthMethodId = "api-key" | "device-code" | "token";

export interface ProviderPlugin {
  id: string;
  label: string;
  baseUrl: string;
  /** Conventional env var users already have (shown as a hint, never read into profiles). */
  env?: string;
  /** Supported login flows, in menu order. First = default method. */
  authMethods: AuthMethodId[];
  /** RFC 8628 OAuth-owned descriptors only (their `openai-codex` builtin). */
  oauth?: { deviceCodeUrl: string; tokenUrl: string; clientId: string; scope?: string };
  docsUrl?: string;
  /** Sensible default model to offer with --set-default (their per-provider default). */
  recommended?: string;
  /** Local providers don't want a key at all (token omitted). */
  keyOptional?: boolean;
}

export const PROVIDER_PLUGINS: ProviderPlugin[] = [
  {
    id: "openai",
    label: "OpenAI (ChatGPT/Codex OAuth + API keys)",
    baseUrl: "https://api.openai.com/v1",
    env: "OPENAI_API_KEY",
    authMethods: ["device-code", "api-key"],
    oauth: {
      deviceCodeUrl: "https://auth.openai.com/oauth/device/code",
      tokenUrl: "https://auth.openai.com/oauth/token",
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann", // Codex CLI's public OAuth client
      scope: "openid profile email offline_access",
    },
    docsUrl: "https://docs.openclaw.ai/providers/openai",
    recommended: "gpt-5",
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com/v1",
    env: "ANTHROPIC_API_KEY",
    authMethods: ["api-key", "token"],
    docsUrl: "https://docs.anthropic.com",
    recommended: "claude-sonnet-4-5",
  },
  {
    id: "google",
    label: "Google AI (Gemini)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    env: "GEMINI_API_KEY",
    authMethods: ["api-key"],
    docsUrl: "https://ai.google.dev",
    recommended: "gemini-2.5-flash",
  },
  {
    id: "openrouter",
    label: "OpenRouter (many models, one key)",
    baseUrl: "https://openrouter.ai/api/v1",
    env: "OPENROUTER_API_KEY",
    authMethods: ["api-key", "token"],
    docsUrl: "https://openrouter.ai/docs",
    recommended: "anthropic/claude-sonnet-4.5",
  },
  {
    id: "groq",
    label: "Groq (fast LPU inference)",
    baseUrl: "https://api.groq.com/openai/v1",
    env: "GROQ_API_KEY",
    authMethods: ["api-key"],
    docsUrl: "https://console.groq.com/docs",
    recommended: "llama-3.3-70b-versatile",
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    env: "XAI_API_KEY",
    authMethods: ["api-key", "token"],
    docsUrl: "https://docs.x.ai",
    recommended: "grok-4",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    env: "DEEPSEEK_API_KEY",
    authMethods: ["api-key"],
    recommended: "deepseek-chat",
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    env: "MISTRAL_API_KEY",
    authMethods: ["api-key"],
    docsUrl: "https://docs.mistral.ai",
    recommended: "mistral-large-latest",
  },
  {
    id: "kimi",
    label: "Moonshot AI (Kimi)",
    baseUrl: "https://api.moonshot.ai/v1",
    env: "MOONSHOT_API_KEY",
    authMethods: ["api-key"],
    recommended: "kimi-k2",
  },
  {
    id: "zai",
    label: "Z.AI (GLM)",
    baseUrl: "https://api.z.ai/api/paas/v4",
    env: "ZAI_API_KEY",
    authMethods: ["api-key"],
    recommended: "glm-4.6",
  },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud (hosted :cloud models)",
    baseUrl: "https://ollama.com/v1",
    env: "OLLAMA_API_KEY",
    authMethods: ["api-key"],
    recommended: "gpt-oss:120b-cloud",
  },
];

export const pluginById = (id: string): ProviderPlugin | undefined =>
  PROVIDER_PLUGINS.find((p) => p.id === id.toLowerCase().trim());

/** All login entry points advertise methods uniformly (their models auth login contract). */
export interface PluginSummary {
  id: string;
  label: string;
  baseUrl: string;
  env?: string;
  authMethods: AuthMethodId[];
  hasOAuth: boolean;
  recommended?: string;
  docsUrl?: string;
}

export const pluginSummaries = (): PluginSummary[] =>
  PROVIDER_PLUGINS.map((p) => ({
    id: p.id,
    label: p.label,
    baseUrl: p.baseUrl,
    env: p.env,
    authMethods: p.authMethods,
    hasOAuth: Boolean(p.oauth),
    recommended: p.recommended,
    docsUrl: p.docsUrl,
  }));
