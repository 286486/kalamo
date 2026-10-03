import {
  type BareAnchor,
  createDocument,
  createNodes,
  type Document,
  editPath,
  type PathNode,
  parsePath,
  pathOp,
  runsClockwise,
  toAnchors,
} from "@kalamo/core";
import { beforeEach, expect, it, vi } from "vitest";
import { setDirection } from "./attributes.ts";
import { pencilDown, pencilMove, pencilUp } from "./pencil.ts";
import { previewAll, previewsOf } from "./receive.ts";
import {
  afterRenumbering,
  DEFAULT_FILL_STROKE,
  drawSent,
  record,
  runHeld,
  send,
  unheld,
  useStore,
} from "./store.ts";
import { message, recordAs, stateAfter } from "./testing.ts";
import { TOOL_KEYS } from "./toolbox.ts";
import {
  fillStrokeKey,
  finishPen,
  newArtNode,
  pathD,
  penDown,
  penDrag,
  penUp,
  setTool,
  undoAnchor,
} from "./tools.ts";

vi.mock("./store.ts", async (original) => ({
  ...(await original<typeof import("./store.ts")>()),
  send: vi.fn(() => "sent"),
}));

type Point = [number, number];
const penClick = (p: Point, tolerance: number, shift = false) => {
  penDown(p, tolerance, shift);
  penUp();
};
const NONE = { shift: false, alt: false, ctrl: false, space: false };
/** A press at `from` dragged through `to`, each with its modifiers, then released. */
const penDragged = (from: Point, ...to: [Point, Partial<typeof NONE>?][]) => {
  penDown(from, 1);
  for (const [p, mods] of to) penDrag(p, { ...NONE, ...mods });
  penUp();
};
const corner = (x: number, y: number): BareAnchor => ({
  anchor: [x, y],
  handleIn: null,
  handleOut: null,
});
const anchors = () => useStore.getState().pen?.anchors;
/** The path the last `create` sent, drawn until its answer. */
const sentPath = () => {
  const node = useStore.getState().pending.at(-1)?.nodes[0] as { d: string } | undefined;
  return node && toAnchors(parsePath(node.d, "d"))[0];
};
/** The type core derives for an Anchor but the last, whose outgoing Handle `d` leaves out. */
const typeAt = (i: number) => {
  const pen = useStore.getState().pen;
  if (!pen) throw new Error("no path");
  const node = newArtNode(
    { doc, selection: [], isolated: null, fillStroke: DEFAULT_FILL_STROKE },
    { type: "path", d: pathD(pen.anchors, pen.closed) },
  );
  if (node?.type !== "path") throw new Error("no path");
  return toAnchors(parsePath(node.d, "d"))[0]?.anchors[i]?.type;
};

const { doc, defaultLayerId } = createDocument({
  id: "d",
  name: "Doc",
  artboards: [{ width: 100, height: 100 }],
});

beforeEach(() => {
  useStore.setState({
    doc,
    selection: [],
    pen: null,
    pending: [],
    tool: "pen",
    front: {},
    fillStroke: DEFAULT_FILL_STROKE,
  });
  vi.mocked(send).mockClear();
});

const pen = () => useStore.getState().pen;

it("D resets, X toggles the active box, Shift+X swaps and / sets the active box to None", () => {
  const p = { fill: "#FF0000", stroke: null, active: "stroke" as const };
  expect(fillStrokeKey(p, "D")).toEqual({ fill: "#FFFFFF", stroke: "#000000", active: "stroke" });
  expect(fillStrokeKey(p, "X")).toEqual({ ...p, active: "fill" });
  expect(fillStrokeKey(p, "Shift+X")).toEqual({ ...p, fill: null, stroke: "#FF0000" });
  expect(fillStrokeKey(DEFAULT_FILL_STROKE, "/")).toEqual({ ...DEFAULT_FILL_STROKE, fill: null });
  expect(fillStrokeKey(p, "Q")).toBeNull();
});

it("Enter sends three Corner Anchors as one open path with the current Fill and Stroke", () => {
  useStore.setState({ fillStroke: { fill: null, stroke: "#FF0000", active: "fill" } });
  for (const p of [
    [0, 0],
    [10, 0],
    [5, 8],
  ] as [number, number][])
    penClick(p, 1);
  finishPen();
  expect(sentPath()).toMatchObject({ closed: false });
  // The next click starts another path; the sent one waits for its answer in receive.
  penClick([50, 50], 1);
  expect(pen()).toEqual({ anchors: [corner(50, 50)], closed: false });
  expect(useStore.getState().pending).toHaveLength(1);
});

it("builds the create input from the path, the current fillStroke and placeParent's Layer", () => {
  const s = { doc, selection: [], isolated: null, fillStroke: DEFAULT_FILL_STROKE };
  expect(
    newArtNode(s, {
      type: "path",
      d: pathD([corner(0, 0), corner(10, 0), corner(5, 8)], true),
    }),
  ).toEqual({
    type: "path",
    parentId: defaultLayerId,
    d: "M 0 0 L 10 0 L 5 8 Z",
    appearance: {
      fills: [{ color: "#FFFFFF" }],
      strokes: [{ color: "#000000", width: 1 }],
    },
  });
});

it("a click on the first Anchor closes the path", () => {
  penClick([0, 0], 1);
  penClick([2, 2], 1); // Not closing: a path needs two Anchors first.
  penClick([10, 0], 1);
  penClick([0.5, -0.5], 1);
  expect(pen()).toBeNull();
  expect(sentPath()).toMatchObject({
    anchors: [{ anchor: [0, 0] }, { anchor: [2, 2] }, { anchor: [10, 0] }],
    closed: true,
  });
});

it("Ctrl+Z removes the last Anchor and sends nothing", () => {
  penClick([0, 0], 1);
  penClick([10, 0], 1);
  expect(undoAnchor()).toBe(true);
  expect(pen()).toEqual({ anchors: [corner(0, 0)], closed: false });
  expect(undoAnchor()).toBe(true);
  expect(pen()).toBeNull();
  expect(undoAnchor()).toBe(false);
});

it("a tool switch finishes the path, and a single Anchor is dropped", () => {
  penClick([0, 0], 1);
  penClick([10, 0], 1);
  setTool("selection");
  expect(pen()).toBeNull();
  expect(useStore.getState().pending).toHaveLength(1);
  expect(useStore.getState().tool).toBe("selection");
  penClick([0, 0], 1);
  finishPen();
  expect(pen()).toBeNull();
});

it("a tool's shortcut or button brings it to the front of its group, and keeps the others'", () => {
  setTool(TOOL_KEYS.L ?? "selection");
  expect(useStore.getState()).toMatchObject({ tool: "ellipse", front: { rectangle: "ellipse" } });
  setTool(TOOL_KEYS["Shift+C"] ?? "selection");
  setTool("zoom");
  expect(useStore.getState()).toMatchObject({
    tool: "zoom",
    front: { rectangle: "ellipse", pen: "anchorPoint" },
  });
  setTool(TOOL_KEYS.M ?? "selection");
  expect(useStore.getState().front).toEqual({ rectangle: "rectangle", pen: "anchorPoint" });
});

it("draws nothing into a hidden or locked Layer, and says why", () => {
  const layer = doc.nodes.get(defaultLayerId);
  if (!layer) throw new Error("no Layer");
  const nodes = new Map(doc.nodes).set(defaultLayerId, { ...layer, locked: true });
  useStore.setState({ doc: { ...doc, nodes }, notice: null });
  penClick([0, 0], 1);
  penClick([10, 0], 1);
  finishPen();
  expect(pen()).toBeNull();
  expect(useStore.getState().notice).toMatch(/locked/);
});

