import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

/** A tool call emitted by the model (arguments are still raw JSON text). */
export type ToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type AssistantMessage = {
  role: "assistant";
  content: string;
  toolCalls?: ToolCall[];
};

/**
 * Minimal, provider-agnostic chat message. `tool` messages must directly follow
 * the assistant message that requested them, or the next request is rejected by
 * the provider.
 */
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | AssistantMessage
  | { role: "tool"; content: string; toolCallId: string; name?: string };

export type ToolParameters = {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolDef = {
  name: string;
  description: string;
  parameters: ToolParameters;
};

export type ToolResult = {
  content: string;
  isError?: boolean;
};

/** Compact view of the canvas: one element per line, kept in localStorage. */
export type SceneSnapshot = {
  /** bumped whenever the snapshot content changes */
  rev: number;
  updatedAt: number;
  /** element JSON lines, prefixed with `L<n>:` when rendered */
  lines: string[];
  /** element id per line */
  ids: string[];
};

export type SelectionHandle = {
  id: string;
  /** element ids captured by the handle, in reading order */
  ids: string[];
  rev: number;
  createdAt: number;
};

export type SelectionStore = {
  register(ids: string[], rev: number): SelectionHandle;
  get(id: string): SelectionHandle | undefined;
  last(): SelectionHandle | null;
};

export type SceneAccess = {
  /** current snapshot (re-synced from the canvas) */
  snapshot(): SceneSnapshot;
  /** force a re-sync from the live canvas, then return the snapshot */
  sync(): SceneSnapshot;
};

/**
 * Per-conversation bookkeeping: the canvas revision the model last saw, so a
 * write cannot silently apply stale line numbers after the user edited the
 * canvas in between.
 */
export type AgentSession = {
  expectedRev: number | null;
};

export type ToolContext = {
  api: ExcalidrawImperativeAPI;
  scene: SceneAccess;
  selections: SelectionStore;
  session: AgentSession;
  signal?: AbortSignal;
};

export type Tool = ToolDef & {
  run(
    args: Record<string, any>,
    ctx: ToolContext,
  ): Promise<ToolResult> | ToolResult;
};

/** Streamed agent events, consumed by the panel to render the agent process. */
export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "tool_result"; call: ToolCall; result: ToolResult }
  | { type: "notice"; text: string }
  | { type: "error"; message: string };

export type ChatResult = {
  content: string;
  toolCalls: ToolCall[];
  finishReason?: string;
  /** provider reasoning stream, shown in the UI but never replayed */
  reasoning?: string;
};
