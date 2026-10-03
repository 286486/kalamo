import {
  type BareAnchor,
  createDocument,
  createNodes,
  type Document,
  editPath,
  parsePath,
  pathOp,
  toAnchors,
} from "@kalamo/core";
import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_FILL_STROKE, send, useStore } from "./store.ts";
import { message, stateAfter } from "./testing.ts";
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
      useStore.setState({ doc, pen: null, edit: null, notice: null, drag: null });
      vi.mocked(send).mockClear();
      for (const p of clicks) penClick(p, 1);
      const before = { pen: pen(), edit: useStore.getState().edit };
      penDown([30, 0], 1);
      expect(pen()?.to, at).toBeDefined();
      if (label === "the person's own edit")
        useStore.setState({ drag: { nodeIds: [], dx: 0, dy: 0, commandId: "mine" } });
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
