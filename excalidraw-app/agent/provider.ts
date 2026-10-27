import { parseSSEStream } from "@excalidraw/excalidraw";

import { t } from "@excalidraw/excalidraw/i18n";

import { getAiMode, normalizeBaseUrl, readAiConfig } from "../aiConfig";

import { AgentRequestError } from "./errors";
import { invalidateNeSession, resolveNeTarget } from "./neClient";

import type { ChatMessage, ChatResult, ToolCall, ToolDef } from "./types";

export { AgentRequestError };

/**
 * Each relay refusal needs different advice: "sign in" is useless when the
 * account is signed in but was never linked to NE, and vice versa.
 */
const neFailureMessage = (reason: string): string => {
  if (reason === "ne_not_linked") {
    return t("agent.errorNeNotLinked");
  }
  if (reason === "reauth_required") {
    return t("agent.errorNeReauth");
  }
  if (reason === "no_llm_access" || reason === "ne_credential_rejected") {
    return t("agent.errorNeNoAccess");
  }
  if (reason === "token_store_unavailable") {
    return t("agent.errorNeTokenStore");
  }
  return t("agent.errorNeNotLoggedIn");
};

type WireToolCall = {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

type StreamChunk = {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: WireToolCall[];
    };
    finish_reason?: string | null;
  }[];
  error?: { message?: string } | string;
};

const toWireMessages = (messages: ChatMessage[]) =>
  messages.map((message) => {
    switch (message.role) {
      case "assistant": {
        const wire: Record<string, unknown> = {
          role: "assistant",
          // providers reject `null` content on assistant messages that only
          // carry tool calls
          content: message.content ?? "",
        };
        if (message.toolCalls?.length) {
          wire.tool_calls = message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments || "{}" },
          }));
        }
        return wire;
      }
      case "tool":
        return {
          role: "tool",
          tool_call_id: message.toolCallId,
          content: message.content,
          ...(message.name ? { name: message.name } : {}),
        };
      default:
        return { role: message.role, content: message.content };
    }
  });

const toWireTools = (tools: ToolDef[]) =>
  tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));

const errorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : t("agent.errorUnknownDetail");
};

/**
 * A 404 from the router is an HTML error page. Showing that page inside the
 * chat bubble ("请求失败（404）— <!DOCTYPE html>…") tells the user nothing and
 * hides the one useful line in it, so pull out the text and drop the markup.
 */
const textFromHtml = (body: string) => {
  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(body);
  if (pre) return pre[1].replace(/<[^>]+>/g, "").trim();
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  return title ? title[1].replace(/<[^>]+>/g, "").trim() : "";
};

const describeHttpError = (status: number, body: string) => {
  const looksLikeHtml = /^\s*<(?:!doctype|html)/i.test(body);
  let message = looksLikeHtml ? textFromHtml(body) : body;
  try {
    const parsed = JSON.parse(body);
    message =
      parsed?.error?.message ??
      parsed?.message ??
      (typeof parsed?.error === "string" ? parsed.error : body);
  } catch {
    // body was not JSON, keep the text (or the extracted HTML text)
  }

  if (status === 404 && (!message || looksLikeHtml)) {
    return new AgentRequestError(t("agent.errorNotFound"), status);
  }

  const detail = message ? ` — ${message}` : "";

  if (status === 401 || status === 403) {
    return new AgentRequestError(t("agent.errorUnauthorized"), status);
  }
  if (status === 402) {
    return new AgentRequestError(t("agent.errorBalance"), status);
  }
  if (status === 429) {
    return new AgentRequestError(t("agent.errorRateLimit"), status);
  }
  if (status >= 500) {
    return new AgentRequestError(
      t("agent.errorServer", { status, detail }),
      status,
    );
  }
  return new AgentRequestError(
    t("agent.errorUnknown", { status, detail }),
    status,
  );
};

export type ChatRequest = {
  messages: ChatMessage[];
  tools?: ToolDef[];
  signal?: AbortSignal;
  /** streamed assistant text */
  onText?: (delta: string) => void;
  /** streamed reasoning text (DeepSeek reasoner and friends) */
  onReasoning?: (delta: string) => void;
  temperature?: number;
  /** retries for transport/5xx failures before any token was emitted */
  retries?: number;
};

/**
 * Calls an OpenAI-compatible `/chat/completions` endpoint directly from the
 * browser (DeepSeek by default), streaming text and accumulating streamed tool
 * calls. The agent loop owns the ReAct iterations; this function performs
 * exactly one request.
 */