it("Shift-click constrains the segment to a multiple of 45°", () => {
  penClick([0, 0], 1);
  penClick([10, 9], 1, true);
  expect(anchors()?.[1]?.anchor).toEqual([9.5, 9.5]);
});

it("a drag places a Smooth Anchor whose Handles mirror each other", () => {
  penClick([0, 0], 1);
  penDragged([10, 0], [[15, 5]]);
  expect(anchors()?.[1]).toEqual({ anchor: [10, 0], handleIn: [5, -5], handleOut: [15, 5] });
  penClick([40, 40], 1);
  expect(typeAt(1)).toBe("smooth");
});

it("Alt while dragging leaves the incoming Handle behind: a Corner (cusp)", () => {
  penClick([0, 0], 1);
  // Released before the button, as Illustrator documents it, Alt leaves the Handles broken.
  penDragged([10, 0], [[15, 5]], [[10, 10], { alt: true }], [[10, 12]]);
  expect(anchors()?.[1]).toEqual({ anchor: [10, 0], handleIn: [5, -5], handleOut: [10, 12] });
  penClick([40, 40], 1);
  expect(typeAt(1)).toBe("corner");
});

it("Ctrl while dragging keeps the Handles collinear and the incoming one's length", () => {
  penClick([0, 0], 1);
  penDragged([10, 0], [[15, 0]], [[30, 0], { ctrl: true }]);
  expect(anchors()?.[1]).toEqual({ anchor: [10, 0], handleIn: [5, 0], handleOut: [30, 0] });
  penClick([40, 40], 1);
  expect(typeAt(1)).toBe("smooth");
});

it("Shift while dragging constrains the Handle to a multiple of 45°", () => {
  penDragged([0, 0], [[10, 1], { shift: true }]);
  expect(anchors()?.[0]).toEqual({ anchor: [0, 0], handleIn: [-10, 0], handleOut: [10, 0] });
});

it("Space while the button is down moves the Anchor with its Handles", () => {
  penClick([0, 0], 1);
  penDragged([10, 0], [[15, 5]], [[20, 5], { space: true }], [[25, 5]]);
  expect(anchors()?.[1]).toEqual({ anchor: [15, 0], handleIn: [5, -5], handleOut: [25, 5] });
});

it("a click on the last Anchor removes its outgoing Handle, and a drag pulls a new one", () => {
  penClick([0, 0], 1);
  penDragged([10, 0], [[15, 5]]);
  penClick([10, 0], 1);
  expect(anchors()).toEqual([corner(0, 0), { ...corner(10, 0), handleIn: [5, -5] }]);
  penDragged([10, 0], [[10, 10]]);
  expect(anchors()?.[1]).toEqual({ anchor: [10, 0], handleIn: [5, -5], handleOut: [10, 10] });
});

it("closing on the first Anchor with a drag shapes the closing segment", () => {
  penClick([0, 0], 1);
  penClick([10, 0], 1);
  penClick([5, 8], 1);
  penDown([0, 0], 1);
  penDrag([-5, 5], NONE);
  expect(useStore.getState().pending).toEqual([]);
  penUp();
  expect(sentPath()).toMatchObject({
    anchors: [{ anchor: [0, 0], handleIn: [5, -5], handleOut: [-5, 5] }, {}, {}],
    closed: true,
  });
});

it("Alt while closing keeps the first segment and shapes only the closing one", () => {
  penDragged([0, 0], [[5, -5]]);
  penClick([10, 0], 1);
  penDragged([0, 0], [[-5, 0], { alt: true }]);
  expect(sentPath()?.anchors[0]).toMatchObject({
    anchor: [0, 0],
    handleIn: [5, 0],
    handleOut: [5, -5],
  });
});

it("a path of Smooth Anchors commits as C segments in one Transaction", () => {
  penDragged([0, 0], [[5, -5]]);
  penDragged([20, 0], [[25, 5]]);
  penDragged([40, 0], [[45, -5]]);
  finishPen();
  expect(send).toHaveBeenCalledTimes(1);
  expect(vi.mocked(send).mock.calls[0]?.[0]).toMatchObject({
    type: "create",
    nodes: [{ d: "M 0 0 C 5 -5 15 -5 20 0 C 25 5 35 5 40 0" }],
  });
});

/** Two open lines, (0, 0) to (10, 0) and (30, 0) to (40, 0), and a selected closed triangle. */
function paths() {
  const { doc: d, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 100, height: 100 }],
  });
  const [a, b, tri] = createNodes(d, [
    { type: "path", parentId, d: "M 0 0 L 10 0" },
    { type: "path", parentId, d: "M 30 0 L 40 0" },
    { type: "path", parentId, d: "M 0 50 L 20 50 L 10 70 Z" },
  ]).nodes.map((n) => n.id) as [string, string, string];
  useStore.setState({ doc: d, selection: [tri] });
  return { d, a, b, tri };
}
const sent = () => vi.mocked(send).mock.calls.map(([c]) => c);
const dOf = (d: Document, id: string) => (d.nodes.get(id) as { d: string }).d;

it("continuing an open path from its Endpoint and pressing Enter sends one path_edit", () => {
  const { a } = paths();
  penClick([10, 0], 1);
  penClick([20, 10], 1);
  finishPen();
  expect(sent()).toEqual([
    { type: "path_edit", input: { nodeId: a, ops: [{ op: "set_d", d: "M 0 0 L 10 0 L 20 10" }] } },
  ]);
  expect(pen()).toBeNull();
  expect(useStore.getState().selection).toEqual([a]);
});

it("continuing from the first Endpoint keeps the path's direction; Ctrl+Z stops at its own Anchors", () => {
  const { a } = paths();
  penClick([0, 0], 1);
  penClick([-10, 5], 1);
  expect(undoAnchor()).toBe(true);
  expect(pen()?.anchors).toHaveLength(2);
  penClick([-10, 5], 1);
  finishPen();
  expect(sent()).toEqual([
    { type: "path_edit", input: { nodeId: a, ops: [{ op: "set_d", d: "M -10 5 L 0 0 L 10 0" }] } },
  ]);
  vi.mocked(send).mockClear();
  penClick([0, 0], 1);
  undoAnchor();
  expect(pen()).toBeNull();
  expect(sent()).toEqual([]);
});

it("continuing and clicking the path's other Endpoint closes it", () => {
  const { a } = paths();
  penClick([10, 0], 1);
  penClick([5, 10], 1);
  penClick([0, 0], 1);
  expect(sent()).toEqual([
    {
      type: "path_edit",
      input: { nodeId: a, ops: [{ op: "set_d", d: "M 0 0 L 10 0 L 5 10 Z" }] },
    },
  ]);
});

it("connecting a continued path to another's Endpoint is one path_join leaving one path", () => {
  const { d, a, b } = paths();
  penClick([10, 0], 1);
  penClick([20, 5], 1);
  penClick([30, 0], 1);
  const [command, ...rest] = sent();
  expect(rest).toEqual([]);
  if (command?.type !== "path_join") throw new Error(`sent ${command?.type}`);
  const after = { ...d, nodes: new Map(d.nodes) };
  editPath(after, command.edit);
  const { deletedIds, updated } = pathOp(after, command.join);
  // Join keeps the topmost path.
  expect(deletedIds).toEqual([a]);
  expect(updated.map((n) => n.id)).toEqual([b]);
  expect(dOf(after, b)).toBe("M 0 0 L 10 0 L 20 5 L 30 0 L 40 0");
});

it("a new path connecting to an Endpoint continues that path backwards, in one path_edit", () => {
  const { b } = paths();
  penClick([20, 20], 1);
  penClick([40, 0], 1);
  expect(sent()).toEqual([
    { type: "path_edit", input: { nodeId: b, ops: [{ op: "set_d", d: "M 30 0 L 40 0 L 20 20" }] } },
  ]);
});

