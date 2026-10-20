import { STORAGE_KEYS } from "../app_constants";

import type { ChatMessage } from "./types";

export type ChatItem =
  | { id: string; kind: "user"; text: string; ts?: number }
  | {
      id: string;
      kind: "assistant";
      text: string;
      reasoning?: string;
      ts?: number;
    }
  | {
      id: string;
      kind: "tool";
      name: string;
      args: string;
      status: "running" | "ok" | "error";
      content?: string;
      ts?: number;
    }
  | { id: string; kind: "notice" | "error"; text: string; ts?: number };

export type StoredChat = {
  version: 2;
  id: string;
  /** derived from the first user message; empty until there is one */
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  items: ChatItem[];
};

/** what the history list needs, without loading the whole transcript */
export type ChatSummary = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  itemCount: number;
};

const MAX_ITEMS = 200;
const MAX_STORED_CONTENT = 4000;
const MAX_CHATS = 50;

const storage = () =>
  typeof window === "undefined" ? null : window.localStorage;

let itemCounter = 0;

/**
 * Ids have to be unique across reloads too: a restored transcript keeps the ids
 * it was saved with, so a plain counter would collide with them and React would
 * mix up (or drop) the restored rows.
 */
export const nextItemId = () =>
  `item_${Date.now().toString(36)}_${(++itemCounter).toString(36)}`;

export const createChat = (): StoredChat => ({
  version: 2,
  id: `chat_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 6)}`,
  title: "",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [],
  items: [],
});

const chatKey = (id: string) =>
  `${STORAGE_KEYS.LOCAL_STORAGE_AGENT_CHAT_PREFIX}${id}`;

