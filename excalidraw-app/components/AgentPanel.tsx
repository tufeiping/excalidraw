import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { useAgent } from "../agent/useAgent";

import "./AgentPanel.scss";

import type { ChatItem } from "../agent/chatStore";

const SUGGESTIONS = [
  "把当前画布整理成三列布局",
  "给选中的元素换成蓝色主题",
  "在这张图下面补一段结论说明",
];

/** Minimal markdown: paragraphs, inline code, bold, fenced code blocks. */
const RichText = ({ text }: { text: string }) => {
  const blocks = useMemo(() => {
    const parts = text.split(/```(?:[a-zA-Z0-9+#-]+)?\n?/);
    return parts.map((part, index) => ({ part, code: index % 2 === 1 }));
  }, [text]);

  return (
    <div className="agent-msg__body">
      {blocks.map(({ part, code }, index) =>
        code ? (
          <pre key={index}>{part.replace(/\n$/, "")}</pre>
        ) : (
          part
            .split(/\n{2,}/)
            .filter((paragraph) => paragraph.trim().length > 0)
            .map((paragraph, paragraphIndex) => (
              <p key={`${index}-${paragraphIndex}`}>
                {paragraph
                  .split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
                  .filter((token) => token.length > 0)
                  .map((token, tokenIndex) => {
                    if (/^`[^`]+`$/.test(token)) {
                      return <code key={tokenIndex}>{token.slice(1, -1)}</code>;
                    }
                    if (/^\*\*[^*]+\*\*$/.test(token)) {
                      return (
                        <strong key={tokenIndex}>{token.slice(2, -2)}</strong>
                      );
                    }
                    return <Fragment key={tokenIndex}>{token}</Fragment>;
                  })}
              </p>
            ))
        ),
      )}
    </div>
  );
};

const summarizeArgs = (args: string) => {
  if (!args) {
    return "";
  }
  try {
    const parsed = JSON.parse(args);
    const json = JSON.stringify(parsed);
    return json.length > 120 ? `${json.slice(0, 120)}…` : json;
  } catch {
    return args.length > 120 ? `${args.slice(0, 120)}…` : args;
  }
};

const statusLabel = (status: AgentItemStatus, name: string) => {
  switch (status) {
    case "thinking":
      return "思考中…";
    case "running-tool":
      return "正在操作画布…";
    default:
      return name;
  }
};

type AgentItemStatus = "idle" | "thinking" | "running-tool";

