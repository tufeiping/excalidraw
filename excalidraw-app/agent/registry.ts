import type { ToolCall, ToolContext, ToolDef, ToolResult } from "./types";

import type { Tool } from "./types";

/**
 * Holds the tools exposed to the model. `run()` never throws: failures are
 * turned into tool results so the message history stays well-formed (an
 * assistant `tool_calls` entry without a matching `tool` message makes the next
 * request invalid).
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool) {
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string) {
    return this.tools.get(name);
  }

  defs(): ToolDef[] {
    return [...this.tools.values()].map(
      ({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      }),
    );
  }

  async run(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return {
        content: `未知工具 "${call.name}"，可用工具：${[
          ...this.tools.keys(),
        ].join(", ")}`,
        isError: true,
      };
    }

    let args: Record<string, any> = {};
    const raw = call.arguments?.trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed;
        } else {
          return { content: "参数必须是一个 JSON 对象", isError: true };
        }
      } catch (error) {
        return {
          content: `参数不是合法 JSON：${
            (error as Error).message
          }\n收到：${raw.slice(0, 500)}`,
          isError: true,
        };
      }
    }

    try {
      const result = await tool.run(args, ctx);
      return result?.content == null ? { content: "（没有返回内容）" } : result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: `工具执行失败：${message}`, isError: true };
    }
  }
}
