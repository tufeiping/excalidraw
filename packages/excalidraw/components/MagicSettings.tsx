import { useState } from "react";
import { Dialog } from "./Dialog";
import { TextField } from "./TextField";
import { MagicIcon, OpenAIIcon } from "./icons";
import { FilledButton } from "./FilledButton";
import { CheckboxItem } from "./CheckboxItem";
import { KEYS } from "../keys";
import { useUIAppState } from "../context/ui-appState";
import { InlineIcon } from "./InlineIcon";
import { Paragraph } from "./Paragraph";

import "./MagicSettings.scss";
import TTDDialogTabs from "./TTDDialog/TTDDialogTabs";
import { TTDDialogTab } from "./TTDDialog/TTDDialogTab";
import { Button } from "./Button";

export const MagicSettings = (props: {
  openAIKey: string | null;
  isPersisted: boolean;
  onChange: (key: string, shouldPersist: boolean) => void;
  onConfirm: (key: string, shouldPersist: boolean) => void;
  onClose: () => void;
}) => {
  const [keyInputValue, setKeyInputValue] = useState(props.openAIKey || "");
  const [shouldPersist, setShouldPersist] = useState<boolean>(
    props.isPersisted,
  );

  const appState = useUIAppState();

  const onConfirm = () => {
    setShouldPersist(true);
    props.onConfirm(keyInputValue.trim(), true);
  };

  if (appState.openDialog?.name !== "settings") {
    return null;
  }

  return (
    <Dialog
      onCloseRequest={() => {
        props.onClose();
        props.onConfirm(keyInputValue.trim(), shouldPersist);
      }}
      title={
        <div style={{ display: "flex" }}>
          线框图转代码 (AI){" "}
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
      {/*  <h2
        style={{
          margin: 0,
          fontSize: "1.25rem",
          paddingLeft: "2.5rem",
        }}
      >
        AI 设置
      </h2> */}
      <TTDDialogTabs dialog="settings" tab={appState.openDialog.tab}>
        {/* <TTDDialogTabTriggers>
          <TTDDialogTabTrigger tab="text-to-diagram">
            <InlineIcon icon={brainIcon} /> 文本转图表
          </TTDDialogTabTrigger>
          <TTDDialogTabTrigger tab="diagram-to-code">
            <InlineIcon icon={MagicIcon} /> 线框图转代码
          </TTDDialogTabTrigger>
        </TTDDialogTabTriggers> */}
        {/* <TTDDialogTab className="ttd-dialog-content" tab="text-to-diagram">
          待办
        </TTDDialogTab> */}
        <TTDDialogTab
          //  className="ttd-dialog-content"
          tab="diagram-to-code"
        >
          <Paragraph>
            对于线框图转代码功能，我们使用
            {/* <InlineIcon icon={OpenAIIcon} /> */}
            DeepSeek服务。
          </Paragraph>
          <Paragraph>
            DeepSeek 是国内性价比比较高的AI服务，您可以创建一个
            <a
              href="https://platform.deepseek.com/"
              rel="noopener noreferrer"
              target="_blank"
            >
              DeepSeek 账户
            </a>
            ，可以充值10元，并
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
            您的 DeepSeek 密钥不会离开浏览器，您还可以根据需要在 DeepSeek 账户仪表板中设置自己的限制。
          </Paragraph>
          <TextField
            isRedacted
            value={keyInputValue}
            placeholder="在此粘贴您的 API 密钥"
            label="DeepSeek API 密钥"
            onChange={(value) => {
              setKeyInputValue(value);
              props.onChange(value.trim(), shouldPersist);
            }}
            selectOnRender
            onKeyDown={(event) => event.key === KEYS.ENTER && onConfirm()}
          />
          <Paragraph>
            默认情况下，您的 API 仅存在浏览器缓存中，您可以点击下面按钮随时清理缓存的 KEY。
          </Paragraph>

          {/* <CheckboxItem checked={shouldPersist} onChange={setShouldPersist}>
            在浏览器存储中持久化 API 密钥
          </CheckboxItem> */}

          <FilledButton
            className="MagicSettings__confirm"
            size="medium"
            label="清除浏览器缓存的 API KEY"
            onClick={() => {
              setKeyInputValue("");
              localStorage.removeItem("excalidraw-oai-api-key");
            }}
          />

          <Paragraph>
            设置 API 密钥后，您可以使用 <InlineIcon icon={MagicIcon} /> {"\n"}
            工具将您的元素包装在一个框架中，然后将其转换为代码。此对话框可以通过{" "}
            <b>AI 设置</b>
            {/* <InlineIcon icon={OpenAIIcon} /> */}
            访问。
          </Paragraph>

          <FilledButton
            className="MagicSettings__confirm"
            size="large"
            label="确认"
            onClick={onConfirm}
          />
        </TTDDialogTab>
      </TTDDialogTabs>
    </Dialog>
  );
};