const ToolItem = ({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) => (
  <details className="agent-tool" data-status={item.status}>
    <summary>
      <span
        className={`agent-tool__dot agent-tool__dot--${
          item.status === "running" ? "running" : item.status
        }`}
      />
      <span className="agent-tool__name">{item.name}</span>
      <span className="agent-tool__args">{summarizeArgs(item.args)}</span>
    </summary>
    {item.content ? <pre>{item.content}</pre> : null}
  </details>
);

const MessageItem = ({ item }: { item: ChatItem }) => {
  if (item.kind === "tool") {
    return <ToolItem item={item} />;
  }

  if (item.kind === "assistant") {
    return (
      <div className="agent-msg agent-msg--assistant">
        {item.reasoning ? (
          <details className="agent-reasoning">
            <summary>思考过程</summary>
            <div>{item.reasoning}</div>
          </details>
        ) : null}
        {item.text ? <RichText text={item.text} /> : null}
      </div>
    );
  }

  return (
    <div className={`agent-msg agent-msg--${item.kind}`}>
      <div className="agent-msg__body">{item.text}</div>
    </div>
  );
};

export const AgentPanel = ({
  excalidrawAPI,
  open,
  onOpenChange,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const appState = useUIAppState();
  const { items, status, error, send, stop, reset, dismissError } =
    useAgent(excalidrawAPI);

  const [draft, setDraft] = useState("");
  const [elementCount, setElementCount] = useState(
    () => excalidrawAPI?.getSceneElements().length ?? 0,
  );

  const messagesRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  const selectedCount = Object.keys(appState.selectedElementIds ?? {}).length;
  const running = status !== "idle";
  const lastItem = items[items.length - 1];
  // the streaming bubble / pulsing tool chip already show progress
  const showIndicator =
    running &&
    lastItem?.kind !== "tool" &&
    !(lastItem?.kind === "assistant" && lastItem.text);

  useEffect(() => {
    if (!open) {
      return;
    }
    setElementCount(excalidrawAPI?.getSceneElements().length ?? 0);
  }, [excalidrawAPI, open, items, appState.selectedElementIds]);

  useEffect(() => {
    const node = messagesRef.current;
    if (!node || !stickToBottomRef.current) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [items]);

  const onScroll = useCallback(() => {
    const node = messagesRef.current;
    if (!node) {
      return;
    }
    stickToBottomRef.current =
      node.scrollHeight - node.scrollTop - node.clientHeight < 80;
  }, []);

  const submit = useCallback(() => {
    if (running) {
      return;
    }
    const value = draft.trim();
    if (!value) {
      return;
    }
    setDraft("");
    stickToBottomRef.current = true;
    void send(value);
  }, [draft, running, send]);

  if (!open) {
    return (
      <button
        type="button"
        className="agent-panel-toggle"
        onClick={() => onOpenChange(true)}
        title="AI 助手"
      >
        AI 助手
      </button>
    );
  }

  return (
    <aside className="agent-panel" aria-label="AI 助手">
      <div className="agent-panel__header">
        <span className="agent-panel__title">AI 助手</span>
        <span className="agent-panel__status">
          {statusLabel(status, `${elementCount} 个元素`)}
        </span>
        <button
          type="button"
          className="agent-panel__button"
          onClick={reset}
          disabled={running}
          title="清空当前对话"
        >
          新对话
        </button>
        <button
          type="button"
          className="agent-panel__button"
          onClick={() => onOpenChange(false)}
          title="收起面板"
        >
          收起
        </button>
      </div>

      <div
        className="agent-panel__messages"
        ref={messagesRef}
        onScroll={onScroll}
      >
        {items.length === 0 ? (
          <div className="agent-panel__empty">
            <div>
              我可以在画布上读、写、局部替换内容。当前画布有 {elementCount}{" "}
              个元素
              {selectedCount > 0 ? `，已选中 ${selectedCount} 个` : ""}。
            </div>
            <ul>
              {SUGGESTIONS.map((suggestion) => (
                <li key={suggestion}>
                  <button
                    type="button"
                    className="agent-panel__button"
                    onClick={() => {
                      stickToBottomRef.current = true;
                      void send(suggestion);
                    }}
                    disabled={running}
                  >
                    {suggestion}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          items.map((item) => <MessageItem key={item.id} item={item} />)
        )}
        {showIndicator ? (
          <div className="agent-msg agent-msg--notice">
            <div className="agent-msg__body">
              {status === "running-tool" ? "正在操作画布…" : "思考中…"}
            </div>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="agent-panel__hint">
          <span style={{ color: "var(--color-danger)" }}>{error}</span>
          {/密钥/.test(error) ? (
            <button
              type="button"
              className="agent-panel__button"
              onClick={() => {
                dismissError();
                excalidrawAPI?.updateScene({
                  appState: { openDialog: { name: "settings" } },
                });
              }}
            >
              去设置
            </button>
          ) : (
            <button
              type="button"
              className="agent-panel__button"
              onClick={dismissError}
            >
              知道了
            </button>
          )}
        </div>
      ) : null}

      <div className="agent-panel__composer">
        <div className="agent-panel__hint">
          <span>
            {selectedCount > 0
              ? `已选中 ${selectedCount} 个元素，说「这个」我会只改选中的部分`
              : "Enter 发送，Shift + Enter 换行"}
          </span>
        </div>
        <div className="agent-panel__input-row">
          <textarea
            className="agent-panel__input"
            value={draft}
            rows={2}
            placeholder="告诉我你想改什么…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !(event.nativeEvent as KeyboardEvent).isComposing
              ) {
                event.preventDefault();
                submit();
              }
            }}
          />
          {running ? (
            <button
              type="button"
              className="agent-panel__send agent-panel__stop"
              onClick={stop}
            >
              停止
            </button>
          ) : (
            <button
              type="button"
              className="agent-panel__send"
              onClick={submit}
              disabled={!draft.trim()}
            >
              发送
            </button>
          )}
        </div>
      </div>
    </aside>
  );
};
