import { newElement } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { loadSnapshot, syncSceneSnapshot } from "./sceneStore";
import { InMemorySelectionStore } from "./selection";
import { canvasTools } from "./tools";

import type { Tool, ToolContext } from "./types";

const rectangle = (opts: Record<string, unknown> = {}) =>
  newElement({
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    ...opts,
  }) as ExcalidrawElement;

const createHarness = (elements: ExcalidrawElement[]) => {
  let scene = [...elements];
  let selectedElementIds: Record<string, boolean> = {};

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

  const ctx: ToolContext = {
    api,
    scene: {
      snapshot: () => loadSnapshot(),
      sync: () => syncSceneSnapshot(api),
    },
    selections: new InMemorySelectionStore(),
    session: { expectedRev: null },
  };

  const run = (name: string, args: Record<string, unknown> = {}) => {
    const tool = canvasTools.find(
      (candidate) => candidate.name === name,
    ) as Tool;
    expect(tool).toBeDefined();
    return tool.run(args, ctx);
  };

  return {
    ctx,
    run,
    select: (ids: string[]) => {
      selectedElementIds = ids.reduce(
        (acc, id) => ({ ...acc, [id]: true }),
        {} as Record<string, boolean>,
      );
    },
    setScene: (elements: ExcalidrawElement[]) => {
      scene = [...elements];
    },
    getScene: () => scene,
    getSelectedIds: () => Object.keys(selectedElementIds),
  };
};

