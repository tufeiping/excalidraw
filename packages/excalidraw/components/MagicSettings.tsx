import { useState } from "react";

import { KEYS } from "@excalidraw/common";

import { useUIAppState } from "../context/ui-appState";

import { Dialog } from "./Dialog";
import { FilledButton } from "./FilledButton";
import { MagicIcon } from "./icons";
import { InlineIcon } from "./InlineIcon";
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
      title={
        <div style={{ display: "flex" }}>
          文本转图表 (AI){" "}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0.1rem 0.5rem",
              marginLeft: "1rem",
              fontSize: 14,
              borderRadius: "12px",
              background: "var(--color-promo)",
              color: "var(--color-surface-lowest)",
            }}
          >
            实验性
          </div>
        </div>
      }
      className="MagicSettings"
      autofocus={false}
    >
      <Paragraph>
        对于文本转图表功能，我们使用 <InlineIcon icon={MagicIcon} /> DeepSeek
        服务（也可通过运行时配置指向任何 OpenAI 兼容接口）。
      </Paragraph>
      <Paragraph>
        DeepSeek 是国内性价比比较高的 AI 服务，您可以创建一个{" "}
        <a
          href="https://platform.deepseek.com/"
          rel="noopener noreferrer"
          target="_blank"
        >
          DeepSeek 账户
        </a>
        ，充值少量额度，并
        <a
          href="https://platform.deepseek.com/api_keys"
          rel="noopener noreferrer"
          target="_blank"
        >
          生成您自己的 API 密钥
        </a>
        。
      </Paragraph>
      <Paragraph>
        您的 API
        密钥不会离开浏览器，只保存在本地浏览器存储中；部署方也可以通过运行时配置统一注入。
      </Paragraph>
      <TextField
        isRedacted
        value={keyInputValue}
        placeholder="在此粘贴您的 API 密钥"
        label="DeepSeek API 密钥"
        onChange={(value) => {
          setKeyInputValue(value);
          // persist as the user types so the key survives a reload
          onChange(value.trim());
        }}
        selectOnRender
        onKeyDown={(event) => event.key === KEYS.ENTER && onConfirm()}
      />
      <Paragraph>
        默认情况下，您的 API
        密钥只存在浏览器缓存中，您可以点击下面按钮随时清理缓存的密钥。
      </Paragraph>

      <FilledButton
        className="MagicSettings__confirm"
        size="medium"
        label="清除浏览器缓存的 API 密钥"
        onClick={onClear}
      />

      <Paragraph>
        设置 API
        密钥后，您可以在工具栏的「文本转图表」中输入提示词生成图表，也可以将画布元素包装成框架后转换为代码。
      </Paragraph>

      <FilledButton
        className="MagicSettings__confirm"
        size="large"
        label="确认"
        onClick={onConfirm}
      />
    </Dialog>
  );
};
