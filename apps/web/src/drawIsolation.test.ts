import {
  clippingPath,
  createDocument,
  createNodes,
  type Document,
  makeMask,
  type NodeInput,
} from "@zibel/core";
import type { ServerMessage } from "@zibel/sync";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drawPending } from "./canvas.ts";
import { curvatureDown, curvatureUp } from "./curvature.ts";
import { DEFAULT_PENCIL, pencilDown, pencilMove, pencilUp, savePencilOptions } from "./pencil.ts";
import { receive } from "./receive.ts";
import {
  arcTool,
  ellipseTool,
  lineTool,
  polarGridTool,
  polygonTool,
  rectangleTool,
  rectangularGridTool,
  roundedRectangleTool,
  spiralTool,
  starTool,
} from "./shapeTool.ts";
import { connect, DEFAULT_FILL_STROKE, send, useStore } from "./store.ts";
import type { CanvasTool, ToolEvent } from "./toolbox.ts";
import { finishPen, penDown, penUp } from "./tools.ts";

vi.mock("./store.ts", async (original) => ({
  ...(await original<typeof import("./store.ts")>()),
  send: vi.fn(),
}));

type Point = [number, number];

/** A Rect isolated in a Group in the default Layer, with another Rect selected (ADR-0058). */
function isolateLeaf(scope: "leaf" | "group" = "leaf") {
  const { doc, defaultLayerId: layer } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100 }],
  });
  const rect = (clientKey: string) =>
    ({ type: "rect", clientKey, x: 0, y: 0, width: 10, height: 10 }) as const;
  const { keyMap } = createNodes(doc, [
    { type: "group", clientKey: "g", parentId: layer, children: [rect("leaf")] },
    { ...rect("other"), parentId: layer },
  ]);
  const id = (key: string) => keyMap[key] as string;
  const view = { isolated: id(scope === "leaf" ? "leaf" : "g"), selection: [id("other")] };
  useStore.setState({
    doc,
    pen: null,
    pending: [],
    edit: null,
    drag: null,
    opPreview: null,
    anchors: [],
    segments: [],
    notice: null,
    fillStroke: DEFAULT_FILL_STROKE,
    ...view,
  });
  return { ...view, id };
}

const view = () => {
  const { isolated, selection } = useStore.getState();
  return { isolated, selection };
};
const deliver = (msg: ServerMessage) => {
  const next = receive(useStore.getState(), msg, "d");
  if (!next) throw new Error("missed rev");
  useStore.setState(next);
};
/** The command sent as `id`, or the last one sent, and its id. */
function sent(id?: string) {
  const { calls, results } = vi.mocked(send).mock;
  const i = id ? results.findIndex((r) => r.value === id) : calls.length - 1;
  return { command: calls[i]?.[0], commandId: results[i]?.value as string };
}
/** The Worker creating the `create` sent as `id`, or the last one: its `tx`, with the new path's id. */
function accept(id?: string): string {
  const { command, commandId } = sent(id);
  if (command?.type !== "create") throw new Error("no create");
  const doc = structuredClone(useStore.getState().doc) as Document;
  const { nodes } = createNodes(doc, command.nodes as NodeInput[]);
  deliver({
    type: "tx",
    rev: doc.rev + 1,
    txId: "t",
    actor: "user",
    intent: null,
    created: nodes,
    updated: [],
    deletedIds: [],
    commandId,
  });
  return nodes[0]?.id as string;
}
const reject = (id?: string) =>
  deliver({
    type: "rejected",
    id: sent(id).commandId,
    error: { code: "PERMISSION_DENIED", message: "Viewers cannot edit." },
  } as ServerMessage);
/** The Document a reconnect sends: a command dropped while the socket was down never arrived. */
const reconnect = () => {
  const doc = useStore.getState().doc as Document;
  deliver({
    type: "document",
    rev: doc.rev + 1,
    name: doc.name,
    artboards: doc.artboards,
    nodes: [...doc.nodes.values()],
    role: "editor",
  } as ServerMessage);
};

