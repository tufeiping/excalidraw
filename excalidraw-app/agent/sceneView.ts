import {
  arrayToMap,
  getFontString,
  randomInteger,
  randomId,
} from "@excalidraw/common";
import {
  computeBoundTextPosition,
  computeContainerDimensionForBoundText,
  getBoundTextMaxHeight,
  getBoundTextMaxWidth,
  isArrowElement,
  isTextElement,
  measureText,
  syncInvalidIndices,
  wrapText,
} from "@excalidraw/element";
import { generateNKeysBetween } from "@excalidraw/fractional-indexing";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";

import type {
  ElementsMap,
  ExcalidrawElement,
  ExcalidrawTextElement,
  ExcalidrawTextElementWithContainer,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";

type MutableTextElement = {
  -readonly [K in keyof ExcalidrawTextElementWithContainer]: ExcalidrawTextElementWithContainer[K];
};

/**
 * Volatile/internal fields that are noise for the model (and must not be
 * round-tripped through edits): version bookkeeping, deletes, ordering.
 */
const OMITTED_KEYS = new Set([
  "version",
  "versionNonce",
  "updated",
  "created",
  "seed",
  "index",
  "isDeleted",
  "strokeSharpness",
  "rawText",
]);

export const toAgentElement = (
  element: ExcalidrawElement,
): Record<string, unknown> => {
  const view: Record<string, unknown> = {};
  for (const key of Object.keys(element).sort()) {
    if (OMITTED_KEYS.has(key)) {
      continue;
    }
    const value = (element as unknown as Record<string, unknown>)[key];
    if (value === null || value === undefined) {
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }
    view[key] = value;
  }
  return view;
};

export const serializeAgentElement = (element: ExcalidrawElement) =>
  JSON.stringify(toAgentElement(element));

/** `L12: {...}` — the line format the model reads and writes. */
export const formatLine = (
  lineNumber: number,
  element: ExcalidrawElement,
): string => `L${lineNumber}: ${serializeAgentElement(element)}`;

const LINE_PREFIX_RE = /^\s*(?:L\s*)?(\d+)\s*[:：]\s*/i;

/** Removes a leading `L<n>:` marker if the model echoed one back. */
export const stripLinePrefix = (line: string) =>
  line.replace(LINE_PREFIX_RE, "").trim();

export type ParsedLine = {
  id: string | null;
  type: string | null;
  patch: Record<string, unknown>;
  error?: string;
};

export const parseAgentLine = (rawLine: string): ParsedLine => {
  const line = stripLinePrefix(rawLine);
  if (!line) {
    return { id: null, type: null, patch: {}, error: "空行" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return {
      id: null,
      type: null,
      patch: {},
      error: `不是合法 JSON（${(error as Error).message}）`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { id: null, type: null, patch: {}, error: "必须是一个 JSON 对象" };
  }
  const patch = parsed as Record<string, unknown>;
  const id = typeof patch.id === "string" && patch.id ? patch.id : null;
  const type = typeof patch.type === "string" && patch.type ? patch.type : null;
  if (!id && !type) {
    return {
      id,
      type,
      patch,
      error: "新元素必须包含 type 字段（已有元素必须包含 id）",
    };
  }
  return { id, type, patch };
};

const TEXT_LAYOUT_KEYS = [
  "text",
  "originalText",
  "fontSize",
  "fontFamily",
  "lineHeight",
  "textAlign",
  "verticalAlign",
  "width",
  "autoResize",
];

const layoutChanged = (
  previous: ExcalidrawElement | undefined,
  next: ExcalidrawElement,
) => {
  if (!previous || !isTextElement(next) || !isTextElement(previous)) {
    return false;
  }
  return TEXT_LAYOUT_KEYS.some(
    (key) =>
      (previous as unknown as Record<string, unknown>)[key] !==
      (next as unknown as Record<string, unknown>)[key],
  );
};

/**
 * Recomputes a text element's box from its content and re-centers it inside its
 * container, mirroring the editor's `redrawTextBoundingBox` but without needing
 * the renderer (so a batch of edits can be applied in a single `updateScene`,
 * avoiding intermediate re-renders).
 */
export const refitTextElement = (
  textElement: ExcalidrawTextElement,
  container: ExcalidrawElement | null | undefined,
  elementsMap: ElementsMap,
) => {
  const font = getFontString(textElement);
  const maxWidth = container
    ? getBoundTextMaxWidth(container, textElement)
    : textElement.width;

  const shouldWrap = !!container || !textElement.autoResize;
  const text = shouldWrap
    ? wrapText(textElement.originalText ?? textElement.text, font, maxWidth)
    : textElement.text;

  const metrics = measureText(text, font, textElement.lineHeight);

  const next = {
    ...textElement,
    text,
    height: metrics.height,
    width: textElement.autoResize ? metrics.width : textElement.width,
  } as MutableTextElement;

  if (!container) {
    return next as ExcalidrawTextElement;
  }

  next.angle = isArrowElement(container) ? (0 as any) : container.angle;

  const maxHeight = getBoundTextMaxHeight(container, next);
  const maxContainerWidth = getBoundTextMaxWidth(container, next);

  if (!isArrowElement(container) && metrics.height > maxHeight) {
    const height = computeContainerDimensionForBoundText(
      metrics.height,
      container.type,
    );
    (container as any).height = height;
    (container as any).version = ((container as any).version ?? 0) + 1;
    (container as any).versionNonce = randomInteger();
    (container as any).updated = Date.now();
  }

  if (metrics.width > maxContainerWidth) {
    const width = computeContainerDimensionForBoundText(
      metrics.width,
      container.type,
    );
    (container as any).width = width;
    (container as any).version = ((container as any).version ?? 0) + 1;
    (container as any).versionNonce = randomInteger();
    (container as any).updated = Date.now();
  }

  const { x, y } = computeBoundTextPosition(container, next, elementsMap);
  next.x = x;
  next.y = y;

  return next as ExcalidrawTextElement;
};

export type BuildOptions = {
  lines: string[];
  /** live scene, including deleted elements */
  live: readonly ExcalidrawElement[];
};

export type BuildResult = {
  elements: OrderedExcalidrawElement[];
  added: number;
  updated: number;
  deleted: number;
  unchanged: number;
  errors: string[];
};

const fingerprint = (element: ExcalidrawElement) =>
  serializeAgentElement(element);

/**
 * Turns agent-facing lines into a full scene: patches are merged onto existing
 * elements by `id`, unknown ids create new elements, missing ids get deleted.
 * Any invalid line aborts the whole write (all-or-nothing).
 */
export const buildElementsFromLines = ({
  lines,
  live,
}: BuildOptions): BuildResult => {
  const liveMap = arrayToMap(live);
  const errors: string[] = [];

  const parsedLines = lines.map((line, position) => {
    const parsed = parseAgentLine(line);
    if (parsed.error) {
      errors.push(`第 ${position + 1} 行：${parsed.error}`);
    }
    return parsed;
  });

  const seenIds = new Set<string>();
  const visible: ExcalidrawElement[] = [];
  let added = 0;
  let updated = 0;
  let unchanged = 0;

  for (const parsed of parsedLines) {
    if (parsed.error) {
      continue;
    }
    const existing = parsed.id ? liveMap.get(parsed.id) : undefined;

    if (existing && existing.isDeleted) {
      errors.push(
        `第 ${visible.length + 1} 行：元素 ${parsed.id} 已被删除，不能修改`,
      );
      continue;
    }

    let element: ExcalidrawElement;
    if (existing) {
      if (seenIds.has(existing.id)) {
        errors.push(`元素 id 重复：${existing.id}`);
        continue;
      }
      const merged = {
        ...existing,
        ...parsed.patch,
        id: existing.id,
      } as ExcalidrawElement;
      if (fingerprint(merged) === fingerprint(existing)) {
        unchanged++;
        element = existing;
      } else {
        element = {
          ...merged,
          isDeleted: false,
          version: (existing.version ?? 0) + 1,
          versionNonce: randomInteger(),
          updated: Date.now(),
        } as ExcalidrawElement;
        updated++;
      }
    } else {
      element = {
        ...parsed.patch,
        id: parsed.id || randomId(),
        type: parsed.type,
        isDeleted: false,
        version: 1,
        versionNonce: randomInteger(),
        updated: Date.now(),
      } as unknown as ExcalidrawElement;
      added++;
    }

    seenIds.add(element.id);
    visible.push(element);
  }

  if (errors.length) {
    return { elements: [], added, updated, deleted: 0, unchanged, errors };
  }

  // refit text after all patches are merged, so containers can reference each
  // other regardless of line order
  const draftMap = new Map(
    visible.map((element) => [element.id, element]),
  ) as ElementsMap;
  for (let i = 0; i < visible.length; i++) {
    const element = visible[i];
    if (!isTextElement(element)) {
      continue;
    }
    const previous = liveMap.get(element.id);
    const container = element.containerId
      ? draftMap.get(element.containerId)
      : null;
    // new text elements always get measured, existing ones only when their
    // layout-relevant fields changed
    if (previous && !layoutChanged(previous, element)) {
      continue;
    }
    visible[i] = refitTextElement(element, container, draftMap);
  }

  const deletedElements: ExcalidrawElement[] = [];
  let deleted = 0;
  for (const element of live) {
    if (element.isDeleted) {
      deletedElements.push(element);
      continue;
    }
    if (!seenIds.has(element.id)) {
      deleted++;
      deletedElements.push({
        ...element,
        isDeleted: true,
        version: (element.version ?? 0) + 1,
        versionNonce: randomInteger(),
        updated: Date.now(),
      } as ExcalidrawElement);
    }
  }

  const restored = restoreElements(visible, liveMap, {
    refreshDimensions: true,
    repairBindings: true,
  });

  // keep the line order as the paint order, but only rewrite fractional indices
  // when the order actually changed (avoids pointless deltas)
  const previousOrder = live
    .filter((element) => !element.isDeleted && seenIds.has(element.id))
    .map((element) => element.id);
  const nextOrder = restored.map((element) => element.id);
  const orderChanged =
    previousOrder.length !== nextOrder.length ||
    previousOrder.some((id, index) => id !== nextOrder[index]);

  const ordered: OrderedExcalidrawElement[] = orderChanged
    ? (() => {
        const keys = generateNKeysBetween(null, null, restored.length);
        return restored.map((element, index) => ({
          ...element,
          index: keys[index] as OrderedExcalidrawElement["index"],
        }));
      })()
    : restored;

  const elements = syncInvalidIndices([
    ...ordered,
    ...(deletedElements as ExcalidrawElement[]),
  ]);

  return { elements, added, updated, deleted, unchanged, errors };
};