// #282: another Actor's edit to the path the Pen continues ends the continuation, so the finish
// never writes the Anchors it started from over their edit (ADR-0110).
it("ends a continuation when another Actor edits or deletes its path, and only then", () => {
  const { d, a, b } = paths();
  // a gets a second subpath, (0, 20) to (10, 20).
  const doc = { ...d, nodes: new Map(d.nodes) };
  editPath(doc, { nodeId: a, ops: [{ op: "set_d", d: "M 0 0 L 10 0 M 0 20 L 10 20" }] });
  const moved = (id: string, subpath: number) =>
    editPath(structuredClone(doc), {
      nodeId: id,
      ops: [{ op: "move_anchor", subpath, index: 0, to: [0, 5] }],
    }).node;
  const tx = (over: Partial<Parameters<typeof message<"tx">>[1]>) =>
    message("tx", { rev: doc.rev + 1, actor: "agent", ...over });
  const nodes = [...doc.nodes.values()];
  const ends = {
    "the continued subpath": tx({ updated: [moved(a, 0)] }),
    "another subpath": tx({ updated: [moved(a, 1)] }),
    "a deletion": tx({ deletedIds: [a] }),
    "a deletion that skipped another object": tx({ deletedIds: [a], skippedIds: [b] }),
    "a reconnect after their edit": message("document", {
      rev: doc.rev + 1,
      nodes: nodes.map((n) => (n.id === a ? moved(a, 0) : n)),
    }),
    // #287: the continuation holds its Anchors where the Document showed them, so a move of the
    // path alone would have its finish write them back over the move.
    "a reconnect after their move": message("document", {
      rev: doc.rev + 1,
      nodes: nodes.map((n) => (n.id === a ? { ...n, transform: [1, 0, 0, 1, 40, 0] } : n)),
    }),
  };
  const keeps = {
    "another path": tx({ updated: [moved(b, 0)] }),
    "a reconnect with the path unchanged": message("document", { rev: doc.rev, nodes }),
  };
  for (const [label, msg] of [...Object.entries(ends), ...Object.entries(keeps)]) {
    useStore.setState({ doc, pen: null, edit: null, notice: null });
    vi.mocked(send).mockClear();
    penClick([10, 0], 1);
    penClick([20, 10], 1);
    useStore.setState(stateAfter(useStore.getState(), msg));
    const s = useStore.getState();
    const stored = s.doc?.nodes.get(a);
    if (label in keeps) {
      // #292: the continued path is still drawn with the Pen's Anchors, before any further input.
      expect(s.edit, label).toEqual({
        inputs: [{ nodeId: a, ops: [{ op: "set_d", d: "M 0 0 L 10 0 L 20 10 M 0 20 L 10 20" }] }],
      });
      penClick([30, 10], 1);
      finishPen();
      const finished = "M 0 0 L 10 0 L 20 10 L 30 10 M 0 20 L 10 20";
      expect(sent(), label).toEqual([
        { type: "path_edit", input: { nodeId: a, ops: [{ op: "set_d", d: finished }] } },
      ]);
      continue;
    }
    // At once: the Pen draws nothing more, its preview of the old path goes, and a notice says why.
    expect(s.pen, label).toBeNull();
    expect(s.edit, label).toBeNull();
    expect(s.notice, label).toMatch(/Pen/);
    // The next clicks start a new path; the finish sends nothing over their edit.
    penClick([30, 10], 1);
    finishPen();
    expect(sent(), label).toEqual([]);
    expect(useStore.getState().doc?.nodes.get(a), label).toBe(stored);
  }
});

it("over a selected path the Pen deletes the Anchor or adds one, and Shift draws instead", () => {
  const { tri } = paths();
  penClick([20, 50], 1);
  expect(sent()).toEqual([
    {
      type: "path_edit",
      input: { nodeId: tri, ops: [{ op: "remove_anchor", subpath: 0, index: 1 }] },
    },
  ]);
  vi.mocked(send).mockClear();
  penClick([5, 50], 1);
  const [add] = sent();
  expect(add).toMatchObject({ type: "path_edit", input: { nodeId: tri } });
  const op = add?.type === "path_edit" ? add.input.ops[0] : null;
  expect(op).toMatchObject({ op: "add_anchor", subpath: 0, segment: 0 });
  expect(op?.op === "add_anchor" && op.t).toBeCloseTo(0.25);
  expect(pen()).toBeNull();
  vi.mocked(send).mockClear();
  penClick([5, 50], 1, true);
  expect(sent()).toEqual([]);
  expect(pen()?.anchors).toEqual([corner(5, 50)]);
});

// #290: another Actor's edit to the path a held Pen press connects to drops only the connection,
// so the release never joins a renumbered or deleted path (ADR-0110).
it("drops a held connection when another Actor edits or deletes the path it connects to", () => {
  const { d, a, b, tri } = paths();
  // a gets a second subpath, (0, 20) to (10, 20), to connect a continuation of its first to.
  const doc = { ...d, nodes: new Map(d.nodes) };
  editPath(doc, { nodeId: a, ops: [{ op: "set_d", d: "M 0 0 L 10 0 M 0 20 L 10 20" }] });
  const reshaped = (id: string, path: string) =>
    editPath(structuredClone(doc), { nodeId: id, ops: [{ op: "set_d", d: path }] }).node;
  const tx = (over: Partial<Parameters<typeof message<"tx">>[1]>) =>
    message("tx", { rev: doc.rev + 1, actor: "agent", ...over });
  const nodes = [...doc.nodes.values()];
  const moved = reshaped(b, "M 30 5 L 40 0");
  const drops = {
    "an edit to it": tx({ updated: [moved] }),
    "its deletion": tx({ deletedIds: [b] }),
    "its deletion that skipped another object": tx({ deletedIds: [b], skippedIds: [tri] }),
    "a subpath inserted before it": tx({ updated: [reshaped(b, "M 60 60 L 70 60 M 30 0 L 40 0")] }),
    "a reconnect after their edit": message("document", {
      rev: doc.rev + 1,
      nodes: nodes.map((n) => (n.id === b ? moved : n)),
    }),
  };
  const keeps = {
    "another path": tx({ updated: [reshaped(tri, "M 0 50 L 20 50 Z")] }),
    "the person's own edit": tx({ updated: [moved], commandId: "mine" }),
    "a reconnect with it unchanged": message("document", { rev: doc.rev, nodes }),
    // #287: a reconnect reads geometry, so a change to its opacity alone keeps the connection.
    "a reconnect with only its opacity changed": message("document", {
      rev: doc.rev + 1,
      nodes: nodes.map((n) => (n.id === b ? ({ ...n, opacity: 0.5 } as typeof n) : n)),
    }),
  };
  const drawings = {
    "new art": {
      clicks: [
        [0, 80],
        [20, 80],
      ] as Point[],
      made: "create",
    },
    "a continuation": {
      clicks: [
        [10, 0],
        [20, 5],
      ] as Point[],
      made: "path_edit",
    },
  };
  for (const [art, { clicks, made }] of Object.entries(drawings)) {
    for (const [label, msg] of [...Object.entries(drops), ...Object.entries(keeps)]) {
      const at = `${art}, ${label}`;
      useStore.setState({ doc, pen: null, edit: null, notice: null, drag: null, sentPreviews: [] });
      vi.mocked(send).mockClear();
      for (const p of clicks) penClick(p, 1);
      const before = { pen: pen(), edit: useStore.getState().edit };
      penDown([30, 0], 1);
      expect(pen()?.to, at).toBeDefined();
      if (label === "the person's own edit")
        useStore.setState({
          sentPreviews: [{ edit: null, drag: { nodeIds: [], dx: 0, dy: 0, commandId: "mine" } }],
        });
      useStore.setState(stateAfter(useStore.getState(), msg));
      if (label in keeps) {
        penUp();
        expect(
          sent().map((c) => c.type),
          at,
        ).toEqual([made === "create" ? "path_edit" : "path_join"]);
        continue;
      }
      // At once: the Pen's path and preview are as before the press, and a notice says why.
      const s = useStore.getState();
      expect(s.pen, at).toEqual(before.pen);
      expect(s.edit, at).toEqual(before.edit);
      expect(s.notice, at).toMatch(/connecting to/);
      if (label.includes("skipped")) expect(s.notice, at).toMatch(/Skipped 1/);
      // The press is no longer a connection: its drag moves nothing, its release finishes nothing.
      penDrag([35, 5], NONE);
      penUp();
      expect(pen(), at).toEqual(before.pen);
      expect(sent(), at).toEqual([]);
      // The Pen goes on drawing its path, and Enter finishes it without naming b.
      finishPen();
      expect(
        sent().map((c) => c.type),
        at,
      ).toEqual([made]);
      expect(JSON.stringify(sent()), at).not.toContain(b);
    }
  }
  // A continuation connecting to another subpath of its own path follows #282: it ends.
  useStore.setState({ doc, pen: null, edit: null, notice: null });
  vi.mocked(send).mockClear();
  penClick([10, 0], 1);
  penClick([20, 5], 1);
  penDown([10, 20], 1);
  expect(pen()?.to?.nodeId).toBe(a);
  useStore.setState(
    stateAfter(useStore.getState(), tx({ updated: [reshaped(a, "M 0 0 L 10 0")] })),
  );
  expect(pen()).toBeNull();
  expect(useStore.getState().edit).toBeNull();
  expect(useStore.getState().notice).toMatch(/continuing/);
  penUp();
  expect(sent()).toEqual([]);
});

