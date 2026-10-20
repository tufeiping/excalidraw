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

/**
 * Minimal markdown: paragraphs, inline code, bold, fenced code blocks.
 *
 * Empty parts are dropped: an empty `<pre>` renders as a stray lavender bar,
 * and the model happily emits empty fences around tool chatter.
 */
const RichText = ({ text }: { text: string }) => {
  const blocks = useMemo(() => {
    const parts = text.split(/```(?:[a-zA-Z0-9+#-]+)?\n?/);
    return parts
      .map((part, index) => ({
        part: index % 2 === 1 ? part.replace(/\n$/, "") : part,
        code: index % 2 === 1,
      }))
      .filter(({ part, code }) => (code ? part.trim().length > 0 : true));
  }, [text]);

  if (!text.trim()) {
    return null;
  }

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

/** fences with nothing inside them are just noise (and render as a stray bar) */
const stripEmptyFences = (text: string) =>
  text.replace(/```[a-zA-Z0-9+#-]*\s*```/g, "");

const hasVisibleText = (text: string) =>
  stripEmptyFences(text).trim().length > 0;

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

type ToolStep = Extract<ChatItem, { kind: "tool" }>;

const ToolRow = ({ item }: { item: ToolStep }) => (
  <details className="agent-tool" data-status={item.status}>
    <summary>
      <span
        className={`agent-tool__dot agent-tool__dot--${
          item.status === "running" ? "running" : item.status
        }`}
      />
      <span className="agent-tool__name">{item.name || "画布操作"}</span>
      <span className="agent-tool__args">
        {summarizeArgs(item.args) || "已执行"}
      </span>
    </summary>
    {item.content ? <pre>{item.content}</pre> : null}
  </details>
);

/** one collapsed chip per run of tool calls, instead of a stack of rows */
const StepsRow = ({ steps }: { steps: ToolStep[] }) => {
  const running = steps.find((step) => step.status === "running");
  const failed = steps.filter((step) => step.status === "error").length;
  const status = running ? "running" : failed ? "error" : "ok";

  return (
    <details className="agent-steps" data-status={status}>
      <summary>
        <span className={`agent-tool__dot agent-tool__dot--${status}`} />
        <span className="agent-steps__text">
          {running
            ? `正在执行第 ${steps.indexOf(running) + 1} 步 · ${
                running.name || "画布操作"
              }`
            : failed
            ? `已完成 ${steps.length} 步，${failed} 步失败`
            : `已完成 ${steps.length} 步`}
        </span>
        <span className="agent-steps__hint">详情</span>
      </summary>
      <div className="agent-steps__list">
        {steps.map((step) => (
          <ToolRow key={step.id} item={step} />
        ))}
      </div>
    </details>
  );
};

const formatTime = (ts?: number) =>
  typeof ts === "number" && Number.isFinite(ts)
    ? new Date(ts).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

const MessageHead = ({
  role,
  ts,
}: {
  role: "user" | "assistant";
  ts?: number;
}) => {
  const time = formatTime(ts);
  return (
    <div className="agent-msg__head">
      <span className={`agent-msg__badge agent-msg__badge--${role}`}>
        {role === "user" ? "你" : "AI"}
      </span>
      <span className="agent-msg__meta">
        {role === "user" ? "你" : "AI 助手"}
        {time ? ` · ${time}` : ""}
      </span>
    </div>
  );
};

type Row =
  | { type: "message"; item: Exclude<ChatItem, { kind: "tool" }> }
  | { type: "steps"; id: string; steps: ToolStep[] };

const buildRows = (items: ChatItem[]): Row[] => {
  const rows: Row[] = [];
  for (const item of items) {
    if (item.kind === "tool") {
      const last = rows[rows.length - 1];
      if (last?.type === "steps") {
        last.steps.push(item);
      } else {
        rows.push({ type: "steps", id: item.id, steps: [item] });
      }
      continue;
    }
    // a turn that carried only tool calls leaves an empty assistant row behind
    if (
      item.kind === "assistant" &&
      !hasVisibleText(item.text) &&
      !item.reasoning?.trim()
    ) {
      continue;
    }
    rows.push({ type: "message", item });
  }
  return rows;
};

const MessageRow = ({
  item,
}: {
  item: Exclude<ChatItem, { kind: "tool" }>;
}) => {
  if (item.kind === "user") {
    return (
      <div className="agent-msg agent-msg--user">
        <MessageHead role="user" ts={item.ts} />
        <div className="agent-msg__content">
          <div className="agent-msg__body">{item.text}</div>
        </div>
      </div>
    );
  }

  if (item.kind === "assistant") {
    const showText = hasVisibleText(item.text);
    return (
      <div className="agent-msg agent-msg--assistant">
        <MessageHead role="assistant" ts={item.ts} />
        <div className="agent-msg__content">
          {item.reasoning ? (
            <details className="agent-reasoning">
              <summary>思考过程</summary>
              <div>{item.reasoning}</div>
            </details>
          ) : null}
          {showText ? <RichText text={item.text} /> : null}
        </div>
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

  const rows = useMemo(() => buildRows(items), [items]);

  const messagesRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
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

  // grow with the text so the send button can stay exactly one line tall
  useEffect(() => {
    const node = inputRef.current;
    if (!node) {
      return;
    }
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 128)}px`;
  }, [draft, open]);

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
          rows.map((row) =>
            row.type === "steps" ? (
              <StepsRow key={row.id} steps={row.steps} />
            ) : (
              <MessageRow key={row.item.id} item={row.item} />
            ),
          )
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
            ref={inputRef}
            value={draft}
            rows={1}
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
