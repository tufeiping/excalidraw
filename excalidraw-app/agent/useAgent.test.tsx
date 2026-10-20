import { act } from "react";
import { createRoot } from "react-dom/client";

import { newElement } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { loadChat } from "./chatStore";
import { useAgent } from "./useAgent";

import type { ChatResult } from "./types";

const replies: ChatResult[] = [];

vi.mock("./provider", () => ({
  AgentRequestError: class AgentRequestError extends Error {},
  chatCompletion: vi.fn(async () => {
    const reply = replies.shift();
    if (!reply) {
      throw new Error("the scripted model ran out of replies");
    }
    return reply;
  }),
}));

const rectangle = () =>
  newElement({
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 60,
  }) as ExcalidrawElement;

const fakeApi = () => {
  const elements = [rectangle()];
  return {
    getSceneElements: () => elements,
    getSceneElementsIncludingDeleted: () => elements,
    getAppState: () => ({ selectedElementIds: {} }),
    updateScene: vi.fn(),
  } as unknown as ExcalidrawImperativeAPI;
};

type AgentApi = ReturnType<typeof useAgent>;

const mount = (api: ExcalidrawImperativeAPI) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const ref: { current: AgentApi | null } = { current: null };

  const Probe = () => {
    ref.current = useAgent(api);
    return null;
  };

  act(() => {
    root.render(<Probe />);
  });

  return {
    get api() {
      return ref.current!;
    },
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
};

/** the transcript as it would come back after a page reload */
const storedItems = () => loadChat().items;

describe("useAgent transcript persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
    replies.length = 0;
  });

  it("keeps tool steps in the transcript after a reload", async () => {
    replies.push(
      {
        content: "",
        toolCalls: [{ id: "call_1", name: "read_canvas", arguments: "{}" }],
      },
      { content: "画布上有一个矩形。", toolCalls: [] },
    );

    const first = mount(fakeApi());
    await act(async () => {
      await first.api.send("看一下画布");
    });

    // the live transcript shows the tool step between the two messages
    expect(first.api.items.map((item) => item.kind)).toEqual([
      "user",
      "tool",
      "assistant",
    ]);

    first.unmount();

    // ...and it is still there once the panel is reopened (fresh page load)
    const persisted = storedItems();
    expect(persisted.map((item) => item.kind)).toContain("tool");

    const second = mount(fakeApi());
    expect(second.api.items.map((item) => item.kind)).toEqual([
      "user",
      "tool",
      "assistant",
    ]);
    second.unmount();
  });

  it("persists the tool result content, not just the call", async () => {
    replies.push(
      {
        content: "",
        toolCalls: [{ id: "call_1", name: "read_canvas", arguments: "{}" }],
      },
      { content: "好了", toolCalls: [] },
    );

    const session = mount(fakeApi());
    await act(async () => {
      await session.api.send("看一下画布");
    });
    session.unmount();

    const tool = storedItems().find((item) => item.kind === "tool");
    expect(tool?.content).toBeTruthy();
    expect(tool?.content).toContain("rectangle");
  });

  it("continues a restored conversation without losing its history", async () => {
    replies.push(
      {
        content: "",
        toolCalls: [{ id: "call_1", name: "read_canvas", arguments: "{}" }],
      },
      { content: "好了", toolCalls: [] },
    );

    const first = mount(fakeApi());
    await act(async () => {
      await first.api.send("看一下画布");
    });
    first.unmount();

    replies.push({ content: "再改一下", toolCalls: [] });
    const second = mount(fakeApi());
    await act(async () => {
      await second.api.send("再改一下");
    });

    expect(second.api.items.map((item) => item.kind)).toEqual([
      "user",
      "tool",
      "assistant",
      "user",
      "assistant",
    ]);
    second.unmount();
  });
});