// #293: a continuation started while the person's own edit to its path is unanswered continues the
// path as that edit leaves it, as drawn, and its finish stores that edit plus what the Pen drew.

/** One path, `d`, with nothing in flight; `stored()` is it as the Document has it. */
function onePath(d: string) {
  const { doc: made, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 100, height: 100 }],
  });
  const [p] = createNodes(made, [{ type: "path", parentId, d }]).nodes.map((n) => n.id) as [string];
  useStore.setState({
    doc: made,
    edit: null,
    drag: null,
    notice: null,
    sentPreviews: [],
    sent: new Set(),
    renumbering: new Map(),
    held: [],
  });
  vi.mocked(send).mockClear();
  return { p, stored: () => dOf(useStore.getState().doc as Document, p) };
}

/** Sends the next command as `id`, recorded as the real `send` records it. */
const sendAs = (id: string) => vi.mocked(send).mockImplementationOnce(recordAs(id));

/** The answer to the person's own `path_edit` `id`, as the Document DO applies it. */
function answer(id: string) {
  const c = sent().find((_, i) => vi.mocked(send).mock.results[i]?.value === id);
  if (c?.type !== "path_edit") throw new Error(`${id} is no path_edit`);
  const now = useStore.getState().doc as Document;
  const { node } = editPath(structuredClone(now), c.input);
  return message("tx", { rev: now.rev + 1, commandId: id, updated: [node] });
}

/** The path as the canvas draws it: the Document with every preview applied. */
const drawnD = (p: string) => {
  const s = useStore.getState();
  return dOf(previewAll(s.doc as Document, previewsOf(s)), p);
};

it("continues a path from its own unanswered extension and stores both (#293)", () => {
  const { p, stored } = onePath("M 0 0 L 100 0");
  sendAs("first");
  penClick([100, 0], 1);
  penClick([150, 50], 1);
  finishPen();
  // The other Endpoint, then a new Anchor: the first extension stays drawn under the Pen's.
  penClick([0, 0], 1);
  penClick([-50, 50], 1);
  expect(drawnD(p)).toBe("M -50 50 L 0 0 L 100 0 L 150 50");
  expect(useStore.getState().sentPreviews).toHaveLength(1);
  useStore.setState(stateAfter(useStore.getState(), answer("first")));
  expect(useStore.getState().notice).toBeNull();
  expect(pen()).not.toBeNull();
  expect(drawnD(p)).toBe("M -50 50 L 0 0 L 100 0 L 150 50");
  sendAs("second");
  finishPen();
  useStore.setState(stateAfter(useStore.getState(), answer("second")));
  expect(stored()).toBe("M -50 50 L 0 0 L 100 0 L 150 50");
  expect(useStore.getState().notice).toBeNull();
});

it("continues a path from the person's own unanswered Direct Selection drag on it (#293)", () => {
  for (const [label, from, to, finished] of [
    ["its other subpath", [100, 50], [120, 60], "M 0 0 L 50 20 L 100 0 M 0 50 L 100 50 L 120 60"],
    ["the dragged subpath", [100, 0], [120, 10], "M 0 0 L 50 20 L 100 0 L 120 10 M 0 50 L 100 50"],
  ] as const) {
    const { p, stored } = onePath("M 0 0 L 50 0 L 100 0 M 0 50 L 100 50");
    // The middle Anchor of the first subpath dragged down, sent, unanswered.
    const input = {
      nodeId: p,
      ops: [{ op: "move_anchor" as const, subpath: 0, index: 1, to: [50, 20] as Point }],
    };
    useStore.setState({
      sentPreviews: [{ edit: { inputs: [input], commandIds: ["drag"] }, drag: null }],
      sent: new Set(["drag"]),
    });
    vi.mocked(send).mockReturnValueOnce("drag");
    send({ type: "path_edit", input }, unheld("the test's drag"));
    penClick([...from], 1);
    penClick([...to], 1);
    expect(drawnD(p), label).toBe(finished);
    useStore.setState(stateAfter(useStore.getState(), answer("drag")));
    expect(useStore.getState().notice, label).toBeNull();
    sendAs("finish");
    finishPen();
    useStore.setState(stateAfter(useStore.getState(), answer("finish")));
    expect(stored(), label).toBe(finished);
  }
});

it("ends a continuation when the person's own edit it started from is rejected, and sends nothing (#293)", () => {
  const { p, stored } = onePath("M 0 0 L 100 0");
  sendAs("first");
  penClick([100, 0], 1);
  penClick([150, 50], 1);
  finishPen();
  penClick([0, 0], 1);
  penClick([-50, 50], 1);
  vi.mocked(send).mockClear();
  useStore.setState(stateAfter(useStore.getState(), message("rejected", { id: "first" })));
  const s = useStore.getState();
  expect(s.pen).toBeNull();
  expect(s.edit).toBeNull();
  expect(s.notice).toMatch(/your earlier edit .*not applied/i);
  expect(s.notice).not.toMatch(/Someone else/);
  expect(drawnD(p)).toBe("M 0 0 L 100 0");
  finishPen();
  expect(sent()).toEqual([]);
  expect(stored()).toBe("M 0 0 L 100 0");
});

it("holds a continuation's finish for the answer to the edit it continued, then sends it, or drops it on a rejection (#293)", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    const { stored } = onePath("M 0 0 L 100 0");
    sendAs("first");
    penClick([100, 0], 1);
    penClick([150, 50], 1);
    finishPen();
    penClick([0, 0], 1);
    penClick([-50, 50], 1);
    // The first extension may renumber p, so the finish waits for its answer.
    finishPen();
    expect(useStore.getState().held, outcome).toHaveLength(1);
    const after = stateAfter(
      useStore.getState(),
      outcome === "accepted" ? answer("first") : message("rejected", { id: "first" }),
    );
    useStore.setState(after);
    if (outcome === "accepted") sendAs("second");
    runHeld(after.notice);
    const s = useStore.getState();
    if (outcome === "accepted") {
      useStore.setState(stateAfter(s, answer("second")));
      expect(stored(), outcome).toBe("M -50 50 L 0 0 L 100 0 L 150 50");
      expect(s.notice, outcome).toBeNull();
      continue;
    }
    expect(
      sent().map((c) => c.type),
      outcome,
    ).toEqual(["path_edit"]);
    expect(s.held, outcome).toEqual([]);
    expect(s.notice, outcome).toMatch(/your earlier edit .*not applied/i);
    expect(stored(), outcome).toBe("M 0 0 L 100 0");
  }
});

