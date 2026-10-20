import { parseSSEStream } from "@excalidraw/excalidraw";
import { RequestError } from "@excalidraw/excalidraw/errors";

import type {
  LLMMessage,
  TTTDDialog,
} from "@excalidraw/excalidraw/components/TTDDialog/types";

import { getAiApiKey, getAiBackendUrl, getAiModel } from "../runtimeEnv";

/**
 * The upstream TTD dialog streams a Mermaid definition and renders it. When we
 * talk to an OpenAI-compatible endpoint (DeepSeek, or any self-hosted gateway)
 * we have to supply the "you are a Mermaid generator" instructions ourselves,
 * as the upstream excalidraw AI service does that server-side.
 */
const SYSTEM_PROMPT = [
  "You are a Mermaid diagram generator.",
  "Reply with the Mermaid definition only: no code fences, no explanations,",
  "no comments and no prose outside of the definition.",
].join(" ");

const MERMAID_FENCE_RE = /```(?:mermaid)?\s*([\s\S]*?)\s*```/;

export const extractMermaidContent = (response: string): string => {
  const match = response.match(MERMAID_FENCE_RE);
  return (match ? match[1] : response).trim();
};

/**
 * Strips the surrounding ```mermaid fence from a *stream*, so the chat message
 * (and the live Mermaid preview, which re-parses every chunk) never sees fence
 * markers. It holds back up to 3 characters because a fence may be split
 * across chunks, which is why `flush()` must be called at the end of the
 * stream.
 */
export class MermaidStreamFilter {
  private initialized = false;
  private buffer = "";

  push(delta: string): string {
    this.buffer += delta;

    if (!this.initialized) {
      const trimmed = this.buffer.replace(/^\s+/, "");
      const probe = trimmed.slice(0, 3);

      // could still become "```", keep buffering
      if (probe.length < 3 && "```".startsWith(probe)) {
        return "";
      }

      if (probe === "```") {
        const newlineIndex = trimmed.indexOf("\n");
        // wait for the language line to complete
        if (newlineIndex === -1) {
          return "";
        }
        this.buffer = trimmed.slice(newlineIndex + 1);
      } else {
        this.buffer = trimmed;
      }

      this.initialized = true;
    }

    // keep the last 3 chars in case they are the start of the closing fence
    const safeLength = this.buffer.length - 3;
    if (safeLength <= 0) {
      return "";
    }

    let emit = this.buffer.slice(0, safeLength);
    this.buffer = this.buffer.slice(safeLength);

    // also hold back trailing whitespace / backticks: they may be the beginning
    // of the closing fence, and emitting them would leave trailing blank lines
    // in the chat message once the fence is stripped
    const trailing = emit.match(/[\s`]+$/);
    if (trailing) {
      this.buffer = trailing[0] + this.buffer;
      emit = emit.slice(0, trailing.index);
    }

    return emit;
  }

  flush(): string {
    const rest = this.buffer
      // drop a closing fence together with its surrounding whitespace
      .replace(/\s*`{1,3}\s*$/, "")
      .replace(/^\s+/, "")
      .trimEnd();
    this.buffer = "";
    return rest;
  }
}

type ChatCompletionChunk = {
  choices?: {
    delta?: { content?: string };
    finish_reason?: string | null;
  }[];
  error?: { message?: string };
};

const toRequestError = (message: string, status = 500) =>
  new RequestError({ message, status });

/**
 * Streams a Mermaid definition from an OpenAI-compatible chat completions
 * endpoint, using the user's own API key (set in AI settings or via runtime
 * config), and adapting the OpenAI SSE payloads to the shape the TTD dialog
 * expects.
 */
export const streamTextToDiagram = async ({
  messages,
  onChunk,
  onStreamCreated,
  signal,
}: TTTDDialog.OnTextSubmitProps): Promise<TTTDDialog.OnTextSubmitRetValue> => {
  const apiKey = getAiApiKey();

  if (!apiKey) {
    return {
      error: toRequestError(
        "未配置 API 密钥，请先在「AI 设置」中填写（或由部署方通过运行时配置注入）",
        401,
      ),
    };
  }

  const url = `${getAiBackendUrl()}/chat/completions`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: getAiModel(),
        stream: true,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...(messages as LLMMessage[]),
        ],
      }),
      signal,
    });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      return { error: toRequestError("Request aborted", 499) };
    }
    return {
      error: toRequestError(
        error?.message || "AI 服务请求失败，请检查网络连接",
        500,
      ),
    };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = text;
    try {
      message = JSON.parse(text)?.error?.message || text;
    } catch {
      // response body wasn't JSON, keep the raw text
    }
    return {
      error: toRequestError(
        message || `AI 服务返回错误 (${response.status})`,
        response.status,
      ),
    };
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return { error: toRequestError("AI 服务响应无效", 500) };
  }

  onStreamCreated?.();

  const filter = new MermaidStreamFilter();
  let raw = "";

  try {
    for await (const data of parseSSEStream(reader)) {
      if (data === "[DONE]") {
        break;
      }

      let chunk: ChatCompletionChunk | null = null;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }

      if (!chunk) {
        continue;
      }

      if (chunk.error?.message) {
        return { error: toRequestError(chunk.error.message, 500) };
      }

      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        raw += delta;
        const clean = filter.push(delta);
        if (clean) {
          onChunk?.(clean);
        }
      }
    }
  } catch (error: any) {
    if (error?.name === "AbortError") {
      return { error: toRequestError("Request aborted", 499) };
    }
    return {
      error: toRequestError(error?.message || "AI 流式响应中断", 500),
    };
  }

  const tail = filter.flush();
  if (tail) {
    onChunk?.(tail);
  }

  const generatedResponse = extractMermaidContent(raw);

  if (!generatedResponse) {
    return {
      error: toRequestError("AI 未返回图表内容，请调整提示词后重试", 500),
    };
  }

  return { generatedResponse, error: null };
};
