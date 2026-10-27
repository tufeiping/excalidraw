import { convertToExcalidrawElements } from "@excalidraw/element";

import { CaptureUpdateAction } from "@excalidraw/excalidraw";

import { viewportCoordsToSceneCoords } from "@excalidraw/common";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { applySceneLines } from "./sceneStore";
import { formatLine, parseAgentLine, stripLinePrefix } from "./sceneView";

import type {
  SceneSnapshot,
  SelectionHandle,
  Tool,
  ToolContext,
} from "./types";

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const asInt = (value: unknown, fallback: number) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
};

const typeStats = (elements: readonly ExcalidrawElement[]) => {
  const counts = new Map<string, number>();
  for (const element of elements) {
    counts.set(element.type, (counts.get(element.type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type}×${count}`)
    .join(", ");
};

const bounds = (elements: readonly ExcalidrawElement[]) => {
  if (!elements.length) {
    return null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const element of elements) {
    minX = Math.min(minX, element.x);
    minY = Math.min(minY, element.y);
    maxX = Math.max(maxX, element.x + element.width);
    maxY = Math.max(maxY, element.y + element.height);
  }
  return {
    minX: Math.round(minX),
    minY: Math.round(minY),
    maxX: Math.round(maxX),
    maxY: Math.round(maxY),
  };
};

const describeBounds = (elements: readonly ExcalidrawElement[]) => {
  const box = bounds(elements);
  return box
    ? `x ${box.minX}..${box.maxX}, y ${box.minY}..${box.maxY}（宽 ${
        box.maxX - box.minX
      }，高 ${box.maxY - box.minY}）`
    : "空";
};

const selectedIds = (ctx: ToolContext) => {
  const { selectedElementIds } = ctx.api.getAppState();
  return Object.entries(selectedElementIds)
    .filter(([, selected]) => selected)
    .map(([id]) => id);
};

/**
 * Line numbers are only meaningful for the snapshot revision the model saw:
 * if the canvas moved on (the user drew something), a stale `replace` could
 * clobber the wrong element, so the write is refused instead.
 */
const staleRevision = (
  ctx: ToolContext,
  snapshot: SceneSnapshot,
): string | null => {
  if (
    ctx.session?.expectedRev != null &&
    snapshot.rev !== ctx.session.expectedRev
  ) {
    return `画布在读取之后已经变化（rev ${ctx.session.expectedRev} → ${snapshot.rev}），行号可能已经对不上。请重新 read_canvas 确认内容后再修改。`;
  }
  return null;
};

/** Shared write guard: view-mode links must never be modified. */
const readOnlyReason = (ctx: ToolContext) =>
  ctx.api.getAppState().viewModeEnabled
    ? "当前是只读（查看）模式，不能修改画布。"
    : null;

const header = (
  snapshot: SceneSnapshot,
  elements: readonly ExcalidrawElement[],
  ctx: ToolContext,
) => {
  const selectionCount = selectedIds(ctx).length;
  return [
    `# 画布快照 rev=${snapshot.rev}｜${elements.length} 个元素${
      elements.length ? `（${typeStats(elements)}）` : ""
    }`,
    `# 范围：${describeBounds(elements)}｜当前选中 ${selectionCount} 个元素`,
  ].join("\n");
};

const READ_DEFAULT_LIMIT = 40;
const READ_MAX_LIMIT = 120;

const readCanvas: Tool = {
  name: "read_canvas",
  description:
    "读取白板快照。整个画布被展开成若干行，每行是一个元素（JSON），行号形如 `L12: {...}`。" +
    "必须分块读取：默认每次 40 行，最多 120 行。先读需要处理的区域，不要一次读完大画布。" +
    "返回内容里会给出总行数、元素类型统计、画布坐标范围，以及当前选中元素数量。",
  parameters: {
    type: "object",
    properties: {
      offset: {
        type: "integer",
        description: "起始行号（从 1 开始），默认 1",
      },
      limit: {
        type: "integer",
        description: `本次读取的行数，默认 ${READ_DEFAULT_LIMIT}，最大 ${READ_MAX_LIMIT}`,
      },
    },
    additionalProperties: false,
  },
  run: (args, ctx) => {
    const elements = ctx.api.getSceneElements();
    const snapshot = ctx.scene.sync();
    ctx.session.expectedRev = snapshot.rev;
    const total = snapshot.lines.length;

    if (!total) {
      return {
        content: `${header(
          snapshot,
          elements,
          ctx,
        )}\n\n# 画布是空的，还没有任何元素。\n# 用 write_canvas 的 append 添加元素，例如：\n{"op":"append","lines":["{\\"type\\":\\"rectangle\\",\\"id\\":\\"r1\\",\\"x\\":0,\\"y\\":0,\\"width\\":200,\\"height\\":120,\\"backgroundColor\\":\\"#a5d8ff\\"}"]}`,
      };
    }

    const offset = clamp(asInt(args.offset, 1), 1, total);
    const limit = clamp(
      asInt(args.limit, READ_DEFAULT_LIMIT),
      1,
      READ_MAX_LIMIT,
    );
    const end = Math.min(total, offset + limit - 1);
    const body = snapshot.lines
      .slice(offset - 1, end)
      .map((line, index) => `L${offset + index}: ${line}`)
      .join("\n");

    const footer: string[] = [];
    if (end < total) {
      footer.push(
        `# 本次显示第 ${offset}-${end} 行 / 共 ${total} 行，还有 ${
          total - end
        } 行：用 offset=${end + 1} 继续读取。`,
      );
    } else if (offset > 1) {
      footer.push(
        `# 本次显示第 ${offset}-${end} 行 / 共 ${total} 行（已到末尾）。`,
      );
    }
    footer.push(
      "# 修改时请用 write_canvas 按行号改写，行内容只需包含要改的字段（按 id 合并）。",
    );

    return {
      content: `${header(snapshot, elements, ctx)}\n${footer.join(
        "\n",
      )}\n\n${body}`,
    };
  },
};

type SceneOperation = {
  op: "replace" | "delete" | "insert" | "append" | "replace_all";
  start?: number;
  end?: number;
  at?: number;
  lines?: string[];
};

const normalizeOperations = (
  raw: unknown,
  total: number,
): { ops: (SceneOperation & { position: number })[]; errors: string[] } => {
  const errors: string[] = [];
  if (!Array.isArray(raw) || !raw.length) {
    return {
      ops: [],
      errors: [
        "ops 必须是非空数组，每个操作形如 {op:'replace',start:3,end:5,lines:[...]}",
      ],
    };
  }

  const ops: (SceneOperation & { position: number })[] = [];

  for (const [index, item] of raw.entries()) {
    const op = item as SceneOperation;
    const label = `ops[${index}]`;
    if (!op || typeof op !== "object") {
      errors.push(`${label} 不是对象`);
      continue;
    }
    const lines = op.lines?.map((line) => String(line));

    switch (op.op) {
      case "replace_all": {
        if (!lines?.length) {
          errors.push(`${label}: replace_all 需要 lines`);
          continue;
        }
        if (raw.length > 1) {
          errors.push("replace_all 必须单独使用");
          continue;
        }
        ops.push({ ...op, lines, position: -1 });
        break;
      }
      case "replace": {
        const start = asInt(op.start, NaN);
        const end = asInt(op.end, start);
        if (!Number.isFinite(start) || start < 1 || start > total) {
          errors.push(`${label}: start 必须在 1..${total} 之间`);
          continue;
        }
        if (!Number.isFinite(end) || end < start || end > total) {
          errors.push(`${label}: end 必须在 ${start}..${total} 之间`);
          continue;
        }
        if (!lines?.length) {
          errors.push(`${label}: replace 需要 lines（要替换成的内容）`);
          continue;
        }
        ops.push({ ...op, start, end, lines, position: start });
        break;
      }
      case "delete": {
        const start = asInt(op.start, NaN);
        const end = asInt(op.end, start);
        if (!Number.isFinite(start) || start < 1 || start > total) {
          errors.push(`${label}: start 必须在 1..${total} 之间`);
          continue;
        }
        if (!Number.isFinite(end) || end < start || end > total) {
          errors.push(`${label}: end 必须在 ${start}..${total} 之间`);
          continue;
        }
        ops.push({ ...op, start, end, position: start, lines: [] });
        break;
      }
      case "insert": {
        const at = asInt(op.at, NaN);
        if (!Number.isFinite(at) || at < 1 || at > total + 1) {
          errors.push(`${label}: at 必须在 1..${total + 1} 之间`);
          continue;
        }
        if (!lines?.length) {
          errors.push(`${label}: insert 需要 lines`);
          continue;
        }
        ops.push({ ...op, at, lines, position: at + 0.5 });
        break;
      }
      case "append": {
        if (!lines?.length) {
          errors.push(`${label}: append 需要 lines`);
          continue;
        }
        ops.push({ ...op, lines, position: total + 0.5 });
        break;
      }
      default:
        errors.push(
          `${label}: 未知操作 "${
            (op as { op?: string }).op
          }"，可用 replace / delete / insert / append / replace_all`,
        );
    }
  }

  if (ops.filter((op) => op.op === "replace_all").length) {
    return { ops: ops.slice(0, 1), errors };
  }

  return { ops: ops.sort((a, b) => b.position - a.position), errors };
};

const describeChanges = (
  result: ReturnType<typeof applySceneLines>,
  finalLines: string[],
) =>
  [
    `已写入画布：更新 ${result.updated} 个，新增 ${result.added} 个，删除 ${result.deleted} 个，未变 ${result.unchanged} 个。`,
    `画布现有 ${finalLines.length} 个元素（共 ${finalLines.length} 行）。`,
  ].join("\n");

/**
 * Echoes the first changed window of the new line list so the model can verify
 * its edit without re-reading the whole canvas.
 */
const changedRegion = (before: string[], after: string[], max = 8) => {
  let first = 0;
  while (
    first < before.length &&
    first < after.length &&
    before[first] === after[first]
  ) {
    first++;
  }
  if (first >= after.length) {
    return "";
  }
  return after
    .slice(first, first + max)
    .map((line, index) => `L${first + index + 1}: ${stripLinePrefix(line)}`)
    .join("\n");
};

const writeCanvas: Tool = {
  name: "write_canvas",
  description:
    "按行修改白板。每个操作只影响指定的行，其它元素保持不变。" +
    "op 取值：replace（用 lines 替换 start..end 行）、delete（删除 start..end 行）、" +
    "insert（在第 at 行之前插入 lines）、append（在末尾追加 lines）、replace_all（整块重写，慎用）。" +
    "lines 里每行是一个元素的 JSON：已有元素写 id 即可（只写要改的字段，按 id 合并），新元素必须写 type（id 可省略，会自动生成）。" +
    "只要有任意一行 JSON 非法，本次写入整体不生效，画布不会变化。写入会合并成一次可撤销的操作。",
  parameters: {
    type: "object",
    properties: {
      ops: {
        type: "array",
        description: "行级操作列表，可一次提交多个",
        items: {
          type: "object",
          properties: {
            op: {
              type: "string",
              enum: ["replace", "delete", "insert", "append", "replace_all"],
            },
            start: {
              type: "integer",
              description: "replace/delete 的起始行号（1 起）",
            },
            end: {
              type: "integer",
              description: "replace/delete 的结束行号（含）",
            },
            at: {
              type: "integer",
              description: "insert 的插入位置（1 起，插在该行之前）",
            },
            lines: {
              type: "array",
              items: { type: "string" },
              description: "元素 JSON 行",
            },
          },
          required: ["op"],
        },
      },
    },
    required: ["ops"],
    additionalProperties: false,
  },
  run: (args, ctx) => {
    const readOnly = readOnlyReason(ctx);
    if (readOnly) {
      return { content: `未写入：${readOnly}`, isError: true };
    }
    const snapshot = ctx.scene.sync();
    const stale = staleRevision(ctx, snapshot);
    if (stale) {
      return { content: `未写入：${stale}`, isError: true };
    }
    const { ops, errors } = normalizeOperations(
      args.ops,
      snapshot.lines.length,
    );
    if (errors.length) {
      return {
        content: `未写入，参数有误：\n- ${errors.join("\n- ")}`,
        isError: true,
      };
    }
    if (!ops.length) {
      return { content: "未写入：ops 为空", isError: true };
    }

    let next = [...snapshot.lines];
    for (const op of ops) {
      switch (op.op) {
        case "replace_all":
          next = [...(op.lines ?? [])];
          break;
        case "append":
          next = [...next, ...(op.lines ?? [])];
          break;
        case "insert":
          next.splice((op.at ?? 1) - 1, 0, ...(op.lines ?? []));
          break;
        case "delete":
          next.splice(
            (op.start ?? 1) - 1,
            (op.end ?? op.start ?? 1) - (op.start ?? 1) + 1,
          );
          break;
        case "replace":
          next.splice(
            (op.start ?? 1) - 1,
            (op.end ?? op.start ?? 1) - (op.start ?? 1) + 1,
            ...(op.lines ?? []),
          );
          break;
      }
    }

    const invalid = next
      .map((line, index) => ({ index, parsed: parseAgentLine(line) }))
      .filter(({ parsed }) => parsed.error);
    if (invalid.length) {
      return {
        content: `未写入，内容有误：\n${invalid
          .slice(0, 5)
          .map(({ index, parsed }) => `- 第 ${index + 1} 行：${parsed.error}`)
          .join("\n")}`,
        isError: true,
      };
    }

    const preview = changedRegion(snapshot.lines, next);

    const result = applySceneLines(ctx.api, next);
    if (result.errors.length) {
      return {
        content: `未写入：\n- ${result.errors.slice(0, 5).join("\n- ")}`,
        isError: true,
      };
    }

    const finalSnapshot = ctx.scene.snapshot();
    ctx.session.expectedRev = finalSnapshot.rev;
    return {
      content: `${describeChanges(result, finalSnapshot.lines)}${
        preview ? `\n\n改动区域：\n${preview}` : ""
      }`,
    };
  },
};

const selectionLines = (
  ctx: ToolContext,
  ids: string[],
): { elements: ExcalidrawElement[]; missing: string[] } => {
  const elements = ctx.api.getSceneElements();
  const map = new Map(elements.map((element) => [element.id, element]));
  const found: ExcalidrawElement[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const element = map.get(id);
    if (element) {
      found.push(element);
    } else {
      missing.push(id);
    }
  }
  return { elements: found, missing };
};

const readSelection: Tool = {
  name: "read_selection",
  description:
    "读取用户当前选中的元素（局部内容）。会登记一个 selectionId 并记录这些元素的 id 与顺序，" +
    "之后用 replace_selection 精确替换这部分内容。用户说「这个/选中/它」时先用它。",
  parameters: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        description: `最多返回多少行，默认 ${READ_DEFAULT_LIMIT}，最大 ${READ_MAX_LIMIT}`,
      },
      offset: {
        type: "integer",
        description: "起始行号（选区内的行，从 1 开始）",
      },
    },
    additionalProperties: false,
  },
  run: (args, ctx) => {
    const ids = selectedIds(ctx);
    if (!ids.length) {
      return {
        content:
          "当前没有选中的元素。请让用户先在画布上选中要修改的内容，或者用 read_canvas 读取整个画布。",
        isError: true,
      };
    }

    const { elements, missing } = selectionLines(ctx, ids);
    if (!elements.length) {
      return {
        content: "选中的元素已不在画布上（可能已被删除），请让用户重新选择。",
        isError: true,
      };
    }

    const snapshot = ctx.scene.sync();
    ctx.session.expectedRev = snapshot.rev;
    const handle = ctx.selections.register(
      elements.map((element) => element.id),
      snapshot.rev,
    );

    const total = elements.length;
    const offset = clamp(asInt(args.offset, 1), 1, total);
    const limit = clamp(
      asInt(args.limit, READ_DEFAULT_LIMIT),
      1,
      READ_MAX_LIMIT,
    );
    const end = Math.min(total, offset + limit - 1);

    const lines = elements
      .slice(offset - 1, end)
      .map((element, index) => formatLine(offset + index, element));

    const notes = [
      `# 选区 ${handle.id}｜${total} 个元素（${typeStats(elements)}）`,
      `# 范围：${describeBounds(elements)}｜画布 rev=${snapshot.rev}（画布共 ${
        snapshot.lines.length
      } 个元素）`,
      `# 选区行号 L1..L${total} 只在选区内有效；替换时用 replace_selection(selectionId="${handle.id}")。`,
      `# 只替换其中一项时，其余元素原样回填；删除某项就是不返回它。`,
    ];
    if (missing.length) {
      notes.push(`# 注意：${missing.length} 个被选元素已不存在，已忽略。`);
    }

    return {
      content: `${notes.join("\n")}\n\n${lines.join("\n")}`,
    };
  },
};