/** Sends and records the person's own Undo `id`; its answer, built when it comes, leaves p as `d`. */
function ownUndo(id: string, p: string, d: string) {
  record(id, { type: "undo" });
  return () => {
    const now = useStore.getState().doc as Document;
    const { node } = editPath(structuredClone(now), { nodeId: p, ops: [{ op: "set_d", d }] });
    return message("tx", { rev: now.rev + 1, commandId: id, updated: [node] });
  };
}

it("names the person's own Undo, not someone else, when it ends a continuation or drops a held Pen finish (#293)", () => {
  // A continuation with nothing of theirs in flight, ended by their Undo reshaping p.
  const { p } = onePath("M 0 0 L 100 0");
  penClick([100, 0], 1);
  penClick([150, 50], 1);
  const ended = ownUndo("u", p, "M 0 0 L 100 20")();
  useStore.setState(stateAfter(useStore.getState(), ended));
  let s = useStore.getState();
  expect(s.pen).toBeNull();
  expect(s.edit).toBeNull();
  expect(s.notice).toMatch(/^Your own earlier change reshaped the path the Pen was continuing/);
  finishPen();
  expect(sent()).toEqual([]);

  // A finish held for the answer to their extension, dropped by their Undo answered after it.
  const second = onePath("M 0 0 L 100 0");
  sendAs("first");
  penClick([100, 0], 1);
  penClick([150, 50], 1);
  finishPen();
  penClick([0, 0], 1);
  penClick([-50, 50], 1);
  finishPen();
  const undo = ownUndo("u", second.p, "M 0 0 L 100 20");
  useStore.setState(stateAfter(useStore.getState(), answer("first")));
  runHeld();
  expect(useStore.getState().held).toHaveLength(1);
  const after = stateAfter(useStore.getState(), undo());
  useStore.setState(after);
  runHeld(after.notice);
  s = useStore.getState();
  expect(sent().map((c) => c.type)).toEqual(["path_edit"]);
  expect(s.held).toEqual([]);
  expect(s.notice).toMatch(/^Your own earlier change reshaped a path the Pen was continuing/);
  expect(second.stored()).toBe("M 0 0 L 100 20");
});

it("continues a path from the stored path under an own unanswered Simplify, which ends it as the person's own change (#293, #299)", () => {
  const { p } = onePath("M 0 0 L 50 0 L 100 0");
  const input = { nodeIds: [p], op: "simplify" as const, tolerance: 1 };
  // Simplify sent with its preview, unanswered: drawn, but not what the Pen continues.
  record("s", { type: "path_op", input });
  useStore.setState({ sentPreviews: [{ edit: null, drag: null, op: { input, commandId: "s" } }] });
  penClick([100, 0], 1);
  penClick([150, 50], 1);
  expect(pen()?.from?.seed ?? []).toEqual([]);
  expect(drawnD(p)).toBe("M 0 0 L 50 0 L 100 0 L 150 50");
  const now = useStore.getState().doc as Document;
  const simplified = structuredClone(now);
  pathOp(simplified, input);
  const updated = [...simplified.nodes.values()].filter((n) => n.id === p);
  expect(dOf(simplified, p)).not.toBe(dOf(now, p));
  useStore.setState(
    stateAfter(useStore.getState(), message("tx", { rev: now.rev + 1, commandId: "s", updated })),
  );
  const s = useStore.getState();
  expect(s.pen).toBeNull();
  expect(s.notice).toMatch(/^Your own earlier change reshaped the path the Pen was continuing/);
});

/** p with its first subpath's middle Anchor dragged to (50, 20) by the person, sent as "drag". */
function dragged() {
  const o = onePath("M 0 0 L 50 0 L 100 0 M 0 50 L 100 50");
  const input = {
    nodeId: o.p,
    ops: [{ op: "move_anchor" as const, subpath: 0, index: 1, to: [50, 20] as Point }],
  };
  vi.mocked(send).mockImplementationOnce(recordAs("drag"));
  send({ type: "path_edit", input }, unheld("the test's drag"));
  useStore.setState({
    sentPreviews: [{ edit: { inputs: [input], commandIds: ["drag"] }, drag: null }],
  });
  const applied = () => {
    const d = structuredClone(useStore.getState().doc as Document);
    editPath(d, input);
    return d;
  };
  // `sent()` has the drag's command first.
  return { ...o, applied };
}

it("holds a continuation's finish for the answer to the Direct Selection drag it was drawn on (#293)", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    const { stored } = dragged();
    penClick([100, 50], 1);
    penClick([120, 60], 1);
    // The drag renumbers nothing, but the finish carries it, so it waits for its answer.
    finishPen();
    expect(sent(), outcome).toHaveLength(1);
    expect(useStore.getState().held, outcome).toHaveLength(1);
    const after = stateAfter(
      useStore.getState(),
      outcome === "accepted" ? answer("drag") : message("rejected", { id: "drag" }),
    );
    useStore.setState(after);
    if (outcome === "accepted") sendAs("finish");
    runHeld(after.notice);
    if (outcome === "accepted") {
      useStore.setState(stateAfter(useStore.getState(), answer("finish")));
      expect(stored(), outcome).toBe("M 0 0 L 50 20 L 100 0 M 0 50 L 100 50 L 120 60");
      expect(useStore.getState().notice, outcome).toBeNull();
      continue;
    }
    expect(sent(), outcome).toHaveLength(1);
    expect(useStore.getState().held, outcome).toEqual([]);
    expect(useStore.getState().notice, outcome).toMatch(/Your earlier edit .*not applied/);
    expect(stored(), outcome).toBe("M 0 0 L 50 0 L 100 0 M 0 50 L 100 50");
  }
});

it("drops a connection to the person's own unanswered extension when it is rejected (#293)", () => {
  for (const when of ["pressed", "held"] as const) {
    const { stored } = onePath("M 0 0 L 100 0");
    useStore.setState({ pen: null, penPress: null });
    sendAs("first");
    penClick([100, 0], 1);
    penClick([150, 50], 1);
    finishPen();
    vi.mocked(send).mockClear();
    // A new path, connected to the extension's Endpoint as drawn.
    penClick([200, 0], 1);
    penDown([150, 50], 1);
    expect(pen()?.to?.seed, when).toEqual(["first"]);
    if (when === "held") penUp();
    const after = stateAfter(useStore.getState(), message("rejected", { id: "first" }));
    useStore.setState(after);
    runHeld(after.notice);
    const s = useStore.getState();
    expect(s.notice, when).toMatch(/Your earlier edit to (the|a) path the Pen was .*not applied/);
    expect(s.notice, when).not.toMatch(/Someone else/);
    if (when === "pressed") {
      expect(s.pen?.to, when).toBeUndefined();
      expect(s.pen?.anchors, when).toEqual([corner(200, 0)]);
      penUp();
    }
    expect(sent(), when).toEqual([]);
    expect(s.held, when).toEqual([]);
    expect(stored(), when).toBe("M 0 0 L 100 0");
  }
});

