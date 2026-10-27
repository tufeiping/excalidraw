import { t } from "@excalidraw/excalidraw/i18n";

import { AI_CONFIG_STORAGE_KEY } from "../aiConfig";

import { invalidateNeSession } from "./neClient";
import { AgentRequestError, chatCompletion } from "./provider";

import type { ChatMessage } from "./types";

const CUSTOM_CONFIG = {
  mode: "custom",
  custom: {
    preset: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    apiKey: "test-key",
  },
  ne: { model: "" },
};

const NE_CONFIG = {
  mode: "ne",
  custom: { preset: "custom", baseUrl: "", model: "", apiKey: "" },
  ne: { model: "" },
};

const useConfig = (config: unknown) =>
  window.localStorage.setItem(AI_CONFIG_STORAGE_KEY, JSON.stringify(config));

const sessionPayload = {
  ok: true,
  user: { sub: "u_1", name: "涂飞平" },
  models: ["qwen3.5"],
  defaultModel: "qwen3.5",
  csrfToken: "csrf-1",
};

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
    useConfig(CUSTOM_CONFIG);
    invalidateNeSession();
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
    useConfig({
      ...CUSTOM_CONFIG,
      custom: { ...CUSTOM_CONFIG.custom, apiKey: "" },
    });
    global.fetch = vi.fn() as unknown as typeof fetch;

    await expect(chatCompletion({ messages: history })).rejects.toThrow(
      t("agent.errorMissingKey"),
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
      t("agent.errorUnauthorized"),
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
    ).rejects.toThrow(t("agent.errorConnect", { detail: "" }).slice(0, 12));
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

  it("routes to the deployment relay with a CSRF token and no key", async () => {
    useConfig(NE_CONFIG);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(sessionPayload), { status: 200 }),
      )
      .mockResolvedValueOnce(
        sseResponse([delta({ content: "好的" }), "data: [DONE]\n\n"]),
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await chatCompletion({ messages: history });

    expect(result.content).toBe("好的");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [sessionUrl] = fetchMock.mock.calls[0];
    expect(String(sessionUrl)).toBe("/api/llm/session");

    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toBe("/api/llm/v1/chat/completions");
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.headers["X-CSRF-Token"]).toBe("csrf-1");
    expect(JSON.parse(init.body).model).toBe("qwen3.5");
  });

  it("pins the model the user picked for the relay", async () => {
    useConfig({ ...NE_CONFIG, ne: { model: "ne-scientific" } });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(sessionPayload), { status: 200 }),
      )
      .mockResolvedValueOnce(
        sseResponse([delta({ content: "ok" }), "data: [DONE]\n\n"]),
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    await chatCompletion({ messages: history });

    expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe(
      "ne-scientific",
    );
  });

  it("tells the user to sign in when the relay has no session", async () => {
    useConfig(NE_CONFIG);
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, reason: "not_logged_in" }), {
        status: 401,
      }),
    ) as unknown as typeof fetch;

    await expect(chatCompletion({ messages: history })).rejects.toThrow(
      t("agent.errorNeNotLoggedIn"),
    );
  });

  it("refuses to call anything when the assistant is switched off", async () => {
    useConfig({ ...NE_CONFIG, mode: "off" });
    global.fetch = vi.fn() as unknown as typeof fetch;

    await expect(chatCompletion({ messages: history })).rejects.toThrow(
      t("agent.errorDisabled"),
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("retries once with a fresh relay session when the cached one expired", async () => {
    useConfig(NE_CONFIG);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(sessionPayload), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(sessionPayload), { status: 200 }),
      )
      .mockResolvedValueOnce(
        sseResponse([delta({ content: "重连成功" }), "data: [DONE]\n\n"]),
      );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await chatCompletion({ messages: history });

    expect(result.content).toBe("重连成功");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