const replaceSelection: Tool = {
  name: "replace_selection",
  description:
    "精确替换 read_selection 记录的那部分内容（按元素 id 定位，不影响画布其它区域）。" +
    "lines 是替换后的完整选区内容：只写要改的字段即可（按 id 合并），新元素要写 type（id 省略即新增），" +
    "不返回的原选区元素会被删除。任意一行非法则整次写入不生效。",
  parameters: {
    type: "object",
    properties: {
      selectionId: {
        type: "string",
        description: "read_selection 返回的 selectionId",
      },
      lines: {
        type: "array",
        items: { type: "string" },
        description: "替换后的选区元素 JSON 行",
      },
    },
    required: ["selectionId", "lines"],
    additionalProperties: false,
  },
  run: (args, ctx) => {
    const selectionId = String(args.selectionId ?? "");
    const handle: SelectionHandle | undefined = ctx.selections.get(selectionId);
    if (!handle) {
      return {
        content: `找不到选区 ${selectionId}，请先调用 read_selection 重新获取。`,
        isError: true,
      };
    }

    const rawLines = Array.isArray(args.lines) ? args.lines.map(String) : [];
    if (!rawLines.length) {
      return {
        content:
          "未写入：lines 为空。若要删除选区内容请用 write_canvas 的 delete 操作。",
        isError: true,
      };
    }

    const readOnly = readOnlyReason(ctx);
    if (readOnly) {
      return { content: `未写入：${readOnly}`, isError: true };
    }
    const snapshot = ctx.scene.sync();
    const stale = staleRevision(ctx, snapshot);
    if (stale) {
      return { content: `未写入：${stale}`, isError: true };
    }
    const indexById = new Map(snapshot.ids.map((id, index) => [id, index]));

    const positions = handle.ids.map((id) => indexById.get(id));
    if (positions.some((position) => position === undefined)) {
      return {
        content:
          "选区内容已变化（有元素被删除或改变了层级），请重新调用 read_selection。",
        isError: true,
      };
    }

    const handleSet = new Set(handle.ids);
    for (const [index, line] of rawLines.entries()) {
      const parsed = parseAgentLine(line);
      if (parsed.error) {
        return {
          content: `未写入：第 ${index + 1} 行 ${parsed.error}`,
          isError: true,
        };
      }
      if (parsed.id && !handleSet.has(parsed.id) && indexById.has(parsed.id)) {
        return {
          content: `未写入：元素 ${parsed.id} 不在当前选区内，replace_selection 只能修改选区内的元素。`,
          isError: true,
        };
      }
    }

    const sortedPositions = (positions as number[])
      .slice()
      .sort((a, b) => a - b);
    const insertAt = sortedPositions[0];
    const kept = snapshot.lines.filter(
      (_line, index) => !sortedPositions.includes(index),
    );
    const next = [
      ...kept.slice(0, insertAt),
      ...rawLines,
      ...kept.slice(insertAt),
    ];

    const result = applySceneLines(ctx.api, next);
    if (result.errors.length) {
      return {
        content: `未写入：\n- ${result.errors.slice(0, 5).join("\n- ")}`,
        isError: true,
      };
    }

    const newIds = rawLines
      .map((line) => parseAgentLine(line).id)
      .filter((id): id is string => !!id);
    if (newIds.length) {
      ctx.api.updateScene({
        appState: {
          selectedElementIds: newIds.reduce(
            (acc, id) => ({ ...acc, [id]: true }),
            {} as Record<string, true>,
          ),
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }

    const finalSnapshot = ctx.scene.snapshot();
    ctx.session.expectedRev = finalSnapshot.rev;
    return {
      content: `${describeChanges(result, finalSnapshot.lines)}\n选区 ${
        handle.id
      } 已更新（${rawLines.length} 个元素）。`,
    };
  },
};

/**
 * Renders a Mermaid definition into native elements.
 *
 * Mermaid is a much better fit than raw element lines for "draw me a whole
 * diagram": the model writes six lines of Mermaid instead of a hundred lines of
 * element JSON, and the layout comes out tidy.
 */
const insertDiagram: Tool = {
  name: "insert_diagram",
  description:
    "把一段 Mermaid 图渲染成原生画布元素并插入画布。用于「从零画一张流程图、架构图、时序图、状态图」。比用 write_canvas 逐行拼元素更省 token、排版更整齐；已有的元素不会被动到（追加而不是替换）。插入后可以用 line 号继续用 write_canvas 微调。",
  parameters: {
    type: "object",
    properties: {
      mermaid: {
        type: "string",
        description:
          "Mermaid 定义本身，不要包 ```mermaid 代码块。例如：flowchart LR; A[接入层] --> B[服务层]",
      },
      x: {
        type: "number",
        description: "左上角 x 坐标，省略时放到现有内容的右侧",
      },
      y: {
        type: "number",
        description: "左上角 y 坐标，省略时与现有内容顶部对齐",
      },
    },
    required: ["mermaid"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const readOnly = readOnlyReason(ctx);
    if (readOnly) {
      return { content: `未插入：${readOnly}`, isError: true };
    }
    const definition =
      typeof args.mermaid === "string" ? args.mermaid.trim() : "";
    if (!definition) {
      return { content: "未插入：mermaid 为空", isError: true };
    }

    let skeleton;
    try {
      // mermaid is a heavy dependency: keep it out of the main bundle
      const { parseMermaidToExcalidraw } = await import(
        "@excalidraw/mermaid-to-excalidraw"
      );
      skeleton = await parseMermaidToExcalidraw(definition);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        content: `未插入，Mermaid 解析失败：\n${detail.slice(0, 800)}`,
        isError: true,
      };
    }

    const converted = convertToExcalidrawElements(skeleton.elements ?? [], {
      regenerateIds: true,
    });
    if (!converted.length) {
      return {
        content: "未插入：这段 Mermaid 没有生成任何元素",
        isError: true,
      };
    }

    const { getSceneElements, getSceneElementsIncludingDeleted } = ctx.api;
    const live = getSceneElementsIncludingDeleted();
    const existing = getSceneElements();

    const anchorX = Math.min(...converted.map((element) => element.x));
    const anchorY = Math.min(...converted.map((element) => element.y));

    // Empty canvas: drop the diagram where the user is looking, otherwise it
    // lands on the origin and may be outside the viewport entirely.
    // Non-empty canvas: to the right of the existing content.
    const box = bounds(existing);
    let targetX = 0;
    let targetY = 0;
    if (box) {
      targetX = box.maxX + 100;
      targetY = box.minY;
    } else {
      try {
        const appState = ctx.api.getAppState();
        const topLeft = viewportCoordsToSceneCoords(
          { clientX: 0, clientY: 0 },
          appState,
        );
        targetX = topLeft.x + 60 / (appState.zoom?.value || 1);
        targetY = topLeft.y + 60 / (appState.zoom?.value || 1);
      } catch {
        targetX = 0;
        targetY = 0;
      }
    }

    const offsetX =
      typeof args.x === "number" ? args.x - anchorX : targetX - anchorX;
    const offsetY =
      typeof args.y === "number" ? args.y - anchorY : targetY - anchorY;

    const placed = converted.map((element) =>
      offsetX || offsetY
        ? { ...element, x: element.x + offsetX, y: element.y + offsetY }
        : element,
    );

    ctx.api.updateScene({
      elements: [...live, ...placed],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    const snapshot = ctx.scene.sync();
    ctx.session.expectedRev = snapshot.rev;

    const placedBox = bounds(placed);
    return {
      content: [
        `已插入 ${placed.length} 个元素（${typeStats(placed)}）。`,
        placedBox
          ? `位置：x ${placedBox.minX}..${placedBox.maxX}, y ${
              placedBox.minY
            }..${placedBox.maxY}（宽 ${placedBox.maxX - placedBox.minX}，高 ${
              placedBox.maxY - placedBox.minY
            }）`
          : "",
        `画布现在共 ${snapshot.lines.length} 个元素（第 ${
          snapshot.lines.length - placed.length + 1
        }..${snapshot.lines.length} 行是新插入的）。`,
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
};

/**
 * "今天几号" is not a canvas question, but a diagram often needs a date
 * ("排期从下周一开始"), and the model has no clock. Cheaper and more honest
 * than asking the user to retype it.
 */
const currentDatetime: Tool = {
  name: "get_current_datetime",
  description:
    "获取用户本机的当前日期与时间（含时区、星期），例如「今天是几号」「下周三是什么日期」" +
    "「把日期写进图里」时先调用它。不要凭记忆猜日期。",
  parameters: {
    type: "object",
    properties: {
      timezone: {
        type: "string",
        description:
          "IANA 时区名，如 Asia/Shanghai。不传则用用户浏览器的本地时区",
      },
    },
    additionalProperties: false,
  },
  run: (args) => {
    const now = new Date();
    const fallbackZone =
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const zone =
      typeof args.timezone === "string" && args.timezone.trim()
        ? args.timezone.trim()
        : fallbackZone;

    const format = (
      options: Intl.DateTimeFormatOptions,
      locale = "zh-CN",
    ): string | null => {
      try {
        return new Intl.DateTimeFormat(locale, {
          ...options,
          timeZone: zone,
        }).format(now);
      } catch {
        return null;
      }
    };

    const date = format({
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const time = format({
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const weekday = format({ weekday: "long" });
    const isoDate = format(
      { year: "numeric", month: "2-digit", day: "2-digit" },
      "en-CA",
    );

    if (!date || !time) {
      return {
        content: `无法解析时区 ${zone}。可用的本地时区是 ${fallbackZone}；请改用该时区重试。`,
        isError: true,
      };
    }

    // weekday in English too: the model reasons about "next Wednesday" more
    // reliably when it is not translating on the fly
    const weekdayEn = format({ weekday: "long" }, "en-US");
    const offsetMinutes = -now.getTimezoneOffset();

    return {
      content: [
        `日期：${isoDate}（${weekday} / ${weekdayEn}）`,
        `时间：${time}`,
        `时区：${zone}`,
        `ISO 8601：${now.toISOString()}`,
        `UTC 偏移：UTC${offsetMinutes >= 0 ? "+" : "-"}${String(
          Math.floor(Math.abs(offsetMinutes) / 60),
        ).padStart(2, "0")}:${String(Math.abs(offsetMinutes) % 60).padStart(
          2,
          "0",
        )}`,
      ].join("\n"),
    };
  },
};

export const canvasTools: Tool[] = [
  readCanvas,
  currentDatetime,
  writeCanvas,
  insertDiagram,
  readSelection,
  replaceSelection,
];