const drawPen = () => {
  for (const p of [[50, 50] as Point, [80, 60] as Point]) {
    penDown(p, 1);
    penUp();
  }
  finishPen();
};
const drawCurve = () => {
  for (const p of [[50, 50] as Point, [80, 60] as Point, [90, 90] as Point]) {
    vi.advanceTimersByTime(1000);
    curvatureDown(p, 1, false);
    curvatureUp();
  }
  finishPen();
};
const drawPencil = (keep = true) => {
  savePencilOptions({ ...DEFAULT_PENCIL, keepSelected: keep });
  pencilDown([50, 50]);
  for (let x = 51; x <= 120; x++)
    pencilMove([[x, 50 + ((x * 7) % 5)]], { shift: false, alt: false });
  pencilUp(1);
};
/** A drag with a shape tool, at scale 1. */
const drawShape = (tool: CanvasTool) => () => {
  const at = (x: number, y: number) =>
    ({
      x,
      y,
      points: [[x, y]],
      shift: false,
      alt: false,
      space: false,
      viewport: { scale: 1 },
      capture() {},
      redraw() {},
    }) as unknown as ToolEvent;
  tool.down(at(50, 50));
  tool.move?.(at(80, 60));
  tool.up?.(at(80, 60));
};
const tools: [string, () => void][] = [
  ["Pen", drawPen],
  ["Curvature", drawCurve],
  ["Pencil", drawPencil],
  ["Rectangle", drawShape(rectangleTool)],
  ["Rounded Rectangle", drawShape(roundedRectangleTool)],
  ["Ellipse", drawShape(ellipseTool)],
  ["Polygon", drawShape(polygonTool)],
  ["Star", drawShape(starTool)],
  ["Line Segment", drawShape(lineTool)],
  ["Arc", drawShape(arcTool)],
  ["Spiral", drawShape(spiralTool)],
  ["Rectangular Grid", drawShape(rectangularGridTool)],
  ["Polar Grid", drawShape(polarGridTool)],
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.advanceTimersByTime(1000);
  savePencilOptions(DEFAULT_PENCIL);
  let n = 0;
  vi.mocked(send)
    .mockReset()
    .mockImplementation(() => `c${++n}`);
});

describe.each(tools)("the %s with a leaf isolated (ADR-0058, #137)", (_, draw) => {
  it("sends the path into the leaf's parent and changes nothing while it is in flight", () => {
    const before = isolateLeaf();
    draw();
    const [command] = vi.mocked(send).mock.lastCall ?? [];
    expect(command).toMatchObject({ type: "create", nodes: [{ parentId: before.id("g") }] });
    expect(view()).toEqual({ isolated: before.isolated, selection: before.selection });
  });

  it("goes up one level and selects the path once the Worker creates it", () => {
    const { id } = isolateLeaf();
    draw();
    const path = accept();
    expect(view()).toEqual({ isolated: id("g"), selection: [path] });
    expect(useStore.getState().pending).toEqual([]);
  });

  it("leaves the Isolation and Selection alone when the create is rejected, and says why", () => {
    const before = isolateLeaf();
    draw();
    reject();
    expect(view()).toEqual({ isolated: before.isolated, selection: before.selection });
    expect(useStore.getState()).toMatchObject({ pending: [], notice: "Viewers cannot edit." });
  });

  it("leaves them alone when the command was dropped and the reconnect's Document arrives", () => {
    const before = isolateLeaf();
    draw();
    reconnect();
    expect(view()).toEqual({ isolated: before.isolated, selection: before.selection });
    expect(useStore.getState().pending).toEqual([]);
  });

  it("keeps an Isolation an Esc changed while the create was in flight", () => {
    const { id } = isolateLeaf();
    draw();
    useStore.setState({ isolated: null, selection: [id("g")] });
    const path = accept();
    expect(view()).toEqual({ isolated: null, selection: [path] });
  });

  it("keeps a Group scope, as without a leaf", () => {
    const before = isolateLeaf("group");
    draw();
    const [command] = vi.mocked(send).mock.lastCall ?? [];
    expect(command).toMatchObject({ nodes: [{ parentId: before.id("g") }] });
    const path = accept();
    expect(view()).toEqual({ isolated: before.id("g"), selection: [path] });
  });
});

it("a Rectangular Grid drawn in an isolated Clip Group is clipped, and selected as one Group", () => {
  const { doc, defaultLayerId: layer } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100 }],
  });
  const rect = (clientKey: string, width: number) =>
    ({ type: "rect", clientKey, parentId: layer, x: 0, y: 0, width, height: width }) as const;
  const { keyMap } = createNodes(doc, [rect("content", 10), rect("clip", 60)]);
  const { group } = makeMask(doc, {
    clipNodeId: keyMap.clip as string,
    contentIds: [keyMap.content as string],
  });
  useStore.setState({ doc, isolated: group.id, selection: [], pending: [] });
  drawShape(rectangularGridTool)();
  const grid = accept();
  const after = useStore.getState().doc as Document;
  // Above the Clipping Path, in its Clip Group: clipped by it.
  expect(after.nodes.get(grid)).toMatchObject({ type: "group", parentId: group.id });
  expect(clippingPath(after, group)?.id).toBe(keyMap.clip);
  expect(view()).toEqual({ isolated: group.id, selection: [grid] });
});

it("the Pencil with Keep selected off goes up and selects nothing", () => {
  const { id } = isolateLeaf();
  drawPencil(false);
  accept();
  expect(view()).toEqual({ isolated: id("g"), selection: [] });
});

it("a prune by another Actor's tx while the create is in flight wins", () => {
  const { id } = isolateLeaf();
  drawPen();
  const doc = useStore.getState().doc as Document;
  const leaf = doc.nodes.get(id("leaf"));
  // Another Actor makes the leaf a Clipping Path: it can no longer be isolated.
  deliver({
    type: "tx",
    rev: doc.rev + 1,
    txId: "other",
    actor: "agent",
    intent: null,
    created: [],
    updated: [{ ...leaf, clipping: true } as never],
    deletedIds: [],
  });
  expect(useStore.getState().isolated).toBe(id("g"));
  const path = accept();
  expect(view()).toEqual({ isolated: id("g"), selection: [path] });
});

