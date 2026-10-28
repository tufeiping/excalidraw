import clsx from "clsx";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useEditorInterface } from "@excalidraw/excalidraw";
import { CloseIcon } from "@excalidraw/excalidraw/components/icons";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import { useI18n } from "@excalidraw/excalidraw/i18n";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  PANEL_DEFAULT_WIDTH,
  clampPanelWidth,
  loadPanelWidth,
  savePanelWidth,
} from "../agent/panelWidth";
import { useAgent } from "../agent/useAgent";
import {
  AI_CONFIG_CHANGED_EVENT,
  describeAiModel,
  isAiConfigured,
} from "../aiConfig";

import "./AgentPanel.scss";

import type { ChatItem, ChatSummary } from "../agent/chatStore";

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

type T = ReturnType<typeof useI18n>["t"];

type ToolStep = Extract<ChatItem, { kind: "tool" }>;

const ToolRow = ({ item, t }: { item: ToolStep; t: T }) => (
  <details className="agent-tool" data-status={item.status}>
    <summary>
      <span
        className={`agent-tool__dot agent-tool__dot--${
          item.status === "running" ? "running" : item.status
        }`}
      />
      <span className="agent-tool__name">
        {item.name || t("agent.toolFallbackName")}
      </span>
      <span className="agent-tool__args">
        {summarizeArgs(item.args) || t("agent.toolFallbackDone")}
      </span>
    </summary>
    {item.content ? <pre>{item.content}</pre> : null}
  </details>
);

/** one collapsed chip per run of tool calls, instead of a stack of rows */
const StepsRow = ({ steps, t }: { steps: ToolStep[]; t: T }) => {
  const running = steps.find((step) => step.status === "running");
  const failed = steps.filter((step) => step.status === "error").length;
  const status = running ? "running" : failed ? "error" : "ok";

  const label = running
    ? t("agent.stepsRunning", {
        index: steps.indexOf(running) + 1,
        name: running.name || t("agent.toolFallbackName"),
      })
    : failed
    ? t("agent.stepsFailed", { count: steps.length, failed })
    : t("agent.stepsDone", { count: steps.length });

  return (
    <details className="agent-steps" data-status={status}>
      <summary>
        <span className={`agent-tool__dot agent-tool__dot--${status}`} />
        <span className="agent-steps__text">{label}</span>
        <span className="agent-steps__hint">{t("agent.stepsDetails")}</span>
      </summary>
      <div className="agent-steps__list">
        {steps.map((step) => (
          <ToolRow key={step.id} item={step} t={t} />
        ))}
      </div>
    </details>
  );
};

const formatTime = (ts: number | undefined, lang: string, withDate = false) => {
  if (typeof ts !== "number" || !Number.isFinite(ts)) {
    return "";
  }
  const date = new Date(ts);
  if (withDate) {
    return date.toLocaleString(lang, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return date.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
};

const MessageHead = ({
  role,
  ts,
  lang,
  t,
}: {
  role: "user" | "assistant";
  ts?: number;
  lang: string;
  t: T;
}) => {
  const time = formatTime(ts, lang);
  return (
    <div className="agent-msg__head">
      <span className={`agent-msg__badge agent-msg__badge--${role}`}>
        {role === "user" ? t("agent.badgeYou") : t("agent.badgeAi")}
      </span>
      <span className="agent-msg__meta">
        {role === "user" ? t("agent.labelYou") : t("agent.title")}
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

/** clipboard.writeText needs a secure context; the fallback also covers http */
const copyText = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the selection-based copy
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
};

const CopyButton = ({ text, t }: { text: string; t: T }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="agent-msg__action"
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }
      }}
    >
      {copied ? t("agent.copied") : t("agent.copy")}
    </button>
  );
};

