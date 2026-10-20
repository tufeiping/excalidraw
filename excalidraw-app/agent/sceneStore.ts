import { CaptureUpdateAction } from "@excalidraw/excalidraw";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { STORAGE_KEYS } from "../app_constants";

import { buildElementsFromLines, serializeAgentElement } from "./sceneView";

import type { BuildResult } from "./sceneView";
import type { SceneSnapshot } from "./types";

const EMPTY_SNAPSHOT: SceneSnapshot = {
  rev: 0,
  updatedAt: 0,
  lines: [],
  ids: [],
};

const storage = () =>
  typeof window === "undefined" ? null : window.localStorage;

export const loadSnapshot = (): SceneSnapshot => {
  const store = storage();
  if (!store) {
    return EMPTY_SNAPSHOT;
  }
  try {
    const raw = store.getItem(STORAGE_KEYS.LOCAL_STORAGE_AGENT_SCENE);
    if (!raw) {
      return EMPTY_SNAPSHOT;
    }
    const parsed = JSON.parse(raw) as SceneSnapshot;
    if (!Array.isArray(parsed?.lines) || !Array.isArray(parsed?.ids)) {
      return EMPTY_SNAPSHOT;
    }
    return {
      rev: typeof parsed.rev === "number" ? parsed.rev : 0,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      lines: parsed.lines,
      ids: parsed.ids,
    };
  } catch {
    return EMPTY_SNAPSHOT;
  }
};

export const saveSnapshot = (snapshot: SceneSnapshot) => {
  const store = storage();
  if (!store) {
    return;
  }
  try {
    store.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_AGENT_SCENE,
      JSON.stringify(snapshot),
    );
  } catch {
    // quota exceeded — the snapshot is only a cache, the canvas is the source
    // of truth, so failing to persist it is not fatal
  }
};

export const buildSnapshot = (
  elements: readonly { id: string; isDeleted: boolean }[],
  previous?: SceneSnapshot,
): SceneSnapshot => {
  const visible = elements.filter((element) => !element.isDeleted);
  // raw element JSON; line numbers are derived at read time so they always
  // match the current order
  const lines = visible.map((element) => serializeAgentElement(element as any));
  const ids = visible.map((element) => element.id);

  const unchanged =
    previous &&
    previous.lines.length === lines.length &&
    lines.every((line, index) => line === previous.lines[index]);

  return {
    rev: unchanged ? previous.rev : (previous?.rev ?? 0) + 1,
    updatedAt: Date.now(),
    lines,
    ids,
  };
};

/**
 * Rebuilds the compact snapshot from the live canvas and persists it. The
 * snapshot is the line-numbered view the agent reads, so it must always be
 * in sync with what the user sees.
 */
export const syncSceneSnapshot = (
  api: ExcalidrawImperativeAPI,
): SceneSnapshot => {
  const previous = loadSnapshot();
  const snapshot = buildSnapshot(api.getSceneElements(), previous);
  if (snapshot.rev !== previous.rev) {
    saveSnapshot(snapshot);
  }
  return snapshot;
};

/** Applies line edits to the canvas in a single undoable update. */
export const applySceneLines = (
  api: ExcalidrawImperativeAPI,
  lines: string[],
): BuildResult => {
  const live = api.getSceneElementsIncludingDeleted();
  const result = buildElementsFromLines({ lines, live });

  if (result.errors.length) {
    return result;
  }

  api.updateScene({
    elements: result.elements,
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });

  syncSceneSnapshot(api);
  return result;
};