describe("canvas tools", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  describe("read_canvas", () => {
    it("explains how to start on an empty canvas", async () => {
      const harness = createHarness([]);
      const result = await harness.run("read_canvas");
      expect(result.content).toMatch(/画布是空的/);
      expect(result.isError).toBeFalsy();
    });

    it("pages through the snapshot", async () => {
      const harness = createHarness([
        rectangle(),
        rectangle(),
        rectangle(),
        rectangle(),
        rectangle(),
      ]);

      const first = await harness.run("read_canvas", { limit: 2 });
      expect(first.content).toMatch(/rev=1/);
      expect(first.content).toMatch(/5 个元素/);
      expect(first.content).toMatch(/还有 3 行/);
      expect(first.content).toContain("L1: {");
      expect(first.content).toContain("L2: {");
      expect(first.content).not.toContain("L3: {");

      const second = await harness.run("read_canvas", { offset: 3, limit: 2 });
      expect(second.content).toContain("L3: {");
      expect(second.content).toContain("L4: {");
      expect(second.content).not.toContain("L5: {");
    });

    it("prefixes every line exactly once", async () => {
      const harness = createHarness([rectangle(), rectangle()]);
      const read = await harness.run("read_canvas");
      expect(read.content).not.toMatch(/L\d+:\s*L\d+:/);
      expect(read.content).toMatch(/\nL1: \{.*\}\nL2: \{/);

      const write = await harness.run("write_canvas", {
        ops: [
          { op: "append", lines: ['{"type":"text","id":"t1","text":"hi"}'] },
        ],
      });
      expect(write.content).not.toMatch(/L\d+:\s*L\d+:/);
    });

    it("clamps out-of-range offsets", async () => {
      const harness = createHarness([rectangle()]);
      const result = await harness.run("read_canvas", { offset: 99 });
      expect(result.content).toContain("L1: {");
    });
  });

  describe("write_canvas", () => {
    it("replaces a single line and leaves the rest alone", async () => {
      const first = rectangle({ backgroundColor: "#a5d8ff" });
      const second = rectangle({ x: 200 });
      const harness = createHarness([first, second]);

      const result = await harness.run("write_canvas", {
        ops: [
          {
            op: "replace",
            start: 1,
            end: 1,
            lines: [`{"id":"${first.id}","backgroundColor":"#ffc9c9"}`],
          },
        ],
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toMatch(/更新 1 个/);

      const scene = harness.getScene();
      expect(
        scene.find((element) => element.id === first.id)?.backgroundColor,
      ).toBe("#ffc9c9");
      expect(
        scene.find((element) => element.id === second.id)?.backgroundColor,
      ).toBe(second.backgroundColor);
      expect(scene.filter((element) => !element.isDeleted)).toHaveLength(2);
    });

    it("appends new elements", async () => {
      const harness = createHarness([rectangle()]);

      const result = await harness.run("write_canvas", {
        ops: [
          {
            op: "append",
            lines: [
              '{"type":"ellipse","id":"new-el","x":300,"y":0,"width":80,"height":80}',
            ],
          },
        ],
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toMatch(/新增 1 个/);
      expect(
        harness.getScene().some((element) => element.id === "new-el"),
      ).toBe(true);

      const snapshot = loadSnapshot();
      expect(snapshot.lines).toHaveLength(2);
      expect(snapshot.lines[1]).toContain('"id":"new-el"');
    });

    it("deletes a line", async () => {
      const keep = rectangle();
      const drop = rectangle({ x: 200 });
      const harness = createHarness([keep, drop]);

      const result = await harness.run("write_canvas", {
        ops: [{ op: "delete", start: 2, end: 2 }],
      });

      expect(result.isError).toBeFalsy();
      expect(result.content).toMatch(/删除 1 个/);
      const dropped = harness
        .getScene()
        .find((element) => element.id === drop.id);
      expect(dropped?.isDeleted).toBe(true);
      expect(loadSnapshot().lines).toHaveLength(1);
    });

    it("applies several ops in one call", async () => {
      const first = rectangle();
      const second = rectangle({ x: 200 });
      const harness = createHarness([first, second]);

      const result = await harness.run("write_canvas", {
        ops: [
          {
            op: "replace",
            start: 1,
            end: 1,
            lines: [`{"id":"${first.id}","strokeColor":"#e03131"}`],
          },
          {
            op: "insert",
            at: 2,
            lines: ['{"type":"text","id":"txt","x":0,"y":0,"text":"标题"}'],
          },
        ],
      });

      expect(result.isError).toBeFalsy();
      const snapshot = loadSnapshot();
      expect(snapshot.ids).toEqual([first.id, "txt", second.id]);
    });

    it("refuses the whole write when a line is invalid", async () => {
      const element = rectangle();
      const harness = createHarness([element]);

      const result = await harness.run("write_canvas", {
        ops: [
          {
            op: "replace",
            start: 1,
            end: 1,
            lines: [
              `{"id":"${element.id}","backgroundColor":"#ffc9c9"}`,
              "{oops",
            ],
          },
        ],
      });

      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/未写入/);
      expect(harness.getScene()[0].backgroundColor).toBe(
        element.backgroundColor,
      );
    });

    it("refuses to write against a stale snapshot", async () => {
      const first = rectangle();
      const second = rectangle({ x: 200 });
      const harness = createHarness([first]);

      // the model reads a one-element canvas...
      await harness.run("read_canvas");

      // ... then the user draws another element
      harness.setScene([first, second]);
      harness.ctx.scene.sync();

      const result = await harness.run("write_canvas", {
        ops: [{ op: "delete", start: 2, end: 2 }],
      });

      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/画布在读取之后已经变化/);
      expect(
        harness.getScene().filter((element) => !element.isDeleted),
      ).toHaveLength(2);

      // re-reading recovers
      await harness.run("read_canvas");
      const retried = await harness.run("write_canvas", {
        ops: [{ op: "delete", start: 2, end: 2 }],
      });
      expect(retried.isError).toBeFalsy();
      expect(
        harness.getScene().filter((element) => !element.isDeleted),
      ).toHaveLength(1);
    });

    it("reports out-of-range line numbers instead of guessing", async () => {
      const harness = createHarness([rectangle()]);
      const result = await harness.run("write_canvas", {
        ops: [{ op: "replace", start: 5, end: 5, lines: ['{"id":"x"}'] }],
      });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/start 必须在/);
    });
  });

  describe("selection tools", () => {
    it("asks for a selection when nothing is selected", async () => {
      const harness = createHarness([rectangle()]);
      const result = await harness.run("read_selection");
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/没有选中的元素/);
    });

    it("reads only the selected elements and replaces them in place", async () => {
      const before = rectangle({ backgroundColor: "#a5d8ff" });
      const selected = rectangle({ x: 200, backgroundColor: "#a5d8ff" });
      const after = rectangle({ x: 400 });
      const harness = createHarness([before, selected, after]);
      harness.select([selected.id]);

      const read = await harness.run("read_selection");
      expect(read.content).toMatch(/选区 sel_1/);
      expect(read.content).toContain(selected.id);
      expect(read.content).not.toContain(before.id);

      const replaced = await harness.run("replace_selection", {
        selectionId: "sel_1",
        lines: [`{"id":"${selected.id}","backgroundColor":"#b2f2bb"}`],
      });

      expect(replaced.isError).toBeFalsy();
      const scene = harness.getScene();
      expect(
        scene.find((element) => element.id === selected.id)?.backgroundColor,
      ).toBe("#b2f2bb");
      expect(
        scene.find((element) => element.id === before.id)?.backgroundColor,
      ).toBe(before.backgroundColor);
      expect(
        scene.find((element) => element.id === after.id)?.backgroundColor,
      ).toBe(after.backgroundColor);
      // z-order is preserved: the edited element stays between its neighbours
      expect(loadSnapshot().ids).toEqual([before.id, selected.id, after.id]);
      expect(harness.getSelectedIds()).toEqual([selected.id]);
    });

    it("refuses to edit elements outside the recorded selection", async () => {
      const selected = rectangle();
      const other = rectangle({ x: 200 });
      const harness = createHarness([selected, other]);
      harness.select([selected.id]);
      await harness.run("read_selection");

      const result = await harness.run("replace_selection", {
        selectionId: "sel_1",
        lines: [`{"id":"${other.id}","backgroundColor":"#ffc9c9"}`],
      });

      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/不在当前选区内/);
    });

    it("fails cleanly for an unknown selectionId", async () => {
      const harness = createHarness([rectangle()]);
      const result = await harness.run("replace_selection", {
        selectionId: "sel_404",
        lines: ['{"type":"text"}'],
      });
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/找不到选区/);
    });
  });
});
