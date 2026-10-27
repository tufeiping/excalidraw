import { useState } from "react";

import { KEYS } from "@excalidraw/common";

import { useUIAppState } from "../context/ui-appState";
import { useI18n } from "../i18n";

import { Dialog } from "./Dialog";
import { FilledButton } from "./FilledButton";
import { Paragraph } from "./Paragraph";
import { TextField } from "./TextField";
import { CloseIcon } from "./icons";

import "./MagicSettings.scss";

export type AiSettingsMode = "ne" | "custom" | "off";

export type AiSettingsCustom = {
  preset: string;
  baseUrl: string;
  model: string;
  apiKey: string;
};

export type AiSettingsPreset = { id: string; label: string };

export type AiSettingsNeStatus = {
  state: "unknown" | "checking" | "ok" | "error";
  /** resolved model name when the relay answered */
  model?: string;
  /** account label (`nick_name` / email) when the relay answered */
  account?: string;
  /** one of the relay's failure reasons */
  reason?:
    | "not_logged_in"
    | "ne_not_linked"
    | "reauth_required"
    | "unavailable"
    | "no_llm_access";
  /** models this account may use, in the relay's order */
  models?: string[];
  /** `user` = charged to this account, `service` = the deployment pays */
  billing?: "user" | "service";
  /** identities the relay checked; own data, shown to make 401s explainable */
  identifiers?: string[];
  /** remaining NE quota, as reported by the gateway (same number as the
   * account page — never recomputed here) */
  remaining?: number | null;
  /** tokens spent today, from the relay's own call ledger */
  todayTokens?: number | null;
};

/**
 * AI settings dialog.
 *
 * The dialog is intentionally stateless about storage: it renders whatever the
 * host app passes in and reports edits back. That keeps `packages/excalidraw`
 * free of `localStorage` knowledge and lets the host own persistence,
 * migration and the relay probe.
 */
