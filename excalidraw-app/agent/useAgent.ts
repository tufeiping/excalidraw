import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { clearChat, createChat, loadChat, saveChat } from "./chatStore";
import { runAgent } from "./loop";
import { ToolRegistry } from "./registry";
import { InMemorySelectionStore } from "./selection";
import { canvasTools } from "./tools";
import { loadSnapshot, syncSceneSnapshot } from "./sceneStore";
import { SYSTEM_PROMPT } from "./systemPrompt";

import type { ChatItem } from "./chatStore";
import type {
  AgentSession,
  ChatMessage,
  SceneAccess,
  ToolContext,
} from "./types";

let itemCounter = 0;
const nextItemId = () => `item_${++itemCounter}`;

export type AgentStatus = "idle" | "thinking" | "running-tool";

export const useAgent = (api: ExcalidrawImperativeAPI | null) => {
  const initial = useMemo(() => loadChat(), []);
  const [items, setItems] = useState<ChatItem[]>(initial.items);
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const historyRef = useRef<ChatMessage[]>(initial.messages);
  const chatRef = useRef({ id: initial.id, createdAt: initial.createdAt });
  const itemsRef = useRef<ChatItem[]>(initial.items);
  const assistantRef = useRef<{
    id: string;
    text: string;
    reasoning: string;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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
    saveChat(chatRef.current, historyRef.current, nextItems);
  }, []);

  const commitItems = useCallback(
    (updater: (previous: ChatItem[]) => ChatItem[]) => {
      setItems((previous) => {
        const next = updater(previous);
        itemsRef.current = next;
        return next;
      });
    },
    [],
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
          { id: created.id, kind: "assistant", text: "", reasoning: "" },
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

  const send = useCallback(
    async (rawInput: string) => {
      const input = rawInput.trim();
      if (!api || !input || abortRef.current) {
        return;
      }

      setError(null);
      setStatus("thinking");
      assistantRef.current = null;
      commitItems((previous) => [
        ...previous,
        { id: nextItemId(), kind: "user", text: input },
      ]);

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
                { id: nextItemId(), kind: "notice", text: event.text },
              ]);
              break;
            case "error":
              setError(event.message);
              commitItems((previous) => [
                ...previous,
                { id: nextItemId(), kind: "error", text: event.message },
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
        persist(itemsRef.current);
      }
    },
    [api, appendAssistant, commitItems, persist, registry, scene, selections],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    assistantRef.current = null;
    historyRef.current = [];
    const fresh = createChat();
    chatRef.current = { id: fresh.id, createdAt: fresh.createdAt };
    itemsRef.current = [];
    setItems([]);
    setError(null);
    setStatus("idle");
    clearChat();
  }, []);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return {
    items,
    status,
    error,
    send,
    stop,
    reset,
    dismissError: () => setError(null),
  };
};
