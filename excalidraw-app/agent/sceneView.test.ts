import { newElement, newTextElement } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import {
  buildElementsFromLines,
  formatLine,
  parseAgentLine,
  serializeAgentElement,
  stripLinePrefix,
} from "./sceneView";

// vitest-canvas-mock reports a zero text width, which would hide wrapping:
// fake a fixed per-character advance so text layout is observable
beforeAll(() => {
  vi.spyOn(
    CanvasRenderingContext2D.prototype,
    "measureText",
  ).mockImplementation(function (this: CanvasRenderingContext2D, text: string) {
    return { width: text.length * 10 } as TextMetrics;
  } as any);
});

const rectangle = (opts: Partial<Parameters<typeof newElement>[0]> = {}) =>
  newElement({
    type: "rectangle",
    x: 0,
    y: 0,
    width: 120,
    height: 80,
    ...opts,
  }) as ExcalidrawElement;

const linesOf = (elements: readonly ExcalidrawElement[]) =>
  elements.map((element, index) => formatLine(index + 1, element));

describe("sceneView", () => {
  describe("serializeAgentElement", () => {
    it("drops volatile fields and empty defaults", () => {
      const element = rectangle({ backgroundColor: "#a5d8ff" });
      const view = JSON.parse(serializeAgentElement(element));

      expect(view.id).toBe(element.id);
      expect(view.type).toBe("rectangle");
      expect(view.backgroundColor).toBe("#a5d8ff");
      expect(view.version).toBeUndefined();
      expect(view.versionNonce).toBeUndefined();
      expect(view.index).toBeUndefined();
      expect(view.isDeleted).toBeUndefined();
      expect(view.groupIds).toBeUndefined();
      expect(view.boundElements).toBeUndefined();
    });

    it("prefixes lines with their readable line number", () => {
      const element = rectangle();
      expect(formatLine(7, element).startsWith("L7: {")).toBe(true);
    });
  });

  describe("stripLinePrefix", () => {
    it.each([
      ['L12: {"id":"a"}', '{"id":"a"}'],
      ['12：{"id":"a"}', '{"id":"a"}'],
      ['{"id":"a"}', '{"id":"a"}'],
      ['  L3:  {"id":"a"}  ', '{"id":"a"}'],
    ])("strips %s", (input, expected) => {
      expect(stripLinePrefix(input)).toBe(expected);
    });
  });

  describe("parseAgentLine", () => {
    it("parses a patch and keeps id/type", () => {
      const parsed = parseAgentLine(
        'L2: {"id":"a","backgroundColor":"#ffc9c9"}',
      );
      expect(parsed.error).toBeUndefined();
      expect(parsed.id).toBe("a");
      expect(parsed.type).toBeNull();
      expect(parsed.patch.backgroundColor).toBe("#ffc9c9");
    });

    it("rejects broken JSON", () => {
      expect(parseAgentLine("L1: {oops}").error).toMatch(/不是合法 JSON/);
    });

    it("rejects lines without id or type", () => {
      expect(parseAgentLine('{"x":10}').error).toMatch(/type/);
    });
  });

  describe("buildElementsFromLines", () => {
    it("patches an existing element by id and bumps its version", () => {
      const element = rectangle();
      const result = buildElementsFromLines({
        live: [element],
        lines: [`L1: {"id":"${element.id}","backgroundColor":"#ffc9c9"}`],
      });

      expect(result.errors).toEqual([]);
      expect(result.updated).toBe(1);
      const next = result.elements.find(
        (candidate) => candidate.id === element.id,
      );
      expect(next?.backgroundColor).toBe("#ffc9c9");
      expect(next?.version).toBeGreaterThan(element.version);
      // untouched fields survive the partial patch
      expect(next?.width).toBe(element.width);
      expect(next?.strokeColor).toBe(element.strokeColor);
    });

    it("adds elements that only carry a type", () => {
      const result = buildElementsFromLines({
        live: [],
        lines: ['{"type":"ellipse","x":10,"y":20,"width":40,"height":40}'],
      });

      expect(result.errors).toEqual([]);
      expect(result.added).toBe(1);
      expect(result.elements).toHaveLength(1);
      expect(result.elements[0].type).toBe("ellipse");
      expect(result.elements[0].id).toBeTruthy();
      expect(result.elements[0].x).toBe(10);
    });

    it("deletes elements whose line disappeared", () => {
      const keep = rectangle();
      const drop = rectangle();
      const result = buildElementsFromLines({
        live: [keep, drop],
        lines: linesOf([keep]),
      });

      expect(result.deleted).toBe(1);
      const dropped = result.elements.find((element) => element.id === drop.id);
      expect(dropped?.isDeleted).toBe(true);
      // deleted elements stay in the scene so undo/collab deltas stay valid
      expect(
        result.elements.filter((element) => !element.isDeleted),
      ).toHaveLength(1);
    });

    it("keeps line order as paint order", () => {
      const first = rectangle();
      const second = rectangle();
      const result = buildElementsFromLines({
        live: [first, second],
        lines: linesOf([second, first]),
      });

      const visible = result.elements.filter((element) => !element.isDeleted);
      expect(visible.map((element) => element.id)).toEqual([
        second.id,
        first.id,
      ]);
      expect(String(visible[0].index) < String(visible[1].index)).toBe(true);
    });

    it("is all-or-nothing when a line is invalid", () => {
      const element = rectangle();
      const result = buildElementsFromLines({
        live: [element],
        lines: [
          `L1: {"id":"${element.id}","backgroundColor":"#ffc9c9"}`,
          "L2: {oops}",
        ],
      });

      expect(result.errors).toHaveLength(1);
      expect(result.elements).toEqual([]);
    });

    it("re-measures a text element when its content changes", () => {
      const label = newTextElement({
        x: 0,
        y: 0,
        text: "短",
        originalText: "短",
        fontSize: 20,
      } as any) as ExcalidrawElement;

      const result = buildElementsFromLines({
        live: [label],
        lines: [
          `L1: {"id":"${label.id}","text":"十个字的一行文字要重新测量","originalText":"十个字的一行文字要重新测量"}`,
        ],
      });

      expect(result.errors).toEqual([]);
      const next = result.elements.find(
        (element) => element.id === label.id,
      ) as any;
      expect(next.text).toBe("十个字的一行文字要重新测量");
      // autoResize text grows horizontally, one line stays one line
      expect(next.width).toBeGreaterThan(label.width);
      expect(next.height).toBe(label.height);
    });

    it("does not report untouched lines as updates", () => {
      const element = rectangle();
      const result = buildElementsFromLines({
        live: [element],
        lines: linesOf([element]),
      });

      expect(result.unchanged).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.elements[0].id).toBe(element.id);
      expect(result.elements[0].backgroundColor).toBe(element.backgroundColor);
    });
  });
});