it("reads a reconnect by whether the person's own edits the Pen drew on were applied (#293)", () => {
  // A continuation still being drawn on their unanswered drag.
  for (const applied of [true, false]) {
    const { p, stored, applied: withDrag } = dragged();
    penClick([100, 50], 1);
    penClick([120, 60], 1);
    const now = useStore.getState().doc as Document;
    const d = applied ? withDrag() : now;
    useStore.setState(
      stateAfter(
        useStore.getState(),
        message("document", { rev: now.rev + 1, nodes: [...d.nodes.values()] }),
      ),
    );
    const s = useStore.getState();
    if (!applied) {
      expect(s.pen).toBeNull();
      expect(s.notice).toMatch(/^Your earlier edit to the path the Pen was continuing/);
      expect(drawnD(p)).toBe("M 0 0 L 50 0 L 100 0 M 0 50 L 100 50");
      continue;
    }
    expect(s.notice).toBeNull();
    sendAs("finish");
    finishPen();
    useStore.setState(stateAfter(useStore.getState(), answer("finish")));
    expect(stored()).toBe("M 0 0 L 50 20 L 100 0 M 0 50 L 100 50 L 120 60");
  }
  // A finish held for the answer to their extension.
  for (const applied of [true, false]) {
    const { p, stored } = onePath("M 0 0 L 100 0");
    sendAs("first");
    penClick([100, 0], 1);
    penClick([150, 50], 1);
    finishPen();
    const extended = stateAfter(useStore.getState(), answer("first")).doc as Document;
    penClick([0, 0], 1);
    penClick([-50, 50], 1);
    finishPen();
    const now = useStore.getState().doc as Document;
    const d = applied ? extended : now;
    const after = stateAfter(
      useStore.getState(),
      message("document", { rev: now.rev + 1, nodes: [...d.nodes.values()] }),
    );
    useStore.setState(after);
    if (applied) sendAs("second");
    runHeld(after.notice);
    if (!applied) {
      expect(sent().map((c) => c.type)).toEqual(["path_edit"]);
      expect(useStore.getState().notice).toMatch(/^Your earlier edit to a path the Pen was/);
      expect(drawnD(p)).toBe("M 0 0 L 100 0");
      continue;
    }
    useStore.setState(stateAfter(useStore.getState(), answer("second")));
    expect(stored()).toBe("M -50 50 L 0 0 L 100 0 L 150 50");
    expect(useStore.getState().notice).toBeNull();
  }
});

// #308: the path as drawn includes the person's held edits' previews, in the order they will run,
// so a continuation drawn on one continues it, waits for it, and goes when it never lands.

/** Ends the Pen's path held: a finish while a renumbering command is unanswered (ADR-0110). */
const heldFinish = () => {
  const before = useStore.getState().held.length;
  finishPen();
  expect(useStore.getState().held).toHaveLength(before + 1);
};

/** Applies `msg`, then runs the held edits, the next one sent as `next` if given. */
const land = (msg: Parameters<typeof stateAfter>[1], next?: string) => {
  const after = stateAfter(useStore.getState(), msg);
  useStore.setState(after);
  if (next) sendAs(next);
  runHeld(after.notice);
};

it("continues a path from its own held extension, and stores both once each lands (#308)", () => {
  const { p, stored } = onePath("M 0 0 L 100 0");
  sendAs("first");
  penClick([100, 0], 1);
  penClick([150, 50], 1);
  finishPen();
  penClick([0, 0], 1);
  penClick([-50, 50], 1);
  heldFinish();
  // The held extension's drawn Endpoint continues p.
  penClick([-50, 50], 1);
  expect(pen()?.from?.nodeId).toBe(p);
  useStore.setState({ pen: null, edit: null });
  // The other end, as drawn on the held extension: it stays drawn under the Pen's.
  penClick([150, 50], 1);
  penClick([200, 0], 1);
  expect(drawnD(p)).toBe("M -50 50 L 0 0 L 100 0 L 150 50 L 200 0");
  const under = useStore.getState();
  const shown = previewAll(under.doc as Document, [
    ...under.sentPreviews,
    ...under.held.map((h) => h.preview),
  ]);
  expect(dOf(shown, p)).toBe("M -50 50 L 0 0 L 100 0 L 150 50");
  heldFinish();
  expect(drawnD(p)).toBe("M -50 50 L 0 0 L 100 0 L 150 50 L 200 0");
  land(answer("first"), "second");
  expect(useStore.getState().held).toHaveLength(1);
  land(answer("second"), "third");
  land(answer("third"));
  expect(stored()).toBe("M -50 50 L 0 0 L 100 0 L 150 50 L 200 0");
  expect(useStore.getState().notice).toBeNull();
});

it("continues a path from the person's own held Direct Selection drag on it (#308)", () => {
  const { p, stored } = onePath("M 0 0 L 50 0 L 100 0");
  record("press", { type: "undo" });
  // The middle Anchor dragged down and released while the press is in flight: held.
  const input = {
    nodeId: p,
    ops: [{ op: "move_anchor" as const, subpath: 0, index: 1, to: [50, 20] as Point }],
  };
  useStore.setState({ edit: { inputs: [input] } });
  afterRenumbering(
    (_s, w) =>
      drawSent({
        edit: { inputs: [input], commandIds: [send({ type: "path_edit", input }, w)] },
        drag: null,
      }),
    { anchors: [`${p}:0:1`], segments: [], previewed: true },
  );
  penClick([100, 0], 1);
  penClick([150, 50], 1);
  expect(drawnD(p)).toBe("M 0 0 L 50 20 L 100 0 L 150 50");
  heldFinish();
  const now = useStore.getState().doc as Document;
  land(message("tx", { rev: now.rev + 1, commandId: "press", updated: [] }), "drag");
  expect(useStore.getState().held).toHaveLength(1);
  land(answer("drag"), "finish");
  land(answer("finish"));
  expect(stored()).toBe("M 0 0 L 50 20 L 100 0 L 150 50");
  expect(useStore.getState().notice).toBeNull();
});

it("drops what the Pen drew on a held edit that never lands, and sends nothing (#308)", () => {
  for (const how of ["dropped on run", "seed rejected"] as const) {
    const { p, stored } = onePath("M 0 0 L 100 0");
    const now = useStore.getState().doc as Document;
    const parentId = now.nodes.get(p)?.parentId as string;
    const [q] = createNodes(now, [{ type: "path", parentId, d: "M 0 100 L 100 100" }]).nodes;
    // q extended, unanswered; then p continued and connected to q: the join is held on it.
    sendAs("a");
    penClick([100, 100], 1);
    penClick([150, 150], 1);
    finishPen();
    penClick([0, 0], 1);
    penClick([0, 100], 1);
    expect(useStore.getState().held, how).toHaveLength(1);
    // p's other end continued on the held join, held; then continued again, live.
    penClick([100, 0], 1);
    penClick([150, -50], 1);
    heldFinish();
    penClick([150, -50], 1);
    penClick([200, -50], 1);
    expect(drawnD(p), how).toBe("M 0 100 L 0 0 L 100 0 L 150 -50 L 200 -50");
    const before = sent().length;
    if (how === "dropped on run") {
      // Someone else edits q, so the join drops when it runs.
      const at = useStore.getState().doc as Document;
      const { node } = editPath(structuredClone(at), {
        nodeId: q?.id as string,
        ops: [{ op: "set_d", d: "M 0 100 L 100 120" }],
      });
      land(message("tx", { rev: at.rev + 1, updated: [node] }));
      land(answer("a"));
    } else land(message("rejected", { id: "a" }));
    const s = useStore.getState();
    expect(sent().slice(before), how).toEqual([]);
    expect(s.held, how).toEqual([]);
    expect(s.pen, how).toBeNull();
    expect(s.notice, how).toMatch(/Your earlier edit to a path the Pen was .*not applied/);
    expect(s.notice, how).toMatch(/Your earlier edit to the path the Pen was continuing/);
    finishPen();
    expect(sent().slice(before), how).toEqual([]);
    expect(stored(), how).toBe("M 0 0 L 100 0");
  }
});