const truncate = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max)}\n…（已截断）` : value;

const shrinkItems = (items: ChatItem[]): ChatItem[] =>
  items.slice(-MAX_ITEMS).map((item) => {
    if (item.kind === "tool" && item.content) {
      return { ...item, content: truncate(item.content, MAX_STORED_CONTENT) };
    }
    return item;
  });

/** first user message, flattened to one line — used as the history title */
const deriveTitle = (messages: ChatMessage[], items: ChatItem[]) => {
  const firstUser =
    messages.find((message) => message.role === "user") ??
    items.find((item) => item.kind === "user");
  const text =
    firstUser && "content" in firstUser
      ? firstUser.content
      : firstUser && "text" in firstUser
      ? firstUser.text
      : "";
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
};

/**
 * Rebuilds the rendered transcript from the provider messages.
 *
 * Older builds (and interrupted writes) stored the conversation without its
 * tool steps, so a reload showed the assistant texts with the tool calls
 * silently missing. The messages still carry the calls and their results, so
 * the transcript can be reconstructed — better than losing the history.
 */
const itemsFromMessages = (messages: ChatMessage[]): ChatItem[] => {
  const argsById = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls) {
      for (const call of message.toolCalls) {
        argsById.set(call.id, call.arguments ?? "");
      }
    }
  }

  const items: ChatItem[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }
    if (message.role === "tool") {
      items.push({
        id: nextItemId(),
        kind: "tool",
        name: message.name ?? "",
        args: argsById.get(message.toolCallId) ?? "",
        status: "ok",
        content: message.content,
      });
      continue;
    }
    if (message.role === "assistant") {
      items.push({
        id: nextItemId(),
        kind: "assistant",
        text: message.content ?? "",
        reasoning: "",
      });
      continue;
    }
    items.push({ id: nextItemId(), kind: "user", text: message.content });
  }
  return items;
};

/**
 * Restores the transcript, re-deriving the tool steps when the stored items
 * lost them (payload written by an older build, or a write that raced a
 * reload).
 */
const repairItems = (items: ChatItem[], messages: ChatMessage[]) => {
  const storedHasTool = items.some((item) => item.kind === "tool");
  const messagesHaveTool = messages.some((message) => message.role === "tool");
  if (messagesHaveTool && !storedHasTool) {
    return itemsFromMessages(messages);
  }
  return items;
};

const readIndex = (): ChatSummary[] => {
  const store = storage();
  if (!store) {
    return [];
  }
  try {
    const raw = store.getItem(STORAGE_KEYS.LOCAL_STORAGE_AGENT_CHAT_INDEX);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is ChatSummary =>
        !!entry &&
        typeof entry.id === "string" &&
        typeof entry.createdAt === "number",
    );
  } catch {
    return [];
  }
};

const writeIndex = (index: ChatSummary[]) => {
  const store = storage();
  if (!store) {
    return;
  }
  try {
    store.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_AGENT_CHAT_INDEX,
      JSON.stringify(index),
    );
  } catch {
    // quota errors: the transcript is a convenience, not the canvas
  }
};

/**
 * Import the single-conversation transcript written by older builds so the
 * conversation people already had doesn't disappear.
 */
const migrateLegacyChat = () => {
  const store = storage();
  if (!store) {
    return;
  }
  try {
    const raw = store.getItem(STORAGE_KEYS.LOCAL_STORAGE_AGENT_CHAT);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw) as Partial<StoredChat>;
    store.removeItem(STORAGE_KEYS.LOCAL_STORAGE_AGENT_CHAT);
    if (!Array.isArray(parsed?.messages) || !Array.isArray(parsed?.items)) {
      return;
    }
    const chat: StoredChat = {
      version: 2,
      id: `chat_${parsed.id ?? Date.now().toString(36)}`,
      title: parsed.title || deriveTitle(parsed.messages, parsed.items),
      createdAt: parsed.createdAt ?? Date.now(),
      updatedAt: parsed.updatedAt ?? parsed.createdAt ?? Date.now(),
      messages: parsed.messages,
      items: repairItems(parsed.items, parsed.messages),
    };
    persist(chat, chat.messages, chat.items);
  } catch {
    // corrupted legacy payload — nothing to import
  }
};

const ensureMigrated = () => {
  migrateLegacyChat();
};

export const listChats = (): ChatSummary[] => {
  ensureMigrated();
  return readIndex()
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt);
};

const persist = (
  chat: StoredChat,
  messages: ChatMessage[],
  items: ChatItem[],
) => {
  const store = storage();
  if (!store) {
    return chat;
  }
  const shrink = shrinkItems(items);
  const index = readIndex().filter((entry) => entry.id !== chat.id);
  // strictly monotonic so "newest first" stays stable even when two
  // conversations are touched within the same millisecond
  const newest = index.reduce(
    (max, entry) => Math.max(max, entry.updatedAt),
    chat.createdAt,
  );
  const updated: StoredChat = {
    ...chat,
    version: 2,
    title: chat.title || deriveTitle(messages, shrink),
    updatedAt: Math.max(Date.now(), newest + 1),
    messages,
    items: shrink,
  };

  try {
    store.setItem(chatKey(updated.id), JSON.stringify(updated));
  } catch {
    // ignore quota errors
  }

  index.push({
    id: updated.id,
    title: updated.title,
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
    itemCount: shrink.length,
  });
  index.sort((a, b) => b.updatedAt - a.updatedAt);

  // keep storage bounded: drop the oldest conversations, payload included
  for (const stale of index.splice(MAX_CHATS)) {
    try {
      store.removeItem(chatKey(stale.id));
    } catch {
      // noop
    }
  }
  writeIndex(index);
  return updated;
};

export const saveChat = (
  chat: Pick<StoredChat, "id" | "createdAt" | "title">,
  messages: ChatMessage[],
  items: ChatItem[],
) => persist({ ...createChat(), ...chat }, messages, items);

export const getActiveChatId = (): string | null => {
  const store = storage();
  if (!store) {
    return null;
  }
  try {
    return store.getItem(STORAGE_KEYS.LOCAL_STORAGE_AGENT_CHAT_ACTIVE);
  } catch {
    return null;
  }
};

export const setActiveChatId = (id: string | null) => {
  const store = storage();
  if (!store) {
    return;
  }
  try {
    if (id) {
      store.setItem(STORAGE_KEYS.LOCAL_STORAGE_AGENT_CHAT_ACTIVE, id);
    } else {
      store.removeItem(STORAGE_KEYS.LOCAL_STORAGE_AGENT_CHAT_ACTIVE);
    }
  } catch {
    // noop
  }
};

const readChat = (id: string): StoredChat | null => {
  const store = storage();
  if (!store) {
    return null;
  }
  try {
    const raw = store.getItem(chatKey(id));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<StoredChat>;
    if (!Array.isArray(parsed?.messages) || !Array.isArray(parsed?.items)) {
      return null;
    }
    return {
      ...createChat(),
      ...parsed,
      version: 2,
      id,
      title: parsed.title ?? "",
      messages: parsed.messages,
      items: repairItems(parsed.items, parsed.messages),
    } as StoredChat;
  } catch {
    return null;
  }
};

/**
 * Loads `id`, else the last active conversation, else the most recent one, else
 * a brand new empty chat.
 */
export const loadChat = (id?: string): StoredChat => {
  ensureMigrated();

  if (id) {
    const chat = readChat(id);
    if (chat) {
      return chat;
    }
  }

  const active = getActiveChatId();
  if (active && !id) {
    const chat = readChat(active);
    if (chat) {
      return chat;
    }
  }

  const [newest] = listChats();
  if (newest) {
    const chat = readChat(newest.id);
    if (chat) {
      return chat;
    }
  }

  return createChat();
};

export const deleteChat = (id: string) => {
  const store = storage();
  if (!store) {
    return;
  }
  try {
    store.removeItem(chatKey(id));
  } catch {
    // noop
  }
  writeIndex(readIndex().filter((entry) => entry.id !== id));
  if (getActiveChatId() === id) {
    setActiveChatId(null);
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