export const chatCompletion = async ({
  messages,
  tools,
  signal,
  onText,
  onReasoning,
  temperature,
  retries = 1,
}: ChatRequest): Promise<ChatResult> => {
  const mode = getAiMode();
  if (mode === "off") {
    throw new AgentRequestError(t("agent.errorDisabled"), 400);
  }

  let target = await resolveTarget(mode);

  for (let attempt = 0; ; attempt++) {
    let emitted = false;
    try {
      return await requestOnce({
        url: target.url,
        headers: target.headers,
        model: target.model,
        messages,
        tools,
        signal,
        temperature,
        onText: (delta) => {
          emitted = true;
          onText?.(delta);
        },
        onReasoning: (delta) => {
          emitted = true;
          onReasoning?.(delta);
        },
      });
    } catch (error) {
      // The relay answers 401 when the FlyLaTeX session died mid-flight. Drop
      // the cached probe and try once more before bothering the user.
      if (
        mode === "ne" &&
        error instanceof AgentRequestError &&
        error.status === 401 &&
        attempt === 0
      ) {
        invalidateNeSession();
        target = await resolveTarget(mode);
        continue;
      }
      const retryable =
        !signal?.aborted &&
        !emitted &&
        attempt < retries &&
        (error instanceof AgentRequestError
          ? !error.status || error.status === 429 || error.status >= 500
          : true);
      if (!retryable) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
};

type AiTarget = {
  url: string;
  headers: Record<string, string>;
  model: string;
};

/**
 * Resolves "who answers this request" from the stored config:
 * the deployment relay (session cookie, nothing secret in the browser) or a
 * user-supplied OpenAI-compatible endpoint with the user's own key.
 */
const resolveTarget = async (
  mode: ReturnType<typeof getAiMode>,
): Promise<AiTarget> => {
  if (mode === "ne") {
    const config = readAiConfig();
    const target = await resolveNeTarget(config.ne.model, neFailureMessage);
    return {
      url: target.url,
      headers: target.headers,
      model: target.model || config.ne.model,
    };
  }

  const { custom } = readAiConfig();
  const apiKey = custom.apiKey.trim();
  if (!apiKey) {
    throw new AgentRequestError(t("agent.errorMissingKey"), 401);
  }
  const baseUrl = normalizeBaseUrl(custom.baseUrl);
  if (!baseUrl) {
    throw new AgentRequestError(t("agent.errorMissingBaseUrl"), 400);
  }
  const model = custom.model.trim();
  if (!model) {
    throw new AgentRequestError(t("agent.errorMissingModel"), 400);
  }
  return {
    url: `${baseUrl}/chat/completions`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    model,
  };
};

type RequestOnceOptions = {
  url: string;
  headers: Record<string, string>;
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  signal?: AbortSignal;
  temperature?: number;
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
};

const requestOnce = async ({
  url,
  headers,
  model,
  messages,
  tools,
  signal,
  temperature,
  onText,
  onReasoning,
}: RequestOnceOptions): Promise<ChatResult> => {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        ...headers,
      },
      credentials: "same-origin",
      body: JSON.stringify({
        model,
        stream: true,
        messages: toWireMessages(messages),
        ...(tools?.length
          ? { tools: toWireTools(tools), tool_choice: "auto" }
          : {}),
        ...(temperature != null ? { temperature } : {}),
      }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw new AgentRequestError(t("agent.errorAborted"), 499);
    }
    throw new AgentRequestError(
      t("agent.errorConnect", { detail: errorMessage(error) }),
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw describeHttpError(response.status, body);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new AgentRequestError(t("agent.errorEmptyResponse"));
  }

  let content = "";
  let reasoning = "";
  let finishReason: string | undefined;
  const calls = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  let callIndex = 0;

  try {
    for await (const data of parseSSEStream(reader)) {
      if (data === "[DONE]") {
        break;
      }

      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }

      if (chunk.error) {
        const message =
          typeof chunk.error === "string"
            ? chunk.error
            : chunk.error.message ?? t("agent.errorProvider");
        throw new AgentRequestError(message, 500);
      }

      const choice = chunk.choices?.[0];
      if (!choice) {
        continue;
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      const delta = choice.delta;
      if (!delta) {
        continue;
      }

      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        onReasoning?.(delta.reasoning_content);
      }

      if (delta.content) {
        content += delta.content;
        onText?.(delta.content);
      }

      for (const [position, wireCall] of (delta.tool_calls ?? []).entries()) {
        const key = wireCall.index ?? position;
        const current = calls.get(key) ?? { id: "", name: "", arguments: "" };
        if (wireCall.id) {
          current.id = wireCall.id;
        }
        if (wireCall.function?.name) {
          current.name = wireCall.function.name;
        }
        if (wireCall.function?.arguments) {
          current.arguments += wireCall.function.arguments;
        }
        calls.set(key, current);
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      throw new AgentRequestError(t("agent.errorAborted"), 499);
    }
    if (error instanceof AgentRequestError) {
      throw error;
    }
    throw new AgentRequestError(
      t("agent.errorStreamInterrupted", { detail: errorMessage(error) }),
    );
  }

  const toolCalls: ToolCall[] = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => ({
      id: call.id || `call_${callIndex++}_${Date.now()}`,
      name: call.name,
      arguments: call.arguments,
    }))
    .filter((call) => !!call.name);

  return {
    content,
    toolCalls,
    finishReason,
    ...(reasoning ? { reasoning } : {}),
  };
};
