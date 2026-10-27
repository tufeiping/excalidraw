/**
 * AI provider configuration for the canvas agent.
 *
 * Two ways to get a brain, both stored in this browser only:
 *
 * - `ne`      — the deployment's own LLM relay (`/api/llm/*`), authenticated by
 *               the existing FlyLaTeX session cookie. Nothing secret is stored
 *               here: the relay owns the upstream credentials.
 * - `custom`  — any OpenAI-compatible endpoint (DeepSeek, OpenAI, Ollama, …)
 *               called directly from the browser with the user's own key.
 *
 * The whole config lives under a single versioned key so later additions do not
 * collide with anything else in `localStorage`.
 */

export type AiMode = "ne" | "custom" | "off";

export type AiPreset = {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
};

/**
 * Presets only prefill the three fields; everything stays editable, because
 * self-hosted gateways and proxies rarely match the vendor's canonical URL.
 */
export const AI_PRESETS: readonly AiPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash",
  },
  {
    id: "moonshot",
    label: "Moonshot",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
  },
  {
    id: "siliconflow",
    label: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-V3",
  },
  {
    id: "ollama",
    label: "Ollama (本地)",
    baseUrl: "http://localhost:11434/v1",
    model: "llama3.1",
  },
  { id: "custom", label: "自定义", baseUrl: "", model: "" },
];

/** `custom` section: a plain OpenAI-compatible endpoint + key. */
export type CustomAiConfig = {
  preset: string;
  baseUrl: string;
  model: string;
  apiKey: string;
};

/** `ne` section: only the model preference lives here (relay owns the rest). */
export type NeAiConfig = {
  /** empty string = let the relay pick its default model */
  model: string;
};

export type AiConfig = {
  mode: AiMode;
  custom: CustomAiConfig;
  ne: NeAiConfig;
};

export const AI_CONFIG_STORAGE_KEY = "excalidraw-ai-config:v1";
/** legacy single-key storage, migrated on first read */
export const LEGACY_AI_KEY_STORAGE_KEY = "excalidraw-oai-api-key";
/** fired whenever the config changes, so open UI can re-read it */
export const AI_CONFIG_CHANGED_EVENT = "excalidraw-ai-config-changed";

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";

const trim = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const runtimeEnv = () =>
  (typeof window !== "undefined" ? window.__EXCALIDRAW_ENV__ : undefined) ?? {};

/**
 * Base URL of the deployment's relay. Same origin by default, which is what
 * makes the session cookie work without any CORS setup.
 */
export const getNeBaseUrl = (): string =>
  trim(runtimeEnv().neBaseUrl) ||
  trim(import.meta.env.VITE_APP_NE_LLM_BASE_URL) ||
  "/api/llm";

/** Where the relay's OpenAI-compatible surface lives. */
export const getNeOpenAiBaseUrl = (): string => `${getNeBaseUrl()}/v1`;

const defaultMode = (): AiMode => {
  const injected =
    trim(runtimeEnv().aiMode) || trim(import.meta.env.VITE_APP_AI_MODE);
  return injected === "custom" || injected === "off" || injected === "ne"
    ? injected
    : "ne";
};

const defaultBaseUrl = (): string =>
  trim(runtimeEnv().aiBackend) ||
  trim(import.meta.env.VITE_APP_AI_BACKEND) ||
  DEFAULT_BASE_URL;

const defaultModel = (): string =>
  trim(runtimeEnv().aiModel) ||
  trim(import.meta.env.VITE_APP_AI_MODEL) ||
  DEFAULT_MODEL;

const defaultConfig = (): AiConfig => ({
  mode: defaultMode(),
  custom: {
    preset: "deepseek",
    baseUrl: defaultBaseUrl(),
    model: defaultModel(),
    apiKey: trim(runtimeEnv().aiApiKey),
  },
  ne: { model: "" },
});

const normalizeCustom = (raw: unknown): CustomAiConfig => {
  const input = (raw ?? {}) as Partial<Record<keyof CustomAiConfig, unknown>>;
  return {
    preset: trim(input.preset) || "custom",
    baseUrl: trim(input.baseUrl),
    model: trim(input.model),
    apiKey: trim(input.apiKey),
  };
};

/**
 * Parses whatever is in storage and repairs it. Anything unreadable falls back
 * to defaults instead of throwing — a broken config must not brick the panel.
 */
