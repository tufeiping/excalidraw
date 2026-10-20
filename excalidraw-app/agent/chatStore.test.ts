import {
  clearChat,
  createChat,
  loadChat,
  saveChat,
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

    const loaded = loadChat();
    expect(loaded.id).toBe(chat.id);
    expect(loaded.messages).toEqual([{ role: "user", content: "在吗" }]);
    expect(loaded.items).toEqual([{ id: "i1", kind: "user", text: "在吗" }]);
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

    const [item] = loadChat().items;
    expect(item.kind).toBe("tool");
    if (item.kind === "tool") {
      expect(item.content!.length).toBeLessThan(5000);
      expect(item.content).toMatch(/已截断/);
    }
  });

  it("recovers from corrupted storage", () => {
    window.localStorage.setItem("excalidraw-agent-chat", "{oops");
    expect(loadChat().items).toEqual([]);
  });

  it("clears the stored conversation", () => {
    saveChat(createChat(), [{ role: "user", content: "hi" }], []);
    clearChat();
    expect(loadChat().messages).toEqual([]);
  });
});
