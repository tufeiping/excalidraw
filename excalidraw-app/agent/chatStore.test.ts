import {
  createChat,
  deleteChat,
  getActiveChatId,
  listChats,
  loadChat,
  nextItemId,
  saveChat,
  setActiveChatId,
  trimHistory,
} from "./chatStore";

import type { ChatMessage } from "./types";

const pair = (index: number): ChatMessage[] => [
  { role: "user", content: `问题 ${index}` },
  { role: "assistant", content: `答案 ${index}` },
];

const pairs = (count: number) =>
  Array.from({ length: count }, (_, index) => pair(index + 1)).flat();

describe("trimHistory", () => {
  it("keeps the last 10 user turns by default", () => {
    const trimmed = trimHistory(pairs(12));
    expect(trimmed[0]).toEqual({ role: "user", content: "问题 3" });
    expect(trimmed).toHaveLength(20);
    expect(trimmed.at(-1)).toEqual({ role: "assistant", content: "答案 12" });
  });

  it("honours a custom pair limit", () => {
    const trimmed = trimHistory(pairs(5), { maxPairs: 2 });
    expect(trimmed.map((message) => message.content)).toEqual([
      "问题 4",
      "答案 4",
      "问题 5",
      "答案 5",
    ]);
  });

  it("never starts on an orphaned tool message", () => {
    const history: ChatMessage[] = [
      ...pairs(2),
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read_canvas", arguments: "{}" }],
      },
      { role: "tool", content: "结果", toolCallId: "c1", name: "read_canvas" },
      { role: "assistant", content: "好了" },
      { role: "user", content: "继续" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c2", name: "read_canvas", arguments: "{}" }],
      },
      { role: "tool", content: "结果2", toolCallId: "c2", name: "read_canvas" },
    ];

    const trimmed = trimHistory(history, { maxPairs: 1 });
    expect(trimmed[0].role).toBe("user");
    expect(trimmed[0].content).toBe("继续");
    // the surviving turn keeps its tool exchange, which must stay intact
    expect(trimmed.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
  });

  it("drops old turns when the transcript is too large", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "x".repeat(5000) },
      { role: "assistant", content: "y".repeat(5000) },
      { role: "user", content: "最近的" },
      { role: "assistant", content: "收到" },
    ];

    const trimmed = trimHistory(history, { maxChars: 6000 });
    expect(trimmed[0]).toEqual({ role: "user", content: "最近的" });
  });

  it("leaves short histories untouched", () => {
    const history = pairs(2);
    expect(trimHistory(history)).toEqual(history);
  });
});