it("a tab switched away while the create is in flight keeps the leaf isolated on return", () => {
  const before = isolateLeaf();
  const doc = useStore.getState().doc as Document;
  let socket: { onmessage?: (e: { data: string }) => void } | undefined;
  vi.stubGlobal("location", { protocol: "http:", host: "x" });
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 1;
      onmessage?: (e: { data: string }) => void;
      constructor() {
        socket = this;
      }
      close() {}
    },
  );
  const disconnect = connect("d");
  useStore.setState({ isolated: before.isolated, selection: before.selection });
  const nodes = [...doc.nodes.values()];
  const { rev, name, artboards } = doc;
  socket?.onmessage?.({
    data: JSON.stringify({ type: "document", rev, name, artboards, nodes, role: "editor" }),
  });
  drawPen();
  // The Viewer's cleanup: the answer to the create is lost with the socket.
  disconnect();
  connect("d")();
  expect(view()).toEqual({ isolated: before.isolated, selection: before.selection });
  vi.unstubAllGlobals();
});

describe.each(tools)("the %s, then a Rectangle, both in flight from a leaf (#141)", (_, draw) => {
  const drawBoth = () => {
    const { id } = isolateLeaf();
    draw();
    drawShape(rectangleTool)();
    // Both are previewed, each until its own answer.
    expect(useStore.getState().pending.map((p) => p.commandId)).toEqual(["c1", "c2"]);
    return id;
  };

  it("each tx selects its own Node, and the Isolation ends one level up", () => {
    const id = drawBoth();
    const first = accept("c1");
    expect(view()).toEqual({ isolated: id("g"), selection: [first] });
    expect(useStore.getState().pending.map((p) => p.commandId)).toEqual(["c2"]);
    const second = accept("c2");
    expect(view()).toEqual({ isolated: id("g"), selection: [second] });
    expect(useStore.getState().pending).toEqual([]);
  });

  it("the first accepted and the second rejected: the first is selected, one level up", () => {
    const id = drawBoth();
    const first = accept("c1");
    reject("c2");
    expect(view()).toEqual({ isolated: id("g"), selection: [first] });
    expect(useStore.getState()).toMatchObject({ pending: [], notice: "Viewers cannot edit." });
  });

  it("the first rejected and the second accepted: the second is selected, one level up", () => {
    const id = drawBoth();
    reject("c1");
    const second = accept("c2");
    expect(view()).toEqual({ isolated: id("g"), selection: [second] });
  });

  it("a reconnect drops both and leaves the Isolation and Selection alone", () => {
    drawBoth();
    const before = view();
    reconnect();
    expect(view()).toEqual(before);
    expect(useStore.getState().pending).toEqual([]);
  });
});

it.each([
  [
    "Pen",
    drawPen,
    () => {
      penDown([10, 10], 1);
      penUp();
    },
  ],
  [
    "Curvature",
    drawCurve,
    () => {
      vi.advanceTimersByTime(1000);
      curvatureDown([150, 80], 1, false);
      curvatureUp();
    },
  ],
] as const)(
  "a %s path started while an earlier one is in flight is not ended by the earlier tx",
  (_, draw, start) => {
    isolateLeaf("group");
    draw();
    start();
    const pen = useStore.getState().pen;
    expect(pen?.anchors).toHaveLength(1);
    expect(useStore.getState().pending).toHaveLength(1);
    accept("c1");
    expect(useStore.getState()).toMatchObject({ pen, pending: [] });
  },
);

it("the last drawn object decides the Selection, a Pencil with Keep selected off none", () => {
  isolateLeaf("group");
  drawPencil(false);
  drawPen();
  accept("c1");
  const path = accept("c2");
  expect(view().selection).toEqual([path]);
  isolateLeaf("group");
  drawPen();
  drawPencil(false);
  accept("c3");
  accept("c4");
  expect(view().selection).toEqual([]);
});

it("previews a create in flight in the Fill it was sent with", () => {
  isolateLeaf("group");
  useStore.setState({ fillStroke: { fill: "#FF0000", stroke: null, active: "fill" } });
  drawShape(ellipseTool)();
  useStore.setState({ fillStroke: { fill: "#00FF00", stroke: null, active: "fill" } });
  vi.stubGlobal("Path2D", class {});
  const fills: unknown[] = [];
  const ctx = {
    fillStyle: "",
    fill() {
      fills.push(ctx.fillStyle);
    },
    stroke() {},
  };
  drawPending(ctx as unknown as CanvasRenderingContext2D, useStore.getState().pending, 1);
  expect(fills).toEqual(["#FF0000"]);
  vi.unstubAllGlobals();
});
