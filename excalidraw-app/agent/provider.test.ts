import { AgentRequestError, chatCompletion } from "./provider";

import type { ChatMessage } from "./types";

const sseResponse = (chunks: string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );

const data = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

const delta = (payload: Record<string, unknown>) =>
  data({ choices: [{ delta: payload, finish_reason: null }] });

const history: ChatMessage[] = [{ role: "user", content: "画个流程图" }];

describe("chatCompletion", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    window.localStorage.setItem("excalidraw-oai-api-key", "test-key");
  });

  afterEach(() => {
    window.localStorage.clear();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("streams text and accumulates streamed tool calls", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        delta({ content: "我先看看" }),
        delta({ content: "画布。" }),
        delta({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "read_canvas", arguments: '{"off' },
            },
          ],
        }),
        delta({
          tool_calls: [{ index: 0, function: { arguments: 'set":1}' } }],
        }),
        data({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        "data: [DONE]\n\n",
      ]),
    ) as unknown as typeof fetch;

    const deltas: string[] = [];
    const result = await chatCompletion({
      messages: history,
      tools: [
        {
          name: "read_canvas",
          description: "read",
          parameters: { type: "object", properties: {} },
        },
      ],
      onText: (chunk) => deltas.push(chunk),
    });

    expect(deltas.join("")).toBe("我先看看画布。");
    expect(result.content).toBe("我先看看画布。");
    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "read_canvas", arguments: '{"offset":1}' },
    ]);
    expect(result.finishReason).toBe("tool_calls");

    const [url, init] = (global.fetch as any).mock.calls[0];
    expect(String(url)).toMatch(/\/chat\/completions$/);
    expect(init.headers.Authorization).toBe("Bearer test-key");
    const body = JSON.parse(init.body);
    expect(body.stream).toBe(true);
    expect(body.tool_choice).toBe("auto");
    expect(body.tools[0].function.name).toBe("read_canvas");
  });

  it("serializes tool results and assistant tool calls back to the provider", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        sseResponse([delta({ content: "ok" }), "data: [DONE]\n\n"]),
      ) as unknown as typeof fetch;

    await chatCompletion({
      messages: [
        { role: "user", content: "改颜色" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "read_canvas", arguments: "{}" }],
        },
        {
          role: "tool",
          content: "结果",
          toolCallId: "c1",
          name: "read_canvas",
        },
      ],
    });

    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "read_canvas", arguments: "{}" },
        },
      ],
    });
    expect(body.messages[2]).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "结果",
      name: "read_canvas",
    });
  });

  it("explains missing keys instead of calling the API", async () => {
    window.localStorage.clear();
    global.fetch = vi.fn() as unknown as typeof fetch;

    await expect(chatCompletion({ messages: history })).rejects.toThrow(
      /未配置 API 密钥/,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("maps auth failures to an actionable message", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "bad key" } }), {
        status: 401,
      }),
    ) as unknown as typeof fetch;

    await expect(chatCompletion({ messages: history })).rejects.toThrow(
      /API 密钥无效或无权限/,
    );
  });

  it("reports network failures", async () => {
    global.fetch = vi
      .fn()
      .mockRejectedValue(
        new TypeError("Failed to fetch"),
      ) as unknown as typeof fetch;

    await expect(
      chatCompletion({ messages: history, retries: 0 }),
    ).rejects.toThrow(/无法连接 AI 服务/);
  });

  it("does not retry after tokens were already streamed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        (() => {
          let step = 0;
          return new ReadableStream<Uint8Array>({
            pull(controller) {
              if (step++ === 0) {
                controller.enqueue(
                  new TextEncoder().encode(delta({ content: "半截" })),
                );
                return;
              }
              controller.error(new Error("boom"));
            },
          });
        })(),
        { status: 200 },
      ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      chatCompletion({ messages: history, retries: 3 }),
    ).rejects.toBeInstanceOf(AgentRequestError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