describe("chat storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips a conversation", () => {
    const chat = createChat();
    saveChat(
      chat,
      [{ role: "user", content: "在吗" }],
      [{ id: "i1", kind: "user", text: "在吗" }],
    );

    const loaded = loadChat(chat.id);
    expect(loaded.id).toBe(chat.id);
    expect(loaded.messages).toEqual([{ role: "user", content: "在吗" }]);
    expect(loaded.items).toEqual([{ id: "i1", kind: "user", text: "在吗" }]);
  });

  it("derives a title from the first user message", () => {
    const chat = createChat();
    saveChat(
      chat,
      [{ role: "user", content: "把 三个 方框改成\n蓝色主题" }],
      [{ id: "i1", kind: "user", text: "把 三个 方框改成蓝色主题" }],
    );

    expect(listChats()[0].title).toBe("把 三个 方框改成 蓝色主题");
  });

  it("keeps every conversation and lists the newest first", () => {
    const first = createChat();
    saveChat(
      first,
      [{ role: "user", content: "第一个" }],
      [{ id: "i1", kind: "user", text: "第一个" }],
    );
    const second = createChat();
    saveChat(
      second,
      [{ role: "user", content: "第二个" }],
      [{ id: "i2", kind: "user", text: "第二个" }],
    );

    const chats = listChats();
    expect(chats.map((chat) => chat.id)).toEqual([second.id, first.id]);
    // starting a new conversation must not wipe the previous one
    expect(loadChat(first.id).items).toHaveLength(1);
    expect(loadChat(second.id).items).toHaveLength(1);
  });

  it("deletes a conversation from both the list and storage", () => {
    const chat = createChat();
    saveChat(
      chat,
      [{ role: "user", content: "再见" }],
      [{ id: "i1", kind: "user", text: "再见" }],
    );
    setActiveChatId(chat.id);

    deleteChat(chat.id);

    expect(listChats()).toEqual([]);
    expect(getActiveChatId()).toBeNull();
    expect(loadChat(chat.id).items).toEqual([]);
  });

  it("reopens the active conversation on reload", () => {
    const older = createChat();
    saveChat(
      older,
      [{ role: "user", content: "旧的" }],
      [{ id: "i1", kind: "user", text: "旧的" }],
    );
    const newer = createChat();
    saveChat(
      newer,
      [{ role: "user", content: "新的" }],
      [{ id: "i2", kind: "user", text: "新的" }],
    );

    setActiveChatId(older.id);
    expect(loadChat().id).toBe(older.id);

    setActiveChatId(newer.id);
    expect(loadChat().id).toBe(newer.id);
  });

  it("imports the legacy single-conversation transcript", () => {
    window.localStorage.setItem(
      "excalidraw-agent-chat",
      JSON.stringify({
        version: 1,
        id: "chat_old",
        createdAt: 1,
        updatedAt: 2,
        messages: [{ role: "user", content: "迁移我" }],
        items: [{ id: "o1", kind: "user", text: "迁移我" }],
      }),
    );

    const chats = listChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].title).toBe("迁移我");
    expect(loadChat(chats[0].id).items).toEqual([
      { id: "o1", kind: "user", text: "迁移我" },
    ]);
    // the legacy key is consumed once imported
    expect(window.localStorage.getItem("excalidraw-agent-chat")).toBeNull();
  });

  it("truncates huge tool results before persisting", () => {
    const chat = createChat();
    saveChat(
      chat,
      [],
      [
        {
          id: "t1",
          kind: "tool",
          name: "read_canvas",
          args: "{}",
          status: "ok",
          content: "z".repeat(10_000),
        },
      ],
    );

    const [item] = loadChat(chat.id).items;
    expect(item.kind).toBe("tool");
    if (item.kind === "tool") {
      expect(item.content!.length).toBeLessThan(5000);
      expect(item.content).toMatch(/已截断/);
    }
  });

  it("keeps tool steps and never reuses the restored ids", () => {
    const chat = createChat();
    saveChat(
      chat,
      [],
      [
        { id: "a1", kind: "user", text: "改一下" },
        {
          id: "a2",
          kind: "tool",
          name: "read_canvas",
          args: '{"page":1}',
          status: "ok",
          content: "L0: {…}",
        },
        { id: "a3", kind: "assistant", text: "改好了" },
      ],
    );

    const loaded = loadChat(chat.id);
    // the tool step survives a reload, so the transcript doesn't collapse into
    // two adjacent assistant bubbles with nothing in between
    expect(loaded.items.map((item) => item.kind)).toEqual([
      "user",
      "tool",
      "assistant",
    ]);

    const existing = new Set(loaded.items.map((item) => item.id));
    for (let index = 0; index < 5; index++) {
      expect(existing.has(nextItemId())).toBe(false);
    }
  });

  it("rebuilds tool steps a stale transcript never stored", () => {
    // written by a build that only kept user/assistant bubbles
    window.localStorage.setItem(
      "excalidraw-agent-chat",
      JSON.stringify({
        version: 1,
        id: "chat_stale",
        createdAt: 1,
        updatedAt: 2,
        messages: [
          { role: "user", content: "看一下画布" },
          {
            role: "assistant",
            content: "我先看一下。",
            toolCalls: [
              { id: "call_1", name: "read_canvas", arguments: '{"page":1}' },
            ],
          },
          {
            role: "tool",
            content: "L1: {type: rectangle}",
            toolCallId: "call_1",
            name: "read_canvas",
          },
          { role: "assistant", content: "画布上有一个矩形。" },
        ],
        items: [
          { id: "s1", kind: "user", text: "看一下画布" },
          { id: "s2", kind: "assistant", text: "我先看一下。" },
          { id: "s3", kind: "assistant", text: "画布上有一个矩形。" },
        ],
      }),
    );

    const [chat] = listChats();
    const items = loadChat(chat.id).items;
    expect(items.map((item) => item.kind)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);

    const tool = items.find((item) => item.kind === "tool");
    expect(tool).toMatchObject({
      name: "read_canvas",
      args: '{"page":1}',
      content: "L1: {type: rectangle}",
    });
  });

  it("leaves a transcript that already has its tool steps alone", () => {
    const chat = createChat();
    saveChat(
      chat,
      [
        { role: "user", content: "看一下画布" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_1", name: "read_canvas", arguments: '{"page":1}' },
          ],
        },
        {
          role: "tool",
          content: "L1: {…}",
          toolCallId: "call_1",
          name: "read_canvas",
        },
      ],
      [
        { id: "x1", kind: "user", text: "看一下画布" },
        {
          id: "x2",
          kind: "tool",
          name: "read_canvas",
          args: '{"page":1}',
          status: "error",
          content: "L1: {…}",
        },
      ],
    );

    // kept verbatim: same ids, and the original error status survives
    expect(loadChat(chat.id).items).toEqual([
      { id: "x1", kind: "user", text: "看一下画布" },
      {
        id: "x2",
        kind: "tool",
        name: "read_canvas",
        args: '{"page":1}',
        status: "error",
        content: "L1: {…}",
      },
    ]);
  });

  it("recovers from corrupted storage", () => {
    window.localStorage.setItem("excalidraw-agent-chat-index", "{oops");
    window.localStorage.setItem(
      "excalidraw-agent-chat:chat_x",
      "not json either",
    );
    expect(listChats()).toEqual([]);
    expect(loadChat().items).toEqual([]);
  });
});