const MessageRow = ({
  item,
  lang,
  t,
  resendId,
  onResend,
  resendLabel,
  onDelete,
  disabled,
}: {
  item: Exclude<ChatItem, { kind: "tool" }>;
  lang: string;
  t: T;
  /** the user prompt this turn belongs to; absent for prompts older than… */
  resendId: string;
  onResend: (itemId: string) => void;
  resendLabel: string;
  onDelete: (item: Exclude<ChatItem, { kind: "tool" }>) => void;
  disabled: boolean;
}) => {
  const actions = (text: string) => (
    <div className="agent-msg__actions">
      <CopyButton text={text} t={t} />
      {resendId && !disabled ? (
        <button
          type="button"
          className="agent-msg__action"
          onClick={() => onResend(resendId)}
        >
          {resendLabel}
        </button>
      ) : null}
      {!disabled ? (
        <button
          type="button"
          className="agent-msg__action agent-msg__action--danger"
          onClick={() => onDelete(item)}
        >
          {t("agent.delete")}
        </button>
      ) : null}
    </div>
  );
  if (item.kind === "user") {
    return (
      <div className="agent-msg agent-msg--user">
        <MessageHead role="user" ts={item.ts} lang={lang} t={t} />
        <div className="agent-msg__content">
          <div className="agent-msg__body">{item.text}</div>
          {actions(item.text)}
        </div>
      </div>
    );
  }

  if (item.kind === "assistant") {
    const showText = hasVisibleText(item.text);
    return (
      <div className="agent-msg agent-msg--assistant">
        <MessageHead role="assistant" ts={item.ts} lang={lang} t={t} />
        <div className="agent-msg__content">
          {item.reasoning ? (
            <details className="agent-reasoning">
              <summary>{t("agent.reasoning")}</summary>
              <div>{item.reasoning}</div>
            </details>
          ) : null}
          {showText ? <RichText text={item.text} /> : null}
          {showText ? actions(item.text) : null}
        </div>
      </div>
    );
  }

  return (
    <div className={`agent-msg agent-msg--${item.kind}`}>
      <div className="agent-msg__body">{item.text}</div>
      {actions(item.text)}
    </div>
  );
};