export const MagicSettings = ({
  mode,
  custom,
  presets,
  neStatus,
  neModel,
  onChangeMode,
  onChangeCustom,
  onChangeNeModel,
  onCheckNe,
  onClose,
}: {
  mode: AiSettingsMode;
  custom: AiSettingsCustom;
  presets: readonly AiSettingsPreset[];
  neStatus: AiSettingsNeStatus;
  /** model pinned for the relay, empty = let the server choose */
  neModel: string;
  onChangeMode: (mode: AiSettingsMode) => void;
  onChangeCustom: (patch: Partial<AiSettingsCustom>) => void;
  onChangeNeModel: (model: string) => void;
  onCheckNe: () => void;
  onClose: () => void;
}) => {
  const { t } = useI18n();
  const appState = useUIAppState();
  const [showKey, setShowKey] = useState(false);

  const onConfirm = () => onClose();

  const onClearKey = () => {
    onChangeCustom({ apiKey: "" });
    setShowKey(false);
  };

  if (appState.openDialog?.name !== "settings") {
    return null;
  }

  // a service-billed session has no balance of its own — say so instead of
  // showing a number that belongs to someone else
  const billedByService =
    neStatus.state === "ok" && neStatus.billing === "service";
  const checkedAccounts = neStatus.identifiers?.length
    ? t("aiSettings.neCheckedAccounts", {
        accounts: neStatus.identifiers.join(" / "),
      })
    : "";

  const neDetail =
    neStatus.state === "ok"
      ? billedByService
        ? t("aiSettings.neOkService", {
            account: neStatus.account ?? "",
            model: neStatus.model ?? "",
          })
        : t("aiSettings.neOk", {
            account: neStatus.account ?? "",
            model: neStatus.model ?? "",
          })
      : neStatus.state === "checking"
      ? t("aiSettings.neChecking")
      : neStatus.reason === "not_logged_in"
      ? t("aiSettings.neNotLoggedIn")
      : neStatus.reason === "ne_not_linked"
      ? t("aiSettings.neNotLinked") +
        (checkedAccounts ? ` ${checkedAccounts}` : "")
      : neStatus.reason === "reauth_required"
      ? t("aiSettings.neReauth")
      : neStatus.reason === "no_llm_access"
      ? t("aiSettings.neNoAccess")
      : neStatus.state === "error"
      ? t("aiSettings.neUnavailable")
      : t("aiSettings.neUnknown");

  return (
    <Dialog
      onCloseRequest={onConfirm}
      title={
        <span className="MagicSettings__titleRow">
          <span>{t("aiSettings.title")}</span>
          <button
            type="button"
            className="MagicSettings__close"
            onClick={onClose}
            title={t("buttons.close")}
            aria-label={t("buttons.close")}
          >
            {CloseIcon}
          </button>
        </span>
      }
      className="MagicSettings"
      // this dialog writes settings as you change them, so a stray click on the
      // backdrop must not dismiss it: it is a modal, not a popover
      closeOnClickOutside={false}
      autofocus={false}
    >
      <Paragraph>{t("aiSettings.intro")}</Paragraph>

      <div className="MagicSettings__modes" role="radiogroup">
        {(
          [
            ["ne", t("aiSettings.modeNe")],
            ["custom", t("aiSettings.modeCustom")],
            ["off", t("aiSettings.modeOff")],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={mode === value}
            className={
              mode === value
                ? "MagicSettings__mode MagicSettings__mode--active"
                : "MagicSettings__mode"
            }
            onClick={() => onChangeMode(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "ne" ? (
        <div className="MagicSettings__section">
          <Paragraph>{t("aiSettings.neIntro")}</Paragraph>
          <div className="MagicSettings__status">
            <span
              className={
                neStatus.state === "ok"
                  ? "MagicSettings__dot MagicSettings__dot--ok"
                  : "MagicSettings__dot"
              }
            />
            <span>{neDetail}</span>
          </div>
          {neStatus.models?.length ? (
            <>
              <label className="MagicSettings__label" htmlFor="ai-ne-model">
                {t("aiSettings.modelLabel")}
              </label>
              <select
                id="ai-ne-model"
                className="MagicSettings__select"
                value={neModel || neStatus.models[0]}
                onChange={(event) => onChangeNeModel(event.target.value)}
              >
                {neStatus.models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            </>
          ) : null}

          {!billedByService && typeof neStatus.remaining === "number" ? (
            <div className="MagicSettings__quota">
              <span>
                {t("aiSettings.neBalance", {
                  remaining: neStatus.remaining.toLocaleString(),
                })}
              </span>
              {typeof neStatus.todayTokens === "number" ? (
                <span>
                  {t("aiSettings.neToday", {
                    tokens: neStatus.todayTokens.toLocaleString(),
                  })}
                </span>
              ) : null}
            </div>
          ) : null}

          <div className="MagicSettings__row">
            <FilledButton
              size="medium"
              variant="outlined"
              color="muted"
              label={
                neStatus.state === "checking"
                  ? t("aiSettings.neChecking")
                  : t("aiSettings.neCheck")
              }
              onClick={onCheckNe}
            />
          </div>
          <Paragraph>{t("aiSettings.neHint")}</Paragraph>
        </div>
      ) : null}

      {mode === "custom" ? (
        <div className="MagicSettings__section">
          <Paragraph>{t("aiSettings.customIntro")}</Paragraph>

          <label className="MagicSettings__label" htmlFor="ai-preset">
            {t("aiSettings.presetLabel")}
          </label>
          <select
            id="ai-preset"
            className="MagicSettings__select"
            value={custom.preset || "custom"}
            onChange={(event) => onChangeCustom({ preset: event.target.value })}
          >
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>

          <TextField
            value={custom.baseUrl}
            label={t("aiSettings.baseUrlLabel")}
            placeholder={t("aiSettings.baseUrlPlaceholder")}
            onChange={(value) => onChangeCustom({ baseUrl: value })}
          />
          <TextField
            value={custom.model}
            label={t("aiSettings.modelLabel")}
            placeholder={t("aiSettings.modelPlaceholder")}
            onChange={(value) => onChangeCustom({ model: value })}
          />
          <TextField
            isRedacted={!showKey}
            value={custom.apiKey}
            placeholder={t("aiSettings.keyPlaceholder")}
            label={t("aiSettings.keyLabel")}
            onChange={(value) => onChangeCustom({ apiKey: value })}
            onKeyDown={(event) => event.key === KEYS.ENTER && onConfirm()}
          />
          <div className="MagicSettings__row">
            <FilledButton
              className="MagicSettings__clear"
              variant="outlined"
              color="muted"
              size="medium"
              label={
                showKey ? t("aiSettings.hideKey") : t("aiSettings.showKey")
              }
              onClick={() => setShowKey((value) => !value)}
            />
            <FilledButton
              className="MagicSettings__clear"
              variant="outlined"
              color="muted"
              size="medium"
              label={t("aiSettings.clearCached")}
              onClick={onClearKey}
            />
          </div>
          <Paragraph>{t("aiSettings.privacy")}</Paragraph>
        </div>
      ) : null}

      {mode === "off" ? (
        <div className="MagicSettings__section">
          <Paragraph>{t("aiSettings.offIntro")}</Paragraph>
        </div>
      ) : null}

      <Paragraph>{t("aiSettings.capabilities")}</Paragraph>

      {/* same component, same size for both: a 40px primary next to a 32px
          hand-rolled secondary reads as a layout bug, not as hierarchy */}
      <div className="MagicSettings__footer">
        <FilledButton
          variant="outlined"
          size="medium"
          label={t("buttons.close")}
          onClick={onClose}
        />
        <FilledButton
          size="medium"
          label={t("aiSettings.confirm")}
          onClick={onConfirm}
        />
      </div>
    </Dialog>
  );
};