const parseConfig = (raw: string | null): AiConfig | null => {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AiConfig> | null;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const mode =
      parsed.mode === "custom" || parsed.mode === "off" || parsed.mode === "ne"
        ? parsed.mode
        : defaultMode();
    return {
      mode,
      custom: normalizeCustom(parsed.custom),
      ne: { model: trim((parsed.ne as NeAiConfig | undefined)?.model) },
    };
  } catch {
    return null;
  }
};

/** Pulls a key from the pre-config-format storage into `custom.apiKey`. */
const migrateLegacy = (config: AiConfig): AiConfig => {
  if (config.custom.apiKey) {
    return config;
  }
  try {
    const legacy = trim(window.localStorage.getItem(LEGACY_AI_KEY_STORAGE_KEY));
    if (!legacy) {
      return config;
    }
    // an existing key means the user was already on a browser-side provider
    return {
      ...config,
      mode: config.mode === "off" ? "custom" : config.mode,
      custom: { ...config.custom, apiKey: legacy },
    };
  } catch {
    return config;
  }
};

export const readAiConfig = (): AiConfig => {
  const base = defaultConfig();
  if (typeof window === "undefined") {
    return base;
  }
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(AI_CONFIG_STORAGE_KEY);
  } catch {
    // private mode / disabled storage: still usable within the session
    return base;
  }
  const parsed = parseConfig(stored);
  return migrateLegacy(parsed ?? base);
};

export const writeAiConfig = (config: AiConfig): AiConfig => {
  const next: AiConfig = {
    mode: config.mode,
    custom: normalizeCustom(config.custom),
    ne: { model: trim(config.ne?.model) },
  };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(AI_CONFIG_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore quota / disabled storage
    }
    window.dispatchEvent(new Event(AI_CONFIG_CHANGED_EVENT));
  }
  return next;
};

export const updateAiConfig = (patch: Partial<AiConfig>): AiConfig =>
  writeAiConfig({ ...readAiConfig(), ...patch });

export const updateCustomAiConfig = (
  patch: Partial<CustomAiConfig>,
): AiConfig => {
  const current = readAiConfig();
  return writeAiConfig({
    ...current,
    custom: { ...current.custom, ...patch },
  });
};

/** Applies a preset, keeping the API key the user may already have typed. */
export const applyAiPreset = (presetId: string): AiConfig => {
  const preset = AI_PRESETS.find((item) => item.id === presetId);
  if (!preset) {
    return updateCustomAiConfig({ preset: presetId });
  }
  return updateCustomAiConfig({
    preset: preset.id,
    ...(preset.baseUrl ? { baseUrl: preset.baseUrl } : {}),
    ...(preset.model ? { model: preset.model } : {}),
  });
};

/**
 * Adds the `/v1` suffix most OpenAI-compatible providers expect, but only when
 * the user pasted a bare host (`https://api.deepseek.com`).
 */
export const normalizeBaseUrl = (value: string): string => {
  const url = trim(value).replace(/\/+$/, "");
  if (!url) {
    return "";
  }
  try {
    const parsed = new URL(url);
    if (parsed.pathname === "" || parsed.pathname === "/") {
      return `${url}/v1`;
    }
    return url;
  } catch {
    return url;
  }
};

export const getAiMode = (): AiMode => readAiConfig().mode;

/**
 * Whether the agent has enough configuration to attempt a request. For `ne` we
 * deliberately answer `true` without probing the network: the relay reports its
 * own state, and a stale "not configured" banner would be worse than an error
 * surfaced in the chat when the request actually fails.
 */
export const isAiConfigured = (): boolean => {
  const config = readAiConfig();
  if (config.mode === "ne") {
    return true;
  }
  if (config.mode === "custom") {
    return Boolean(
      config.custom.apiKey && normalizeBaseUrl(config.custom.baseUrl),
    );
  }
  return false;
};

/** Model name to show in the UI ("relay default" when not pinned). */
export const describeAiModel = (relayDefault?: string): string => {
  const config = readAiConfig();
  if (config.mode === "ne") {
    return config.ne.model || relayDefault || "default";
  }
  return config.custom.model || defaultModel();
};

/** True when the user picked the relay and therefore needs a FlyLaTeX session. */
export const usesNeRelay = (): boolean => readAiConfig().mode === "ne";
