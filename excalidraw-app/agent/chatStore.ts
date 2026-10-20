import { STORAGE_KEYS } from "../app_constants";

import type { ChatMessage } from "./types";

export type ChatItem =
  | { id: string; kind: "user"; text: string }
  | {
      id: string;
      kind: "assistant";
      text: string;
      reasoning?: string;
    }
  | {
      id: string;
      kind: "tool";
      name: string;
      args: string;
      status: "running" | "ok" | "error";
      content?: string;
    }
  | { id: string; kind: "notice" | "error"; text: string };

export type StoredChat = {
  version: 1;
  id: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  items: ChatItem[];
};

const MAX_ITEMS = 200;
const MAX_STORED_CONTENT = 4000;

let itemCounter = 0;

/**
 * Ids have to be unique across reloads too: a restored transcript keeps the ids
 * it was saved with, so a plain counter would collide with them and React would
 * mix up (or drop) the restored rows.
 */
export const nextItemId = () =>
  `item_${Date.now().toString(36)}_${(++itemCounter).toString(36)}`;

const storage = () =>
  typeof window === "undefined" ? null : window.localStorage;

export const createChat = (): StoredChat => ({
  version: 1,
  id: `chat_${Date.now().toString(36)}`,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [],
  items: [],
});

const truncate = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max)}\n…（已截断）` : value;

const shrinkItems = (items: ChatItem[]): ChatItem[] =>
  items.slice(-MAX_ITEMS).map((item) => {
    if (item.kind === "tool" && item.content) {
      return { ...item, content: truncate(item.content, MAX_STORED_CONTENT) };
    }
    return item;
  });

export const loadChat = (): StoredChat => {
  const store = storage();
  if (!store) {
    return createChat();
  }
  try {
    const raw = store.getItem(STORAGE_KEYS.LOCAL_STORAGE_AGENT_CHAT);
    if (!raw) {
      return createChat();
    }
    const parsed = JSON.parse(raw) as StoredChat;
    if (!Array.isArray(parsed?.messages) || !Array.isArray(parsed?.items)) {
      return createChat();
    }
    return {
      ...createChat(),
      ...parsed,
      messages: parsed.messages,
      items: parsed.items,
    };
  } catch {
    return createChat();
  }
};

export const saveChat = (
  chat: Pick<StoredChat, "id" | "createdAt">,
  messages: ChatMessage[],
  items: ChatItem[],
) => {
  const store = storage();
  if (!store) {
    return;
  }
  try {
    const payload: StoredChat = {
      version: 1,
      id: chat.id,
      createdAt: chat.createdAt,
      updatedAt: Date.now(),
      messages,
      items: shrinkItems(items),
    };
    store.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_AGENT_CHAT,
      JSON.stringify(payload),
    );
  } catch {
    // ignore quota errors: the transcript is a convenience, not the canvas
  }
};

export const clearChat = () => {
  const store = storage();
  if (!store) {
    return;
  }
  try {
    store.removeItem(STORAGE_KEYS.LOCAL_STORAGE_AGENT_CHAT);
  } catch {
    // noop
  }
};

const messageLength = (message: ChatMessage) => message.content?.length ?? 0;

/**
 * Cuts the persisted transcript down to the last `maxPairs` user turns (and a
 * rough character budget), always starting on a user message and never leaving
 * orphaned tool messages, which providers reject.
 */
export const trimHistory = (
  messages: ChatMessage[],
  { maxPairs = 10, maxChars = 60_000 } = {},
): ChatMessage[] => {
  let start = 0;
  let users = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") {
      users++;
      if (users > maxPairs) {
        start = index + 1;
        break;
      }
    }
  }

  let budget = 0;
  for (let index = messages.length - 1; index >= start; index--) {
    budget += messageLength(messages[index]);
    if (budget > maxChars) {
      // drop this and every older turn, starting at the next user message
      let cursor = index + 1;
      while (cursor < messages.length && messages[cursor].role !== "user") {
        cursor++;
      }
      if (cursor > start) {
        start = cursor;
      }
      break;
    }
  }

  while (start < messages.length && messages[start].role !== "user") {
    start++;
  }

  return messages.slice(start);
};
