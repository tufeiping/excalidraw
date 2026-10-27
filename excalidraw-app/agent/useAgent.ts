import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  createChat,
  deleteChat as deleteStoredChat,
  listChats,
  historyFromItems,
  loadChat,
  nextItemId,
  resendCut,
  saveChat,
  setActiveChatId,
} from "./chatStore";
import { runAgent } from "./loop";
import { ToolRegistry } from "./registry";
import { InMemorySelectionStore } from "./selection";
import { canvasTools } from "./tools";
import { loadSnapshot, syncSceneSnapshot } from "./sceneStore";
import { SYSTEM_PROMPT } from "./systemPrompt";

import type { ChatItem, ChatSummary, StoredChat } from "./chatStore";
import type {
  AgentSession,
  ChatMessage,
  SceneAccess,
  ToolContext,
} from "./types";

export type AgentStatus = "idle" | "thinking" | "running-tool";

export const useAgent = (api: ExcalidrawImperativeAPI | null) => {
  const initial = useMemo(() => loadChat(), []);
  const [items, setItems] = useState<ChatItem[]>(initial.items);
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>(() => listChats());
  const [activeChatId, setActiveChatIdState] = useState<string>(initial.id);

  const historyRef = useRef<ChatMessage[]>(initial.messages);
  const chatRef = useRef({
    id: initial.id,
    createdAt: initial.createdAt,
    title: initial.title,
  });
  const activeIdRef = useRef(initial.id);
  const itemsRef = useRef<ChatItem[]>(initial.items);
  const assistantRef = useRef<{
    id: string;
    text: string;
    reasoning: string;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const persistTimerRef = useRef<number | null>(null);

  const registry = useMemo(() => {
    const instance = new ToolRegistry();
    canvasTools.forEach((tool) => instance.register(tool));
    return instance;
  }, []);

  const selections = useMemo(() => new InMemorySelectionStore(), []);
  const sessionRef = useRef<AgentSession>({ expectedRev: null });

  const scene = useMemo<SceneAccess>(
    () => ({
      snapshot: () => loadSnapshot(),
      sync: () => {
        if (!api) {
          return loadSnapshot();
        }
        return syncSceneSnapshot(api);
      },
    }),
    [api],
  );

  const persist = useCallback((nextItems: ChatItem[]) => {
    // never litter the history list with conversations that were never used
    if (!nextItems.length && !historyRef.current.length) {
      return;
    }
    const saved = saveChat(chatRef.current, historyRef.current, nextItems);
    chatRef.current = {
      id: saved.id,
      createdAt: saved.createdAt,
      title: saved.title,
    };
    setActiveChatId(saved.id);
  }, []);

  const refreshChats = useCallback(() => {
    setChats(listChats());
  }, []);

  const clearPersistTimer = useCallback(() => {
    if (persistTimerRef.current != null) {
      window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
  }, []);

  /**
   * Persists the transcript as the run progresses (not just when it finishes),
   * so a reload mid-run keeps the user message, the partial answer and — more
   * importantly — every tool step that already ran.
   */
  const persistSoon = useCallback(() => {
    if (persistTimerRef.current != null) {
      return;
    }
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      persist(itemsRef.current);
    }, 250);
  }, [persist]);

  const flushPersist = useCallback(() => {
    clearPersistTimer();
    persist(itemsRef.current);
    setChats(listChats());
  }, [clearPersistTimer, persist]);

  const commitItems = useCallback(
    (updater: (previous: ChatItem[]) => ChatItem[]) => {
      const next = updater(itemsRef.current);
      itemsRef.current = next;
      setItems(next);
      persistSoon();
    },
    [persistSoon],
  );

  const appendAssistant = useCallback(
    (kind: "text" | "reasoning", delta: string) => {
      let current = assistantRef.current;
      if (!current) {
        current = { id: nextItemId(), text: "", reasoning: "" };
        assistantRef.current = current;
        const created = current;
        commitItems((previous) => [
          ...previous,
          {
            id: created.id,
            kind: "assistant",
            text: "",
            reasoning: "",
            ts: Date.now(),
          },
        ]);
      }
      const active = current;
      if (kind === "text") {
        active.text += delta;
      } else {
        active.reasoning += delta;
      }
      commitItems((previous) =>
        previous.map((item) =>
          item.id === active.id && item.kind === "assistant"
            ? { ...item, text: active.text, reasoning: active.reasoning }
            : item,
        ),
      );
    },
    [commitItems],
  );

  /**
   * Runs one user turn against the current history. `send` appends the prompt
   * first; `resend` has already truncated both transcripts back to it.
   */
  const runTurn = useCallback(
    async (input: string) => {
      if (!api || !input || abortRef.current) {
        return;
      }

      setError(null);
      setStatus("thinking");
      assistantRef.current = null;

      const controller = new AbortController();
      abortRef.current = controller;

      const ctx: ToolContext = {
        api,
        scene,
        selections,
        session: sessionRef.current,
        signal: controller.signal,
      };

      const toolItemIds = new Map<string, string>();

      try {
        syncSceneSnapshot(api);

        for await (const event of runAgent(
          {
            registry,
            ctx,
            systemPrompt: SYSTEM_PROMPT,
          },
          historyRef.current,
          input,
          controller.signal,
        )) {
          switch (event.type) {
            case "text":
              setStatus("thinking");
              appendAssistant("text", event.delta);
              break;
            case "reasoning":
              appendAssistant("reasoning", event.delta);
              break;
            case "tool_call": {
              assistantRef.current = null;
              setStatus("running-tool");
              const itemId = nextItemId();
              toolItemIds.set(event.call.id, itemId);
              commitItems((previous) => [
                ...previous,
                {
                  id: itemId,
                  kind: "tool",
                  name: event.call.name,
                  args: event.call.arguments,
                  status: "running",
                  ts: Date.now(),
                },
              ]);
              break;
            }
            case "tool_result": {
              const itemId = toolItemIds.get(event.call.id);
              if (!itemId) {
                break;
              }
              commitItems((previous) =>
                previous.map((item) =>
                  item.id === itemId && item.kind === "tool"
                    ? {
                        ...item,
                        status: event.result.isError ? "error" : "ok",
                        content: event.result.content,
                      }
                    : item,
                ),
              );
              break;
            }
            case "notice":
              assistantRef.current = null;
              commitItems((previous) => [
                ...previous,
                {
                  id: nextItemId(),
                  kind: "notice",
                  text: event.text,
                  ts: Date.now(),
                },
              ]);
              break;
            case "error":
              setError(event.message);
              commitItems((previous) => [
                ...previous,
                {
                  id: nextItemId(),
                  kind: "error",
                  text: event.message,
                  ts: Date.now(),
                },
              ]);
              break;
          }
        }
      } catch (thrown) {
        const message =
          thrown instanceof Error ? thrown.message : String(thrown);
        setError(message);
        commitItems((previous) => [
          ...previous,
          { id: nextItemId(), kind: "error", text: message },
        ]);
      } finally {
        assistantRef.current = null;
        abortRef.current = null;
        setStatus("idle");
        flushPersist();
      }
    },
    [
      api,
      appendAssistant,
      commitItems,
      flushPersist,
      registry,
      scene,
      selections,
    ],
  );

  const send = useCallback(
    async (rawInput: string) => {
      const input = rawInput.trim();
      if (!api || !input || abortRef.current) {
        return;
      }
      commitItems((previous) => [
        ...previous,
        { id: nextItemId(), kind: "user", text: input, ts: Date.now() },
      ]);
      await runTurn(input);
    },
    [api, commitItems, runTurn],
  );

  /**
   * Re-send a prompt: drop its answer (and everything after it) from both the
   * transcript and the provider history, then run the same turn again. Works
   * for the newest prompt and for any older one, which is what "重发" means.
   */
  const resend = useCallback(
    async (itemId: string) => {
      if (!api || abortRef.current) {
        return;
      }
      const cut = resendCut(itemsRef.current, historyRef.current, itemId);
      if (!cut || !cut.text) {
        return;
      }
      historyRef.current = historyRef.current.slice(0, cut.messageCount);
      assistantRef.current = null;
      commitItems((previous) => previous.slice(0, cut.itemCount));
      await runTurn(cut.text);
    },
    [api, commitItems, runTurn],
  );

  /**
   * Delete a row from the transcript.
   *
   * Deleting a prompt removes its whole turn (the answer means nothing without
   * the question), and the provider history is rebuilt from what is left so a
   * deleted message cannot keep influencing later answers.
   */
  const removeItem = useCallback(
    (itemId: string) => {
      if (abortRef.current) {
        return;
      }
      const items = itemsRef.current;
      const index = items.findIndex((item) => item.id === itemId);
      if (index < 0) {
        return;
      }
      const isPrompt = items[index].kind === "user";
      const next: ChatItem[] = [];
      for (let i = 0; i < items.length; i += 1) {
        if (i === index) {
          continue;
        }
        if (isPrompt && i > index && items[i].kind !== "user") {
          continue;
        }
        next.push(items[i]);
      }
      assistantRef.current = null;
      historyRef.current = historyFromItems(next);
      commitItems(() => next);
      flushPersist();
    },
    [commitItems, flushPersist],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /** swap the panel over to another (or a brand new) conversation */
  const applyChat = useCallback((chat: StoredChat) => {
    abortRef.current?.abort();
    abortRef.current = null;
    assistantRef.current = null;
    historyRef.current = chat.messages;
    chatRef.current = {
      id: chat.id,
      createdAt: chat.createdAt,
      title: chat.title,
    };
    activeIdRef.current = chat.id;
    itemsRef.current = chat.items;
    setItems(chat.items);
    setActiveChatIdState(chat.id);
    setActiveChatId(chat.id);
    setError(null);
    setStatus("idle");
  }, []);

  /** starts a fresh conversation; the current one stays in the history list */
  const newChat = useCallback(() => {
    flushPersist();
    applyChat(createChat());
    setChats(listChats());
  }, [applyChat, flushPersist]);

  const openChat = useCallback(
    (id: string) => {
      if (id === activeIdRef.current) {
        return;
      }
      flushPersist();
      applyChat(loadChat(id));
      setChats(listChats());
    },
    [applyChat, flushPersist],
  );

  const removeChat = useCallback(
    (id: string) => {
      deleteStoredChat(id);
      const remaining = listChats();
      setChats(remaining);
      if (id !== activeIdRef.current) {
        return;
      }
      // the conversation on screen is gone: fall back to the newest one
      applyChat(remaining.length ? loadChat(remaining[0].id) : createChat());
    },
    [applyChat],
  );

  // don't lose the last tool steps if the tab is closed or reloaded
  useEffect(() => {
    const flush = () => flushPersist();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        flushPersist();
      }
    };
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [flushPersist]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      flushPersist();
    };
  }, [flushPersist]);

  return {
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
    dismissError: () => setError(null),
  };
};
