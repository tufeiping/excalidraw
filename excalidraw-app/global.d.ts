import "@excalidraw/excalidraw/global";
import "@excalidraw/excalidraw/css";

declare global {
  interface Window {
    __EXCALIDRAW_SHA__: string | undefined;
    /**
     * Runtime configuration injected by `public/runtime-config.js` (or, in
     * Docker deployments, regenerated at container start from environment
     * variables). Takes precedence over build-time `import.meta.env` values.
     */
    __EXCALIDRAW_ENV__?: {
      collabUrl?: string;
      collabPath?: string;
      backendGetUrl?: string;
      backendPostUrl?: string;
      aiProvider?: string;
      aiBackend?: string;
      aiModel?: string;
      aiApiKey?: string;
    };
  }
}
