// Runtime configuration placeholder.
// In Docker deployments this file is overwritten at container start by
// /docker-entrypoint.d/99-excalidraw-runtime-config.sh, using environment
// variables. When served without that script (e.g. `yarn start`), the app
// falls back to the values baked in at build time.
window.__EXCALIDRAW_ENV__ = window.__EXCALIDRAW_ENV__ || {};
