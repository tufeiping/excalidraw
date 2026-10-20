export type ExcalidrawRuntimeEnv = {
  /** Collaboration WebSocket server, e.g. wss://excalidraw.example.com */
  collabUrl?: string;
  /** Socket.IO path when the room server is mounted under a subpath */
  collabPath?: string;
  /** Scene storage backend read endpoint, e.g. https://example.com/api/v2/ */
  backendGetUrl?: string;
  /** Scene storage backend write endpoint, e.g. https://example.com/api/v2/post/ */
  backendPostUrl?: string;
  /**
   * AI provider:
   * - `excalidraw` (default): an excalidraw-compatible AI service, as used
   *   upstream (text-to-diagram chat streaming + diagram-to-code).
   * - `deepseek`: an OpenAI-compatible chat completions endpoint (DeepSeek),
   *   called directly from the browser with the user's own API key.
   */
  aiProvider?: string;
  /** AI backend base URL, e.g. https://api.deepseek.com */
  aiBackend?: string;
  /** Model name used by OpenAI-compatible providers, e.g. deepseek-chat */
  aiModel?: string;
  /** API key used by OpenAI-compatible providers (may also be set in the UI) */
  aiApiKey?: string;
};

const trim = (value?: string) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const getRuntimeEnv = (): ExcalidrawRuntimeEnv => {
  if (typeof window === "undefined") {
    return {};
  }
  return window.__EXCALIDRAW_ENV__ || {};
};

const withTrailingSlash = (url: string) =>
  url.endsWith("/") ? url : `${url}/`;

/**
 * Runtime configuration (injected via runtime-config.js) takes precedence over
 * the values baked in at build time (`import.meta.env`), so deployments can
 * point at their own collaboration/storage services without rebuilding.
 */
export const getCollabServerUrl = (): string =>
  trim(getRuntimeEnv().collabUrl) ?? import.meta.env.VITE_APP_WS_SERVER_URL;

/**
 * Optional Socket.IO path, for deployments where the default `/socket.io/`
 * already belongs to another service on the same domain.
 */
export const getCollabSocketPath = (): string | undefined => {
  const path = trim(getRuntimeEnv().collabPath);
  if (!path) {
    return undefined;
  }
  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  return withLeadingSlash.endsWith("/")
    ? withLeadingSlash
    : `${withLeadingSlash}/`;
};

export const getBackendGetUrl = (): string =>
  withTrailingSlash(
    trim(getRuntimeEnv().backendGetUrl) ??
      import.meta.env.VITE_APP_BACKEND_V2_GET_URL,
  );

export const getBackendPostUrl = (): string => {
  const runtimeEnv = getRuntimeEnv();

  const explicitPostUrl = trim(runtimeEnv.backendPostUrl);
  if (explicitPostUrl) {
    return explicitPostUrl;
  }

  const runtimeGetUrl = trim(runtimeEnv.backendGetUrl);
  if (runtimeGetUrl) {
    return `${withTrailingSlash(runtimeGetUrl)}post/`;
  }

  return import.meta.env.VITE_APP_BACKEND_V2_POST_URL;
};

export type AiProvider = "excalidraw" | "deepseek";

/** localStorage key holding the user-provided API key (set from AI settings) */
export const AI_API_KEY_STORAGE_KEY = "excalidraw-oai-api-key";

/**
 * Which AI backend protocol to speak. DeepSeek (and compatible endpoints) are
 * called directly from the browser; `excalidraw` talks to an excalidraw AI
 * service (https://github.com/excalidraw/excalidraw-room style backend).
 */
export const getAiProvider = (): AiProvider =>
  (trim(getRuntimeEnv().aiProvider) ??
    trim(import.meta.env.VITE_APP_AI_PROVIDER)) === "deepseek"
    ? "deepseek"
    : "excalidraw";

/** AI backend base URL without trailing slash */
export const getAiBackendUrl = (): string => {
  const url =
    trim(getRuntimeEnv().aiBackend) ??
    trim(import.meta.env.VITE_APP_AI_BACKEND) ??
    "https://api.deepseek.com";
  return url.replace(/\/+$/, "");
};

/** Model used by OpenAI-compatible providers */
export const getAiModel = (): string =>
  trim(getRuntimeEnv().aiModel) ??
  trim(import.meta.env.VITE_APP_AI_MODEL) ??
  "deepseek-chat";

/**
 * API key for OpenAI-compatible providers. A key entered by the user in AI
 * settings wins; a key injected by the deployment (`EXCALIDRAW_AI_API_KEY`) is
 * used as a shared fallback.
 */
export const getAiApiKey = (): string | undefined =>
  trim(
    typeof window !== "undefined"
      ? window.localStorage.getItem(AI_API_KEY_STORAGE_KEY) ?? undefined
      : undefined,
  ) ?? trim(getRuntimeEnv().aiApiKey);

export const setAiApiKey = (key: string | undefined) => {
  if (typeof window === "undefined") {
    return;
  }
  if (trim(key)) {
    window.localStorage.setItem(AI_API_KEY_STORAGE_KEY, key as string);
  } else {
    window.localStorage.removeItem(AI_API_KEY_STORAGE_KEY);
  }
};

/** True when a client-side key is required but missing */
export const isAiApiKeyMissing = (): boolean =>
  getAiProvider() === "deepseek" && !getAiApiKey();
