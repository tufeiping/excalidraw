import { t } from "@excalidraw/excalidraw/i18n";

import { trimHistory } from "./chatStore";
import { AsyncChannel } from "./channel";
import { chatCompletion, AgentRequestError } from "./provider";

import type { ToolRegistry } from "./registry";
import type {
  AgentEvent,
  ChatMessage,
  ChatResult,
  ToolCall,
  ToolContext,
  ToolResult,
} from "./types";

export type RunAgentOptions = {
  registry: ToolRegistry;
  ctx: ToolContext;
  /** system prompt describing the canvas model and the tool workflow */
  systemPrompt: string;
  /** hard cap on ReAct iterations for a single user turn */
  maxIterations?: number;
  /** cap on a single tool result, in characters */
  toolResultCap?: number;
  /** stop the turn after this many failed tool calls */
  maxFailedCalls?: number;
  /** stop retrying the same failing call */
  sameToolFailLimit?: number;
  temperature?: number;
};

const DEFAULTS = {
  maxIterations: 16,
  toolResultCap: 12_000,
  maxFailedCalls: 6,
  sameToolFailLimit: 2,
};

const capContent = (content: string, cap: number) => {
  if (content.length <= cap) {
    return content;
  }
  const omitted = content.length - cap;
  return `${content.slice(0, cap)}\n…（已截断 ${omitted} 个字符）`;
};

const callSignature = (call: ToolCall) => `${call.name}:${call.arguments}`;

/**
 * Runs one user turn: streams the model response, executes the requested tools,
 * feeds the results back and repeats until the model stops calling tools or a
 * guard rail trips.
 *
 * `history` is mutated in place (the caller owns persistence): it ends with the
 * user message, the assistant/tool exchanges, and finally the assistant's answer.
 * When the consumer stops early, the remaining tool calls are padded with error
 * results so the history can still be replayed to the provider.
 */
export async function* runAgent(
  options: RunAgentOptions,
  history: ChatMessage[],
  input: string,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const {
    registry,
    ctx,
    systemPrompt,
    maxIterations = DEFAULTS.maxIterations,
    toolResultCap = DEFAULTS.toolResultCap,
    maxFailedCalls = DEFAULTS.maxFailedCalls,
    sameToolFailLimit = DEFAULTS.sameToolFailLimit,
    temperature,
  } = options;

  history.push({ role: "user", content: input });

  const failCounts = new Map<string, number>();
  let failedCalls = 0;
  let iteration = 0;
  let stopped = false;

  /** keeps the transcript valid when we bail out mid tool-call batch */
  const padPendingCalls = (calls: ToolCall[], reason: string) => {
    for (const call of calls) {
      history.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: reason,
      });
    }
  };

  while (iteration < maxIterations) {
    if (signal.aborted) {
      yield { type: "notice", text: t("agent.noticeStopped") };
      return;
    }
    iteration++;

    const channel = new AsyncChannel<AgentEvent>();
    let result: ChatResult | null = null;
    let failure: unknown = null;

    void chatCompletion({
      // only the last few turns go over the wire; the full transcript stays
      // in localStorage for the UI
      messages: [
        { role: "system", content: systemPrompt },
        ...trimHistory(history),
      ],
      tools: registry.defs(),
      signal,
      temperature,
      onText: (delta) => channel.push({ type: "text", delta }),
      onReasoning: (delta) => channel.push({ type: "reasoning", delta }),
    }).then(
      (value) => {
        result = value;
        channel.close();
      },
      (error) => {
        failure = error;
        channel.close();
      },
    );

    let streamedText = false;
    let streamedReasoning = false;

    for await (const event of channel.drain()) {
      if (event.type === "text") {
        streamedText = true;
      } else if (event.type === "reasoning") {
        streamedReasoning = true;
      }
      yield event;
    }

    if (failure) {
      const message =
        failure instanceof AgentRequestError
          ? failure.message
          : failure instanceof Error
          ? failure.message
          : String(failure);
      yield { type: "error", message };
      return;
    }

    const response = result as unknown as ChatResult;

    // providers/tests may answer in one block instead of streaming deltas
    if (response.reasoning && !streamedReasoning) {
      yield { type: "reasoning", delta: response.reasoning };
    }
    if (response.content && !streamedText) {
      yield { type: "text", delta: response.content };
    }

    history.push({
      role: "assistant",
      content: response.content,
      ...(response.toolCalls.length ? { toolCalls: response.toolCalls } : {}),
    });

    if (!response.toolCalls.length) {
      return;
    }

    let index = 0;
    for (const call of response.toolCalls) {
      index++;
      if (signal.aborted) {
        stopped = true;
        yield { type: "notice", text: t("agent.noticeStoppedPending") };
        padPendingCalls(response.toolCalls.slice(index - 1), "（用户已中止）");
        return;
      }

      yield { type: "tool_call", call };

      const signature = callSignature(call);
      const previousFailures = failCounts.get(signature) ?? 0;

      let toolResult: ToolResult;
      if (previousFailures >= sameToolFailLimit) {
        toolResult = {
          content: `该调用已连续失败 ${previousFailures} 次，先不要重复同样的调用，换一种方式（例如先 read_canvas 核对行号与 id）。`,
          isError: true,
        };
        yield { type: "tool_result", call, result: toolResult };
        history.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: toolResult.content,
        });
        continue;
      }

      try {
        toolResult = await registry.run(call, ctx);
      } catch (error) {
        toolResult = {
          content: `工具执行失败：${
            error instanceof Error ? error.message : String(error)
          }`,
          isError: true,
        };
      }

      toolResult = {
        ...toolResult,
        content: capContent(toolResult.content, toolResultCap),
      };

      if (toolResult.isError) {
        failCounts.set(signature, previousFailures + 1);
        failedCalls++;
      } else {
        failCounts.delete(signature);
      }

      yield { type: "tool_result", call, result: toolResult };
      history.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: toolResult.content,
      });

      if (failedCalls >= maxFailedCalls) {
        stopped = true;
        yield {
          type: "notice",
          text: t("agent.noticeTooManyFailures", { count: failedCalls }),
        };
        padPendingCalls(
          response.toolCalls.slice(index),
          "（本轮已因失败次数过多而中止）",
        );
        return;
      }
    }
  }

  if (!stopped) {
    yield {
      type: "notice",
      text: t("agent.noticeIterations"),
    };
  }
}