// #286: a held edit's preview follows the answer that renumbers its keys, so the paths as drawn,
// which the Pen continues and stores, are what the held edits will send.

/**
 * p, an open subpath `d` after a line from (0, 200) to (100, 200), and q, a line from (0, 300) to
 * (100, 300), both selected. A Delete Anchor click on p's (50, 200), sent as "d1", then one on q's
 * (50, 300), held behind it; `answerClick` answers d1, so q's click is sent as "d2", which holds
 * what comes after it.
 */
function behindClicks(d: string) {
  const { p, stored } = onePath(`M 0 200 L 50 200 L 100 200 ${d}`);
  const now = useStore.getState().doc as Document;
  const parentId = now.nodes.get(p)?.parentId as string;
  const [q] = createNodes(now, [{ type: "path", parentId, d: "M 0 300 L 50 300 L 100 300" }]).nodes;
  useStore.setState({ selection: [p, q?.id as string] });
  sendAs("d1");
  penClick([50, 200], 1);
  penClick([50, 300], 1);
  expect(sent()).toHaveLength(1);
  return { p, stored, answerClick: () => land(answer("d1"), "d2") };
}

it("keeps a held Pen finish drawn on another held one's extension through a Delete Anchor click's answer (#286)", () => {
  const { p, stored, answerClick } = behindClicks("M 0 0 L 100 0");
  penClick([100, 0], 1);
  penClick([150, 50], 1);
  heldFinish();
  penClick([150, 50], 1);
  penClick([200, 0], 1);
  heldFinish();
  answerClick();
  const s = useStore.getState();
  expect(s.held).toHaveLength(2);
  const second = previewAll(s.doc as Document, [s.held[1]?.preview ?? { edit: null, drag: null }]);
  expect(dOf(second, p)).toBe("M 0 200 L 100 200 M 0 0 L 100 0 L 150 50 L 200 0");
  land(answer("d2"), "f1");
  land(answer("f1"), "f2");
  land(answer("f2"));
  expect(stored()).toBe("M 0 200 L 100 200 M 0 0 L 100 0 L 150 50 L 200 0");
  expect(useStore.getState().notice).toBeNull();
});

it("stores a held Pencil redraw and the Pen continuation drawn on it after a Delete Anchor click's answer (#286)", () => {
  const { stored, answerClick } = behindClicks("M 0 0 L 100 0 L 200 0");
  useStore.setState({ tool: "pencil" });
  // Redraws p's stretch from (120, 0) to (180, 0) through (150, 20).
  pencilDown([120, 0]);
  for (let x = 125; x <= 180; x += 5)
    pencilMove([[x, 20 - Math.abs(x - 150) * (2 / 3)]], { shift: false, alt: false });
  pencilUp(1);
  expect(useStore.getState().held).toHaveLength(2);
  answerClick();
  const [redraw] = useStore.getState().held;
  expect(redraw?.preview.edit?.inputs).toHaveLength(1);
  // The person continues p from (200, 0), as drawn with the redraw, while it is still held.
  useStore.setState({ tool: "pen" });
  penClick([200, 0], 1);
  penClick([250, 50], 1);
  heldFinish();
  land(answer("d2"), "r");
  land(answer("r"), "f");
  const redrawn = stored();
  expect(redrawn).toBe("M 0 200 L 100 200 M 0 0 L 100 0 L 119.982 0 L 150 20 L 180.018 0 L 200 0");
  land(answer("f"));
  expect(stored()).toBe(`${redrawn} L 250 50`);
  expect(useStore.getState().notice).toBeNull();
});

it("stores a held drag on the Anchor dragged, and the Pen continuation drawn on it, after a press turned its subpath (#286)", () => {
  const { p, stored } = onePath("M 0 200 L 50 200 L 100 200 M 0 0 L 100 0 L 100 100 L 0 100");
  const now = useStore.getState().doc as Document;
  const parentId = now.nodes.get(p)?.parentId as string;
  const [q] = createNodes(now, [{ type: "path", parentId, d: "M 0 300 L 50 300 L 100 300" }]).nodes;
  useStore.setState({ selection: [p, q?.id as string] });
  // A press reversing p's U, then a Delete Anchor click on q held behind it.
  sendAs("press");
  setDirection(
    { ...useStore.getState(), anchors: [`${p} 1 0`] },
    !runsClockwise(now, now.nodes.get(p) as PathNode, 1),
  );
  expect(useStore.getState().reversing?.commandId).toBe("press");
  penClick([50, 300], 1);
  // (100, 0), Anchor 1, dragged to (120, -20) and released: held behind both.
  const input = {
    nodeId: p,
    ops: [{ op: "move_anchor" as const, subpath: 1, index: 1, to: [120, -20] as Point }],
  };
  useStore.setState({ edit: { inputs: [input] } });
  afterRenumbering(
    ({ anchors: [k] }, w) => {
      const [, subpath, index] = (k as string).split(" ").map(Number) as [number, number, number];
      const moved = { ...input, ops: [{ ...input.ops[0], subpath, index }] } as typeof input;
      drawSent({
        edit: { inputs: [moved], commandIds: [send({ type: "path_edit", input: moved }, w)] },
        drag: null,
      });
    },
    { anchors: [`${p} 1 1`], segments: [], previewed: true },
  );
  const at = useStore.getState().doc as Document;
  const turned = editPath(structuredClone(at), {
    nodeId: p,
    ops: [{ op: "reverse", subpath: 1 }],
  }).node;
  land(message("tx", { rev: at.rev + 1, commandId: "press", updated: [turned] }), "d2");
  expect(useStore.getState().held).toHaveLength(1);
  expect(drawnD(p)).toBe("M 0 200 L 50 200 L 100 200 M 0 100 L 100 100 L 120 -20 L 0 0");
  // The person continues p from (0, 100) while the drag is still held.
  penClick([0, 100], 1);
  penClick([-50, 150], 1);
  heldFinish();
  land(answer("d2"), "drag");
  land(answer("drag"), "finish");
  land(answer("finish"));
  expect(stored()).toBe("M 0 200 L 50 200 L 100 200 M -50 150 L 0 100 L 100 100 L 120 -20 L 0 0");
  expect(useStore.getState().notice).toBeNull();
});

// #309: a Pencil redraw is drawn on the paths as drawn, so it carries the person's sent and held
// edits to its path, and it waits for their answers as a Pen finish does.

/** A Pencil drag at 100% on the Selection `p` from `from`, by `step` five times, freehand. */
function pencilFrom(p: string, from: Point, step: Point) {
  useStore.setState({ selection: [p], tool: "pencil" });
  pencilDown(from);
  for (let t = 1; t <= 5; t++)
    pencilMove([[from[0] + t * step[0], from[1] + t * step[1]]], { shift: false, alt: false });
  pencilUp(1);
}

/** A Pencil drag on p at 100%, from the dragged Anchor's drawn (50, 20) down to (100, 60). */
const pencilFromDrag = (p: string) => pencilFrom(p, [50, 20], [10, 8]);

/** A press reversing another path's hole, sent after the person's drag on p. */
function pressAfter(p: string) {
  const now = useStore.getState().doc as Document;
  const parentId = now.nodes.get(p)?.parentId as string;
  const [q] = createNodes(now, [
    { type: "path", parentId, d: "M 200 0 L 300 0 L 300 100 Z M 220 20 L 220 80 L 280 80 Z" },
  ]).nodes as [PathNode];
  sendAs("press");
  setDirection({ ...useStore.getState(), anchors: [`${q.id} 1 0`] }, !runsClockwise(now, q, 1));
}

