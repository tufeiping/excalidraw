import { useCallback, useEffect, useState } from "react";

import { MagicSettings } from "@excalidraw/excalidraw/components/MagicSettings";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";

import type {
  AiSettingsCustom,
  AiSettingsMode,
  AiSettingsNeStatus,
} from "@excalidraw/excalidraw/components/MagicSettings";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  AI_PRESETS,
  applyAiPreset,
  readAiConfig,
  updateAiConfig,
  updateCustomAiConfig,
} from "../aiConfig";
import { getNeSession, invalidateNeSession } from "../agent/neClient";

/**
 * Hosts the AI settings dialog. Everything is persisted by `aiConfig` (browser
 * storage only); the relay probe is the only network call, and it is merely a
 * convenience — never a gate.
 */
export const AISettings = ({
  excalidrawAPI,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI;
}) => {
  const appState = useUIAppState();
  const [config, setConfig] = useState(readAiConfig);
  const [neStatus, setNeStatus] = useState<AiSettingsNeStatus>({
    state: "unknown",
  });

  const open = appState.openDialog?.name === "settings";

  const probe = useCallback(async () => {
    setNeStatus({ state: "checking" });
    invalidateNeSession();
    const session = await getNeSession({ force: true });
    setNeStatus(
      session.ok
        ? {
            state: "ok",
            account: session.user.name ?? session.user.sub,
            model: config.ne.model || session.defaultModel,
            models: session.models.length ? session.models : undefined,
            remaining: session.balance?.remaining ?? null,
            todayTokens: session.usage?.totalTokens ?? null,
          }
        : { state: "error", reason: session.reason },
    );
  }, [config.ne.model]);

  // probe when the dialog opens on the relay mode, so the user sees the real
  // state instead of having to click "check"
  useEffect(() => {
    if (!open) {
      setNeStatus({ state: "unknown" });
      return;
    }
    setConfig(readAiConfig());
    if (readAiConfig().mode === "ne") {
      void probe();
    }
  }, [open, probe]);

  if (!open) {
    return null;
  }

  return (
    <MagicSettings
      mode={config.mode}
      custom={config.custom}
      presets={AI_PRESETS}
      neStatus={neStatus}
      neModel={config.ne.model}
      onChangeMode={(mode: AiSettingsMode) => {
        setConfig(updateAiConfig({ mode }));
        if (mode === "ne") {
          void probe();
        }
      }}
      onChangeCustom={(patch: Partial<AiSettingsCustom>) => {
        // preset switches prefill base URL + model in one go
        if (
          patch.preset !== undefined &&
          patch.preset !== config.custom.preset
        ) {
          setConfig(applyAiPreset(patch.preset));
          return;
        }
        setConfig(updateCustomAiConfig(patch));
      }}
      onChangeNeModel={(model: string) =>
        setConfig(updateAiConfig({ ne: { model } }))
      }
      onCheckNe={() => void probe()}
      onClose={() =>
        excalidrawAPI.updateScene({ appState: { openDialog: null } })
      }
    />
  );
};
