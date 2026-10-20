import { MagicSettings } from "@excalidraw/excalidraw/components/MagicSettings";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { getAiApiKey, setAiApiKey } from "../runtimeEnv";

/**
 * Hosts the AI (DeepSeek / OpenAI-compatible) settings dialog. The key is kept
 * in localStorage so it never leaves the browser.
 */
export const AISettings = ({
  excalidrawAPI,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI;
}) => {
  const appState = useUIAppState();

  if (appState.openDialog?.name !== "settings") {
    return null;
  }

  return (
    <MagicSettings
      apiKey={getAiApiKey() ?? null}
      onChange={(key) => setAiApiKey(key)}
      onClose={() =>
        excalidrawAPI.updateScene({ appState: { openDialog: null } })
      }
    />
  );
};