/** p with the drag, the redraw from (50, 20), and its untouched second subpath. */
const REDRAWN = "M 0 0 L 50 20 L 100 60 M 0 50 L 100 50";
const ORIGINAL = "M 0 0 L 50 0 L 100 0 M 0 50 L 100 50";

it("draws a Pencil redraw on the person's unanswered drag, from the Anchor as drawn (#309)", () => {
  const { p } = dragged();
  pencilFromDrag(p);
  expect(sent().map((c) => c.type)).toEqual(["path_edit"]);
  expect(useStore.getState().held).toHaveLength(1);
  expect(drawnD(p)).toBe(REDRAWN);
});

it("holds a Pencil redraw drawn on the person's drag for its answer, and drops it on a rejection (#309)", () => {
  for (const press of [false, true]) {
    for (const outcome of ["accepted", "rejected"] as const) {
      const label = `${outcome}${press ? ", behind a press" : ""}`;
      const { p, stored } = dragged();
      if (press) pressAfter(p);
      pencilFromDrag(p);
      const before = press ? ["path_edit", "path_reverse"] : ["path_edit"];
      expect(
        sent().map((c) => c.type),
        label,
      ).toEqual(before);
      expect(useStore.getState().held, label).toHaveLength(1);
      const next = outcome === "accepted" && !press ? "redraw" : undefined;
      land(outcome === "accepted" ? answer("drag") : message("rejected", { id: "drag" }), next);
      if (outcome === "rejected") {
        const s = useStore.getState();
        expect(s.held, label).toEqual([]);
        expect(s.notice, label).toMatch(
          /^The Pencil edit was not applied, because your earlier edit to its path was not\. ./,
        );
        expect(s.notice, label).not.toMatch(/Pen |Someone else/);
        expect(drawnD(p), label).toBe(ORIGINAL);
      }
      if (press) {
        const at = useStore.getState().doc as Document;
        land(
          message("tx", { rev: at.rev + 1, commandId: "press", updated: [] }),
          outcome === "accepted" ? "redraw" : undefined,
        );
      }
      if (outcome === "rejected") {
        expect(
          sent().map((c) => c.type),
          label,
        ).toEqual(before);
        expect(stored(), label).toBe(ORIGINAL);
        continue;
      }
      expect(
        sent().map((c) => c.type),
        label,
      ).toEqual([...before, "path_edit"]);
      land(answer("redraw"));
      expect(stored(), label).toBe(REDRAWN);
      expect(useStore.getState().notice, label).toBeNull();
    }
  }
});

it("holds a Pencil redraw drawn on a held Pen finish's extension until it runs, then sends both (#309)", () => {
  const { p, stored } = onePath("M 0 0 L 100 0");
  sendAs("first");
  penClick([100, 0], 1);
  penClick([150, 50], 1);
  finishPen();
  penClick([0, 0], 1);
  penClick([-50, 50], 1);
  heldFinish();
  // The Pencil extends p from the held finish's Endpoint, as drawn.
  pencilFrom(p, [-50, 50], [-10, 0]);
  const [, redraw] = useStore.getState().held;
  expect(redraw?.redraw?.seed).toEqual(["first", useStore.getState().held[0]?.token]);
  expect(drawnD(p)).toBe("M -100 50 L -50 50 L 0 0 L 100 0 L 150 50");
  land(answer("first"), "second");
  expect(useStore.getState().held).toHaveLength(1);
  land(answer("second"), "third");
  land(answer("third"));
  expect(stored()).toBe("M -100 50 L -50 50 L 0 0 L 100 0 L 150 50");
  expect(useStore.getState().notice).toBeNull();
});

it("drops a Pencil redraw drawn on a held Pen finish that sends nothing, with the Pencil's notice (#309)", () => {
  const { p, stored } = onePath("M 0 0 L 100 0");
  const now = useStore.getState().doc as Document;
  const parentId = now.nodes.get(p)?.parentId as string;
  const [q] = createNodes(now, [{ type: "path", parentId, d: "M 0 100 L 100 100" }]).nodes;
  // q extended, unanswered; then p continued and connected to q: the join is held on it.
  sendAs("a");
  penClick([100, 100], 1);
  penClick([150, 150], 1);
  finishPen();
  penClick([0, 0], 1);
  penClick([0, 100], 1);
  expect(useStore.getState().held).toHaveLength(1);
  // The Pencil extends p from its other Endpoint, on the held join.
  pencilFrom(p, [100, 0], [10, 0]);
  expect(useStore.getState().held).toHaveLength(2);
  const before = sent().length;
  // Someone else edits q, so the join drops when it runs, and the redraw with it.
  const at = useStore.getState().doc as Document;
  const { node } = editPath(structuredClone(at), {
    nodeId: q?.id as string,
    ops: [{ op: "set_d", d: "M 0 100 L 100 120" }],
  });
  land(message("tx", { rev: at.rev + 1, updated: [node] }));
  land(answer("a"));
  const s = useStore.getState();
  expect(sent().slice(before)).toEqual([]);
  expect(s.held).toEqual([]);
  expect(s.notice).toMatch(/^Someone else changed a path the Pen was .*not applied/);
  expect(s.notice).toMatch(/The Pencil edit was not applied, because your earlier edit/);
  expect(stored()).toBe("M 0 0 L 100 0");
});

it("reads a reconnect by whether the person's own edits a held Pencil redraw was drawn on were applied (#309)", () => {
  for (const reconnect of ["as drawn", "as before", "other"] as const) {
    const { p, stored, applied } = dragged();
    pencilFromDrag(p);
    const now = useStore.getState().doc as Document;
    const d = reconnect === "as drawn" ? applied() : structuredClone(now);
    if (reconnect === "other")
      editPath(d, { nodeId: p, ops: [{ op: "set_d", d: "M 0 0 L 90 0" }] });
    land(
      message("document", { rev: now.rev + 1, nodes: [...d.nodes.values()] }),
      reconnect === "as drawn" ? "redraw" : undefined,
    );
    const s = useStore.getState();
    expect(s.held, reconnect).toEqual([]);
    if (reconnect === "as drawn") {
      expect(s.notice, reconnect).toBeNull();
      land(answer("redraw"));
      expect(stored(), reconnect).toBe(REDRAWN);
      continue;
    }
    expect(
      sent().map((c) => c.type),
      reconnect,
    ).toEqual(["path_edit"]);
    expect(s.notice, reconnect).toBe(
      reconnect === "as before"
        ? "The Pencil edit was not applied, because your earlier edit to its path was not."
        : "The Pencil edit was not applied; someone else changed its path.",
    );
  }
});

it("never stores a rejected drag through a Pencil redraw that starts off it, nor draws it after (#309)", () => {
  for (const press of [false, true]) {
    const label = press ? "behind a press" : "sent";
    const { p, stored } = dragged();
    if (press) pressAfter(p);
    const before = sent().map((c) => c.type);
    // From p's last Anchor, which the drag did not move, on to the right: it carries the drag.
    pencilFrom(p, [100, 0], [10, 0]);
    land(message("rejected", { id: "drag" }));
    const { held } = useStore.getState();
    const shown = drawnD(p);
    if (press) {
      const at = useStore.getState().doc as Document;
      land(message("tx", { rev: at.rev + 1, commandId: "press", updated: [] }));
    }
    expect(
      sent().map((c) => c.type),
      label,
    ).toEqual(before);
    expect(stored(), label).toBe(ORIGINAL);
    expect(held, label).toEqual([]);
    expect(shown, label).toBe(ORIGINAL);
  }
});
