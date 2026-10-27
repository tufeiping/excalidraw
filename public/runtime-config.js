// Runtime configuration placeholder.
// In Docker deployments this file is overwritten at container start by
// /docker-entrypoint.d/99-excalidraw-runtime-config.sh, using environment
// variables. When served without that script (e.g. `yarn start`), the app
// falls back to the values baked in at build time.
//
// AI-related keys (all optional):
//   aiMode     "ne" (default: this deployment's LLM relay) | "custom" | "off"
//   neBaseUrl  base of the relay, default "/api/llm" (same origin — the relay
//              authenticates with the session cookie, never with a key)
//   aiBackend  default base URL for the "custom" mode's settings form
//   aiModel    default model for the "custom" mode's settings form
window.__EXCALIDRAW_ENV__ = window.__EXCALIDRAW_ENV__ || {};
