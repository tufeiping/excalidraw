import { useState } from "react";

import { KEYS } from "@excalidraw/common";

import { useUIAppState } from "../context/ui-appState";
import { useI18n } from "../i18n";

import { Dialog } from "./Dialog";
import { FilledButton } from "./FilledButton";
import { Paragraph } from "./Paragraph";
import { TextField } from "./TextField";

import "./MagicSettings.scss";

/**
 * AI settings dialog.
 *
 * FlyLaTeX talks to an OpenAI-compatible endpoint (DeepSeek by default) directly
 * from the browser using the user's own API key, so the key never leaves the
 * device and no server proxy is required.
 */
export const MagicSettings = ({
  apiKey,
  onChange,
  onClose,
}: {
  apiKey: string | null;
  /**
   * Called with the (trimmed) key whenever it changes or the dialog is
   * confirmed/closed. The host app is responsible for persisting it.
   */
  onChange: (key: string) => void;
  onClose: () => void;
}) => {
  const { t } = useI18n();
  const [keyInputValue, setKeyInputValue] = useState(apiKey ?? "");
  const appState = useUIAppState();

  const onConfirm = () => {
    onChange(keyInputValue.trim());
    onClose();
  };

  const onClear = () => {
    setKeyInputValue("");
    onChange("");
  };

  if (appState.openDialog?.name !== "settings") {
    return null;
  }

  return (
    <Dialog
      onCloseRequest={onConfirm}
      title={t("aiSettings.title")}
      className="MagicSettings"
      autofocus={false}
    >
      <Paragraph>{t("aiSettings.intro")}</Paragraph>
      <Paragraph>
        {t("aiSettings.accountStart")}{" "}
        <a
          href="https://platform.deepseek.com/"
          rel="noopener noreferrer"
          target="_blank"
        >
          {t("aiSettings.accountLink")}
        </a>
        {t("aiSettings.accountMiddle")}{" "}
        <a
          href="https://platform.deepseek.com/api_keys"
          rel="noopener noreferrer"
          target="_blank"
        >
          {t("aiSettings.keyLink")}
        </a>
        {t("aiSettings.accountEnd")}
      </Paragraph>
      <Paragraph>{t("aiSettings.privacy")}</Paragraph>
      <TextField
        isRedacted
        value={keyInputValue}
        placeholder={t("aiSettings.keyPlaceholder")}
        label={t("aiSettings.keyLabel")}
        onChange={(value) => {
          setKeyInputValue(value);
          // persist as the user types so the key survives a reload
          onChange(value.trim());
        }}
        selectOnRender
        onKeyDown={(event) => event.key === KEYS.ENTER && onConfirm()}
      />

      <FilledButton
        className="MagicSettings__confirm"
        size="medium"
        label={t("aiSettings.clearCached")}
        onClick={onClear}
      />

      <Paragraph>{t("aiSettings.capabilities")}</Paragraph>

      <FilledButton
        className="MagicSettings__confirm"
        size="large"
        label={t("aiSettings.confirm")}
        onClick={onConfirm}
      />
    </Dialog>
  );
};