const HistoryList = ({
  chats,
  activeChatId,
  lang,
  t,
  onOpen,
  onDelete,
  onBack,
  disabled,
}: {
  chats: ChatSummary[];
  activeChatId: string;
  lang: string;
  t: T;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onBack: () => void;
  disabled: boolean;
}) => {
  // deleting a conversation is irreversible, so it takes a second click
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  useEffect(() => {
    if (pendingDelete && !chats.some((chat) => chat.id === pendingDelete)) {
      setPendingDelete(null);
    }
  }, [chats, pendingDelete]);

  return (
    <div className="agent-panel__history">
      <div className="agent-panel__history-head">
        <span>{t("agent.history")}</span>
        <button type="button" className="agent-panel__button" onClick={onBack}>
          {t("agent.back")}
        </button>
      </div>
      {chats.length === 0 ? (
        <div className="agent-panel__empty">{t("agent.historyEmpty")}</div>
      ) : (
        <ul className="agent-panel__history-list">
          {chats.map((chat) => {
            const confirming = pendingDelete === chat.id;
            return (
              <li
                key={chat.id}
                className="agent-panel__history-item"
                data-active={chat.id === activeChatId || undefined}
                data-confirming={confirming || undefined}
              >
                {confirming ? (
                  <div
                    className="agent-panel__history-confirm"
                    role="alertdialog"
                    aria-label={t("agent.historyDeleteConfirm")}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.stopPropagation();
                        setPendingDelete(null);
                      }
                    }}
                  >
                    <span className="agent-panel__history-confirm-text">
                      {t("agent.historyDeleteConfirm")}
                      <span className="agent-panel__history-confirm-hint">
                        {t("agent.historyDeleteConfirmHint")}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="agent-panel__button agent-panel__button--danger"
                      onClick={() => {
                        setPendingDelete(null);
                        onDelete(chat.id);
                      }}
                    >
                      {t("agent.historyDeleteConfirmYes")}
                    </button>
                    <button
                      type="button"
                      className="agent-panel__button"
                      onClick={() => setPendingDelete(null)}
                      autoFocus
                    >
                      {t("agent.historyDeleteConfirmNo")}
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className="agent-panel__history-open"
                      onClick={() => onOpen(chat.id)}
                      disabled={disabled || chat.id === activeChatId}
                      title={chat.title || t("agent.historyUntitled")}
                    >
                      <span className="agent-panel__history-title">
                        {chat.title || t("agent.historyUntitled")}
                      </span>
                      <span className="agent-panel__history-meta">
                        {formatTime(chat.updatedAt, lang, true)}
                        {" · "}
                        {t("agent.historyItems", { count: chat.itemCount })}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="agent-panel__history-delete"
                      onClick={() => setPendingDelete(chat.id)}
                      disabled={disabled}
                      title={t("agent.historyDelete")}
                      aria-label={t("agent.historyDelete")}
                    >
                      ×
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
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
  const { t, langCode } = useI18n();
  const appState = useUIAppState();
  // phones get a full-screen sheet instead of the docked side panel, which would
  // otherwise sit on top of the canvas it is meant to edit
  const isPhone = useEditorInterface().formFactor === "phone";
  const {
    items,
    status,
    error,
    chats,
    activeChatId,
    send,
    resend,
    removeItem,
    stop,
    newChat,
    openChat,
    removeChat,
    refreshChats,
    dismissError,
  } = useAgent(excalidrawAPI);

  const [draft, setDraft] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  // deleting a message cannot be undone, so it goes through a confirmation
  const [pendingDeleteItem, setPendingDeleteItem] = useState<Exclude<
    ChatItem,
    { kind: "tool" }
  > | null>(null);
  const [panelWidth, setPanelWidth] = useState(loadPanelWidth);
  const [resizing, setResizing] = useState(false);
  const [configured, setConfigured] = useState(() => isAiConfigured());
  const [elementCount, setElementCount] = useState(
    () => excalidrawAPI?.getSceneElements().length ?? 0,
  );

  const rows = useMemo(() => buildRows(items), [items]);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const resizingRef = useRef(false);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  // the prompt each rendered answer belongs to, carried across the row mapping
  const lastPromptRef = useRef<string>("");
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

  const suggestions = useMemo(
    () => [
      t("agent.suggestion1"),
      t("agent.suggestion2"),
      t("agent.suggestion3"),
    ],
    // `t` reads the active language, so rebuild when it changes
    [langCode], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    setElementCount(excalidrawAPI?.getSceneElements().length ?? 0);
  }, [excalidrawAPI, open, items, appState.selectedElementIds]);

  // the key can be added or cleared at any time (settings dialog, another tab)
  useEffect(() => {
    if (!open) {
      return;
    }
    const refresh = () => setConfigured(isAiConfigured());
    refresh();
    const onStorage = (event: StorageEvent) => {
      if (!event.key || /ai-config|api-key|excalidraw-agent/.test(event.key)) {
        refresh();
      }
    };
    const onKeyChanged = () => refresh();
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", refresh);
    window.addEventListener(AI_CONFIG_CHANGED_EVENT, onKeyChanged);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(AI_CONFIG_CHANGED_EVENT, onKeyChanged);
    };
  }, [open, appState.openDialog]);

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

  const persistWidth = useCallback((value: number) => {
    const next = clampPanelWidth(value);
    setPanelWidth(next);
    savePanelWidth(next);
  }, []);

  // dragging the left edge: the panel is anchored to the right, so the width
  // is whatever is left between the pointer and the panel's right border
  const onResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      resizingRef.current = true;
      setResizing(true);
      document.body.classList.add("agent-panel-resizing");
    },
    [],
  );

  const onResizeMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!resizingRef.current) {
        return;
      }
      const right =
        panelRef.current?.getBoundingClientRect().right ??
        window.innerWidth - 8;
      setPanelWidth(clampPanelWidth(right - event.clientX));
    },
    [],
  );

  const endResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!resizingRef.current) {
        return;
      }
      resizingRef.current = false;
      setResizing(false);
      document.body.classList.remove("agent-panel-resizing");
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      persistWidth(panelWidth);
    },
    [panelWidth, persistWidth],
  );

  // keep the width sane when the window shrinks below it
  useEffect(() => {
    const onWindowResize = () =>
      setPanelWidth((width) => clampPanelWidth(width));
    window.addEventListener("resize", onWindowResize);
    return () => {
      window.removeEventListener("resize", onWindowResize);
      document.body.classList.remove("agent-panel-resizing");
    };
  }, []);

  const onScroll = useCallback(() => {
    const node = messagesRef.current;
    if (!node) {
      return;
    }
    stickToBottomRef.current =
      node.scrollHeight - node.scrollTop - node.clientHeight < 80;
  }, []);

  const openSettings = useCallback(() => {
    excalidrawAPI?.updateScene({
      appState: { openDialog: { name: "settings" } },
    });
  }, [excalidrawAPI]);

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
        title={t("agent.title")}
      >
        {t("agent.title")}
      </button>
    );
  }

  return (
    <>
      {/* swallows taps: the mobile sheet is modal, so only its own close button
          (or Escape) dismisses it — a stray canvas tap must not hide it */}
      {isPhone ? <div className="agent-panel__scrim" /> : null}
      <div
        // deliberately not an <aside>: upstream's mobile stylesheet hides every
        // aside (`.excalidraw--mobile.excalidraw aside { display: none }`)
        role="complementary"
        className={clsx("agent-panel", { "agent-panel--mobile": isPhone })}
        aria-label={t("agent.title")}
        ref={panelRef}
        data-resizing={resizing || undefined}
        style={
          { "--agent-panel-width": `${panelWidth}px` } as React.CSSProperties
        }
      >
        {isPhone ? null : (
          <div
            className="agent-panel__resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={t("agent.resizeHint")}
            title={t("agent.resizeHint")}
            tabIndex={0}
            onPointerDown={onResizeStart}
            onPointerMove={onResizeMove}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            onDoubleClick={() => persistWidth(PANEL_DEFAULT_WIDTH)}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                persistWidth(panelWidth + 24);
              } else if (event.key === "ArrowRight") {
                event.preventDefault();
                persistWidth(panelWidth - 24);
              } else if (event.key === "Home" || event.key === "Enter") {
                event.preventDefault();
                persistWidth(PANEL_DEFAULT_WIDTH);
              }
            }}
          />
        )}
        <div className="agent-panel__header">
          <span className="agent-panel__title">{t("agent.title")}</span>
          <span className="agent-panel__status">
            {running
              ? status === "running-tool"
                ? t("agent.statusRunningTool")
                : t("agent.statusThinking")
              : t("agent.statusElements", { count: elementCount })}
          </span>
          <button
            type="button"
            className="agent-panel__button"
            onClick={() => {
              if (!showHistory) {
                refreshChats();
              }
              setShowHistory((previous) => !previous);
            }}
            title={t("agent.history")}
          >
            {t("agent.history")}
          </button>
          <button
            type="button"
            className="agent-panel__button"
            onClick={() => {
              stickToBottomRef.current = true;
              setShowHistory(false);
              newChat();
            }}
            disabled={running}
            title={t("agent.newChat")}
          >
            {t("agent.newChat")}
          </button>
          <button
            type="button"
            className={clsx("agent-panel__button", {
              "agent-panel__close": isPhone,
            })}
            onClick={() => onOpenChange(false)}
            title={isPhone ? t("buttons.close") : t("agent.hide")}
            aria-label={isPhone ? t("buttons.close") : t("agent.hide")}
          >
            {isPhone ? CloseIcon : t("agent.hide")}
          </button>
        </div>

        {!configured && !showHistory ? (
          <div className="agent-panel__setup">
            <div className="agent-panel__setup-head">
              <span className="agent-panel__setup-dot" />
              <span className="agent-panel__setup-title">
                {t("agent.setupTitle")}
              </span>
            </div>
            <div className="agent-panel__setup-body">
              {t("agent.setupBody")}
            </div>
            <div className="agent-panel__setup-foot">
              <span className="agent-panel__setup-meta">
                {t("agent.setupModel", { model: describeAiModel() })}
              </span>
              <button
                type="button"
                className="agent-panel__button agent-panel__button--primary"
                onClick={openSettings}
              >
                {t("agent.openSettings")}
              </button>
            </div>
          </div>
        ) : null}

        {showHistory ? (
          <HistoryList
            chats={chats}
            activeChatId={activeChatId}
            lang={langCode}
            t={t}
            onOpen={(id) => {
              stickToBottomRef.current = true;
              setShowHistory(false);
              openChat(id);
            }}
            onDelete={removeChat}
            onBack={() => setShowHistory(false)}
            disabled={running}
          />
        ) : (
          <div
            className="agent-panel__messages"
            ref={messagesRef}
            onScroll={onScroll}
          >
            {rows.length === 0 ? (
              <div className="agent-panel__empty">
                <div>
                  {t("agent.emptyIntro", { count: elementCount })}
                  {selectedCount > 0
                    ? t("agent.emptySelected", { count: selectedCount })
                    : ""}
                </div>
                <ul>
                  {suggestions.map((suggestion) => (
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
              rows.map((row) => {
                if (row.type === "steps") {
                  return <StepsRow key={row.id} steps={row.steps} t={t} />;
                }
                // every answer belongs to the prompt above it: that is the turn
                // "重新生成" / "重试" has to re-run
                if (row.item.kind === "user") {
                  lastPromptRef.current = row.item.id;
                }
                const promptId = lastPromptRef.current;
                const label =
                  row.item.kind === "user"
                    ? t("agent.resend")
                    : row.item.kind === "assistant"
                    ? t("agent.regenerate")
                    : t("agent.retry");
                return (
                  <MessageRow
                    key={row.item.id}
                    item={row.item}
                    lang={langCode}
                    t={t}
                    resendId={promptId}
                    onResend={(itemId) => {
                      stickToBottomRef.current = true;
                      void resend(itemId);
                    }}
                    resendLabel={label}
                    onDelete={setPendingDeleteItem}
                    disabled={running}
                  />
                );
              })
            )}
            {showIndicator ? (
              <div className="agent-msg agent-msg--notice">
                <div className="agent-msg__body">
                  {status === "running-tool"
                    ? t("agent.statusRunningTool")
                    : t("agent.statusThinking")}
                </div>
              </div>
            ) : null}
          </div>
        )}

        {error ? (
          <div className="agent-panel__hint">
            <span style={{ color: "var(--color-danger)" }}>{error}</span>
            {error === t("agent.errorMissingKey") ||
            /密钥|API key/i.test(error) ? (
              <button
                type="button"
                className="agent-panel__button"
                onClick={() => {
                  dismissError();
                  openSettings();
                }}
              >
                {t("agent.openSettings")}
              </button>
            ) : (
              <button
                type="button"
                className="agent-panel__button"
                onClick={dismissError}
              >
                {t("agent.dismiss")}
              </button>
            )}
          </div>
        ) : null}

        {pendingDeleteItem ? (
          <div
            className="agent-confirm__backdrop"
            role="presentation"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setPendingDeleteItem(null);
              }
            }}
          >
            <div
              className="agent-confirm"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="agent-confirm-title"
            >
              <div className="agent-confirm__title" id="agent-confirm-title">
                {t("agent.deleteTitle")}
              </div>
              <div className="agent-confirm__body">
                {pendingDeleteItem.kind === "user"
                  ? t("agent.deletePromptBody")
                  : t("agent.deleteAnswerBody")}
              </div>
              {pendingDeleteItem.text ? (
                <div className="agent-confirm__quote">
                  {pendingDeleteItem.text.slice(0, 120)}
                  {pendingDeleteItem.text.length > 120 ? "…" : ""}
                </div>
              ) : null}
              <div className="agent-confirm__actions">
                <button
                  type="button"
                  className="agent-panel__button"
                  autoFocus
                  onClick={() => setPendingDeleteItem(null)}
                >
                  {t("agent.cancel")}
                </button>
                <button
                  type="button"
                  className="agent-panel__button agent-panel__button--danger"
                  onClick={() => {
                    removeItem(pendingDeleteItem.id);
                    setPendingDeleteItem(null);
                  }}
                >
                  {t("agent.deleteConfirm")}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <div className="agent-panel__composer">
          <div className="agent-panel__hint">
            <span>
              {selectedCount > 0
                ? t("agent.hintSelection", { count: selectedCount })
                : t("agent.hintEnter")}
            </span>
          </div>
          <div className="agent-panel__input-row">
            <textarea
              className="agent-panel__input"
              ref={inputRef}
              value={draft}
              rows={1}
              placeholder={t("agent.placeholder")}
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
                {t("agent.stop")}
              </button>
            ) : (
              <button
                type="button"
                className="agent-panel__send"
                onClick={submit}
                disabled={!draft.trim()}
              >
                {t("agent.send")}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
};
