import { newElement } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { runAgent } from "./loop";
import { ToolRegistry } from "./registry";
import { loadSnapshot, syncSceneSnapshot } from "./sceneStore";
import { InMemorySelectionStore } from "./selection";
import { canvasTools } from "./tools";

import type { AgentEvent, ChatMessage, ChatResult, ToolContext } from "./types";

type ScriptedReply = (messages: ChatMessage[]) => ChatResult;

const replies: ScriptedReply[] = [];

vi.mock("./provider", () => ({
  AgentRequestError: class AgentRequestError extends Error {},
  chatCompletion: vi.fn(async ({ messages }: { messages: ChatMessage[] }) => {
    const reply = replies.shift();
    if (!reply) {
      throw new Error("the scripted model ran out of replies");
    }
    return reply(messages);
  }),
}));

const rectangle = (opts: Record<string, unknown> = {}) =>
  newElement({
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    ...opts,
  }) as ExcalidrawElement;

const lastToolResult = (messages: ChatMessage[]) => {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "tool") {
      return messages[index].content;
    }
  }
  return "";
};

const toolCall = (name: string, args: Record<string, unknown>): ChatResult => ({
  content: "",
  toolCalls: [
    {
      id: `${name}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      arguments: JSON.stringify(args),
    },
  ],
});

const createHarness = (
  elements: ExcalidrawElement[],
  selected: string[] = [],
) => {
  let scene = [...elements];
  let selectedElementIds = selected.reduce(
    (acc, id) => ({ ...acc, [id]: true }),
    {} as Record<string, boolean>,
  );

  const api = {
    getSceneElements: () => scene.filter((element) => !element.isDeleted),
    getSceneElementsIncludingDeleted: () => scene,
    getAppState: () => ({ selectedElementIds }),
    updateScene: ({
      elements,
      appState,
    }: {
      elements?: readonly ExcalidrawElement[];
      appState?: { selectedElementIds?: Record<string, boolean> };
    }) => {
      if (elements) {
        scene = [...elements] as ExcalidrawElement[];
      }
      if (appState?.selectedElementIds) {
        selectedElementIds = appState.selectedElementIds;
      }
    },
  } as unknown as ExcalidrawImperativeAPI;

  const registry = new ToolRegistry();
  canvasTools.forEach((tool) => registry.register(tool));

  const ctx: ToolContext = {
    api,
    scene: {
      snapshot: () => loadSnapshot(),
      sync: () => syncSceneSnapshot(api),
    },
    selections: new InMemorySelectionStore(),
    session: { expectedRev: null },
  };

  return {
    ctx,
    registry,
    getScene: () => scene,
    getSelectedIds: () => Object.keys(selectedElementIds),
  };
};

const runTurn = async (
  harness: ReturnType<typeof createHarness>,
  input: string,
  history: ChatMessage[] = [],
) => {
  const events: AgentEvent[] = [];
  for await (const event of runAgent(
    {
      registry: harness.registry,
      ctx: harness.ctx,
      systemPrompt: "system",
    },
    history,
    input,
    new AbortController().signal,
  )) {
    events.push(event);
  }
  return { events, history };
};

describe("agent end to end", () => {
  beforeEach(() => {
    replies.length = 0;
    window.localStorage.clear();
  });

  it("reads the canvas, edits one element, and reports back", async () => {
    const first = rectangle({ backgroundColor: "#a5d8ff" });
    const second = rectangle({ x: 200, backgroundColor: "#a5d8ff" });
    const harness = createHarness([first, second]);

    replies.push(
      () => toolCall("read_canvas", { offset: 1, limit: 10 }),
      (messages) => {
        // "the model" reads the second line the tool returned and patches it
        const line = lastToolResult(messages)
          .split("\n")
          .find((candidate) => candidate.startsWith("L2: "));
        expect(line).toBeTruthy();
        const element = JSON.parse(line!.replace(/^L2: /, ""));
        expect(element.id).toBe(second.id);
        return toolCall("write_canvas", {
          ops: [
            {
              op: "replace",
              start: 2,
              end: 2,
              lines: [
                JSON.stringify({ id: element.id, backgroundColor: "#ffc9c9" }),
              ],
            },
          ],
        });
      },
      () => ({ content: "第二个矩形已经改成红色了。", toolCalls: [] }),
    );

    const { events, history } = await runTurn(harness, "把第二个矩形改成红色");

    const scene = harness.getScene();
    expect(
      scene.find((element) => element.id === second.id)?.backgroundColor,
    ).toBe("#ffc9c9");
    expect(
      scene.find((element) => element.id === first.id)?.backgroundColor,
    ).toBe("#a5d8ff");

    // transcript is replayable: assistant tool calls always have tool results
    const roles = history.map((message) => message.role);
    expect(roles).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(events.at(-1)).toEqual({
      type: "text",
      delta: "第二个矩形已经改成红色了。",
    });
    expect(
      events.some(
        (event) =>
          event.type === "tool_result" && event.call.name === "write_canvas",
      ),
    ).toBe(true);
  });

  it("edits only the selected range", async () => {
    const before = rectangle({ x: 0 });
    const selected = rectangle({ x: 200, backgroundColor: "#a5d8ff" });
    const after = rectangle({ x: 400 });
    const harness = createHarness([before, selected, after], [selected.id]);

    replies.push(
      () => toolCall("read_selection", {}),
      (messages) => {
        const result = lastToolResult(messages);
        const selectionId = result.match(/选区 (sel_\d+)/)?.[1];
        expect(selectionId).toBeTruthy();
        return toolCall("replace_selection", {
          selectionId,
          lines: [
            JSON.stringify({
              id: selected.id,
              backgroundColor: "#b2f2bb",
              strokeColor: "#2f9e44",
            }),
          ],
        });
      },
      () => ({ content: "已把选中的卡片改成绿色。", toolCalls: [] }),
    );

    const { history } = await runTurn(harness, "把这个改成绿色");

    const scene = harness.getScene();
    expect(scene.map((element) => element.backgroundColor)).toEqual([
      before.backgroundColor,
      "#b2f2bb",
      after.backgroundColor,
    ]);
    expect(loadSnapshot().ids).toEqual([before.id, selected.id, after.id]);
    expect(harness.getSelectedIds()).toEqual([selected.id]);
    expect(history.filter((message) => message.role === "tool")).toHaveLength(
      2,
    );
  });

  it("feeds write errors back so the model can correct itself", async () => {
    const element = rectangle();
    const harness = createHarness([element]);

    replies.push(
      () =>
        toolCall("write_canvas", {
          ops: [{ op: "replace", start: 9, end: 9, lines: ['{"id":"nope"}'] }],
        }),
      (messages) => {
        expect(lastToolResult(messages)).toMatch(/start 必须在/);
        return toolCall("write_canvas", {
          ops: [
            {
              op: "replace",
              start: 1,
              end: 1,
              lines: [
                JSON.stringify({ id: element.id, strokeColor: "#1971c2" }),
              ],
            },
          ],
        });
      },
      () => ({ content: "边框改成蓝色了。", toolCalls: [] }),
    );

    const { events } = await runTurn(harness, "给这个加蓝边");

    const toolResults = events.filter(
      (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
        event.type === "tool_result",
    );
    expect(toolResults[0].result.isError).toBe(true);
    expect(toolResults[1].result.isError).toBeFalsy();
    expect(harness.getScene()[0].strokeColor).toBe("#1971c2");
  });
});
