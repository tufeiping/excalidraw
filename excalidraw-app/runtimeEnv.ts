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

/**
 * AI configuration now lives in `aiConfig.ts`. What remains here is the
 * deployment-level defaults (`aiMode` / `aiBackend` / `aiModel`) that module
 * reads from `window.__EXCALIDRAW_ENV__` and `import.meta.env`.
 */
