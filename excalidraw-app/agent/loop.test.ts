import { AsyncChannel } from "./channel";
import { runAgent } from "./loop";
import { ToolRegistry } from "./registry";

import type { AgentEvent, ChatMessage, ChatResult } from "./types";

const responses: (ChatResult | Error)[] = [];

vi.mock("./provider", () => ({
  AgentRequestError: class AgentRequestError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.status = status;
    }
  },
  chatCompletion: vi.fn(async () => {
    const next = responses.shift();
    if (!next) {
      throw new Error("no more mocked responses");
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }),
}));

const createRegistry = (
  run: () =>
    | Promise<{ content: string; isError?: boolean }>
    | { content: string },
) => {
  const registry = new ToolRegistry();
  registry.register({
    name: "read_canvas",
    description: "stub",
    parameters: { type: "object", properties: {} },
    run,
  });
  return registry;
};

const call = (id: string, name = "read_canvas", args = "{}") => ({
  id,
  name,
  arguments: args,
});

const collect = async (generator: AsyncGenerator<AgentEvent>) => {
  const events: AgentEvent[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
};

const runTurn = (
  registry: ToolRegistry,
  history: ChatMessage[] = [],
  options: Partial<Parameters<typeof runAgent>[0]> = {},
) =>
  runAgent(
    {
      registry,
      ctx: {} as any,
      systemPrompt: "sys",
      ...options,
    },
    history,
    "把背景改成蓝色",
    new AbortController().signal,
  );

describe("agent loop", () => {
  beforeEach(() => {
    responses.length = 0;
    window.localStorage.clear();
  });

  it("runs a tool and answers with the result", async () => {
    responses.push(
      { content: "", toolCalls: [call("c1")] },
      { content: "已经改好了", toolCalls: [] },
    );

    const history: ChatMessage[] = [];
    const events = await collect(
      runTurn(
        createRegistry(() => ({ content: "画布 1 行" })),
        history,
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "tool_call",
      "tool_result",
      "text",
    ]);
    expect(history.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(history[1]).toMatchObject({ toolCalls: [call("c1")] });
    expect(history[2]).toMatchObject({
      role: "tool",
      toolCallId: "c1",
      content: "画布 1 行",
    });
  });

  it("passes the system prompt and the trimmed history to the provider", async () => {
    const { chatCompletion } = await import("./provider");
    responses.push({ content: "ok", toolCalls: [] });

    const history: ChatMessage[] = [{ role: "user", content: "上一轮" }];
    await collect(
      runTurn(
        createRegistry(() => ({ content: "" })),
        history,
      ),
    );

    const [request] = (chatCompletion as any).mock.calls.at(-1);
    expect(request.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(request.messages.at(-1)).toEqual({
      role: "user",
      content: "把背景改成蓝色",
    });
  });

  it("sends at most the last 10 turns to the provider", async () => {
    const { chatCompletion } = await import("./provider");
    responses.push({ content: "ok", toolCalls: [] });

    const history: ChatMessage[] = Array.from({ length: 14 }, (_, index) => [
      { role: "user" as const, content: `问题 ${index + 1}` },
      { role: "assistant" as const, content: `答案 ${index + 1}` },
    ]).flat();

    await collect(
      runTurn(
        createRegistry(() => ({ content: "" })),
        history,
      ),
    );

    const [request] = (chatCompletion as any).mock.calls.at(-1);
    // system prompt + the current turn + 9 previous turns
    expect(request.messages).toHaveLength(20);
    expect(request.messages[1]).toEqual({ role: "user", content: "问题 6" });
    expect(request.messages.at(-1)).toEqual({
      role: "user",
      content: "把背景改成蓝色",
    });
  });

  it("stops retrying a call that keeps failing", async () => {
    responses.push(
      { content: "", toolCalls: [call("c1")] },
      { content: "", toolCalls: [call("c2")] },
      { content: "", toolCalls: [call("c3")] },
      { content: "放弃", toolCalls: [] },
    );

    const history: ChatMessage[] = [];
    const events = await collect(
      runTurn(
        createRegistry(() => ({ content: "坏了", isError: true })),
        history,
        { sameToolFailLimit: 1 },
      ),
    );

    const toolResults = events.filter(
      (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
        event.type === "tool_result",
    );
    expect(toolResults).toHaveLength(3);
    expect(toolResults[2].result.content).toMatch(/先不要重复同样的调用/);
  });

  it("pads the remaining tool calls when it aborts mid batch", async () => {
    responses.push({
      content: "",
      toolCalls: [call("c1"), call("c2")],
    });

    const history: ChatMessage[] = [];
    await collect(
      runTurn(
        createRegistry(() => ({ content: "又坏了", isError: true })),
        history,
        { maxFailedCalls: 1 },
      ),
    );

    expect(history.filter((message) => message.role === "tool")).toHaveLength(
      2,
    );
    expect(history.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: "c2",
    });
  });

  it("caps iterations", async () => {
    for (let index = 0; index < 3; index++) {
      responses.push({ content: "", toolCalls: [call(`c${index}`)] });
    }

    const events = await collect(
      runTurn(
        createRegistry(() => ({ content: "ok" })),
        [],
        {
          maxIterations: 2,
        },
      ),
    );

    expect(
      events.some(
        (event) => event.type === "notice" && /最大步数/.test(event.text),
      ),
    ).toBe(true);
  });

  it("surfaces provider failures as an error event", async () => {
    responses.push(new Error("网络断了"));
    const events = await collect(
      runTurn(createRegistry(() => ({ content: "" }))),
    );
    expect(events).toEqual([{ type: "error", message: "网络断了" }]);
  });

  it("reports unknown tools without crashing", async () => {
    responses.push(
      { content: "", toolCalls: [call("c1", "write_canvas")] },
      { content: "好", toolCalls: [] },
    );

    const history: ChatMessage[] = [];
    const events = await collect(
      runTurn(
        createRegistry(() => ({ content: "" })),
        history,
      ),
    );

    const toolResult = events.find((event) => event.type === "tool_result");
    expect(toolResult).toMatchObject({
      result: { isError: true },
    });
    expect(history[2]).toMatchObject({ role: "tool" });
  });
});

describe("AsyncChannel", () => {
  it("drains pushed values and closes", async () => {
    const channel = new AsyncChannel<number>();
    const received: number[] = [];
    const consumer = (async () => {
      for await (const value of channel.drain()) {
        received.push(value);
      }
    })();

    channel.push(1);
    channel.push(2);
    channel.close();
    await consumer;

    expect(received).toEqual([1, 2]);
  });
});
