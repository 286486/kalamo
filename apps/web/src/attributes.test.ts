import {
  createDocument,
  createNodes,
  type Document,
  duplicateNodes,
  editPath,
  type LeafNode,
  type Node,
  type PathEditInput,
  type PathNode,
  parsePath,
  pathOp,
  runsClockwise,
  signedArea,
  toAnchors,
  transformNodes,
} from "@kalamo/core";
import type { Command } from "@kalamo/sync";
import { expect, it, vi } from "vitest";
import { convertAnchors } from "./AnchorsBar.tsx";
import { addAnchorTool, anchorPointTool, deleteAnchorTool } from "./anchorTools.ts";
import {
  directionOf,
  fillRuleOf,
  pressDirection,
  setDirection,
  setFillRule,
} from "./attributes.ts";
import { commitDrag } from "./canvas.ts";
import { curvatureCancel, curvatureDown, curvatureDrag, curvatureUp } from "./curvature.ts";
import { allKeys, anchorKey, anchorsOf, localAnchors, parseKey } from "./direct.ts";
import { directTool } from "./directTool.ts";
import { paintUpdates, placeOn, sendPaint } from "./gradient.ts";
import { averageAnchors, documentMenus, findByKeys, type Item, type MenuItem } from "./menu.ts";
import { pencilDown, pencilMove, pencilUp } from "./pencil.ts";
import { type PathDrag, previewAll, previewEdit, previewsOf, type ViewState } from "./receive.ts";
import { sendPreviewedOp } from "./simplify.ts";
import { afterReverse, deliver, record, runHeld, send, unheld, useStore } from "./store.ts";
import { message, stateAfter, viewState } from "./testing.ts";
import type { ToolEvent } from "./toolbox.ts";
import { finishPen, penDown, penUp } from "./tools.ts";

// Records each id as the real `send` does, so the answers tests drive are the person's own (#288).
vi.mock("./store.ts", async (original) => {
  const store = await original<typeof import("./store.ts")>();
  return { ...store, send: vi.fn((c: Command) => store.record("c", c)) };
});

/**
 * A Make result from two concentric circles, a plain rect, a text, a path with a straight subpath
 * and a Group of one path.
 */
function fixture() {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 200 }],
  });
  const circle = (r: number) =>
    ({ type: "ellipse", parentId, x: 100 - r, y: 100 - r, width: 2 * r, height: 2 * r }) as const;
  const { keyMap } = createNodes(doc, [
    { ...circle(50), clientKey: "outer" },
    { ...circle(20), clientKey: "inner" },
    { type: "rect", clientKey: "r", parentId, x: 0, y: 0, width: 10, height: 10 },
    { type: "text", clientKey: "t", parentId, x: 0, y: 0, content: "Hi" },
    { type: "path", clientKey: "line", parentId, d: "M0 0 L9 0 L9 9 Z M20 0 L30 0" },
    {
      type: "group",
      clientKey: "g",
      parentId,
      children: [
        {
          type: "path",
          clientKey: "odd",
          fillRule: "evenodd",
          d: "M0 0 L9 0 L9 9 Z M1 1 L2 1 L2 2 Z",
        },
      ],
    },
  ]);
  const id = (k: string) => keyMap[k] as string;
  const [made] = pathOp(doc, { nodeIds: [id("outer"), id("inner")], op: "make_compound_path" })
    .created as Node[];
  const ring = (made as Node).id;
  const base = { doc, anchors: [] as string[], segments: [] as string[], role: "owner" as const };
  return { doc, id, ring, base };
}
/** A pointer event at (x, y) at 100%. */
const event = (doc: Document, x: number, y: number, shift = false) =>
  ({
    x,
    y,
    points: [[x, y]],
    shift,
    alt: false,
    doc,
    viewport: { x: 0, y: 0, scale: 1 },
    capture() {},
    redraw() {},
  }) as unknown as ToolEvent;
const commands = () => vi.mocked(send).mock.calls.map(([c]) => c);
/** The Anchor the first op of a `path_edit`'s `input` names. */
const firstIndex = (input: PathEditInput | undefined) => {
  const op = input?.ops[0];
  return op && "index" in op ? op.index : undefined;
};

/**
 * Two Compound Paths, each a clockwise square with a counter-clockwise hole; `hole` draws a's at
 * x = 0.
 */
function rings(hole?: string) {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 200 }],
  });
  const ring = (x: number) =>
    `M${x} 0 L${x + 30} 0 L${x + 30} 30 L${x} 30 Z M${x + 10} 10 L${x + 10} 20 L${x + 20} 20 L${x + 20} 10 Z`;
  const [a, b] = createNodes(doc, [
    { type: "path", parentId, d: hole ? `M0 0 L30 0 L30 30 L0 30 Z ${hole}` : ring(0) },
    { type: "path", parentId, d: ring(50) },
  ]).nodes as [Node, Node];
  return { doc, a, b };
}

it("measures a subpath's direction on screen, y down, exactly for curves", () => {
  const [square] = toAnchors(parsePath("M0 0 L10 0 L10 10 L0 10 Z", "d"));
  expect(signedArea(square as never)).toBe(200);
  const [circle] = toAnchors(
    parsePath(
      "M10 0 C10 5.523 5.523 10 0 10 C-5.523 10 -10 5.523 -10 0 C-10 -5.523 -5.523 -10 0 -10 C5.523 -10 10 -5.523 10 0 Z",
      "d",
    ),
  );
  // Clockwise on screen, twice πr².
  expect(signedArea(circle as never)).toBeCloseTo(2 * Math.PI * 100, 0);
});

it("shows and sets the selected paths' fill rule, a Group's too, one command, nothing when unchanged", () => {
  vi.mocked(send).mockClear();
  const { id, ring, base } = fixture();
  const s = (selection: string[], role: "owner" | "viewer" = "owner") => ({
    ...base,
    selection,
    role,
  });
  expect(fillRuleOf(s([ring]))).toBe("nonzero");
  expect(fillRuleOf(s([id("g")]))).toBe("evenodd");
  expect(fillRuleOf(s([ring, id("g")]))).toBe("mixed");
  // A Live Shape, a text or nothing has no fill rule to show.
  expect(fillRuleOf(s([id("r"), id("t")]))).toBeNull();
  expect(fillRuleOf(s([]))).toBeNull();
  expect(fillRuleOf(s([ring], "viewer"))).toBeNull();
  setFillRule(s([ring, id("g")]), "evenodd");
  setFillRule(s([id("g")]), "evenodd");
  expect(commands()).toEqual([{ type: "fill_rule", nodeIds: [ring], fillRule: "evenodd" }]);
});

it("reads a Make result as Illustrator's, backmost Off and hole On, and sets a chosen subpath's direction", () => {
  vi.mocked(send).mockClear();
  const { id, ring, base } = fixture();
  const s = (anchors: string[], segments: string[] = []) => ({
    ...base,
    selection: [ring],
    anchors,
    segments,
    reversing: null,
  });
  expect(directionOf(s([anchorKey(ring, 0, 0)]))).toBe(false);
  expect(directionOf(s([anchorKey(ring, 1, 0), anchorKey(ring, 1, 2)]))).toBe(true);
  expect(directionOf(s([anchorKey(ring, 0, 0)], [anchorKey(ring, 1, 0)]))).toBe("mixed");
  // No Direct Selection, a one-subpath path or an evenodd one: nothing to set.
  expect(directionOf(s([]))).toBeNull();
  const odd = id("odd");
  expect(directionOf({ ...s([anchorKey(odd, 0, 0)]), selection: [odd] })).toBeNull();
  // A straight subpath has no direction, so On could never show as set.
  const line = id("line");
  expect(directionOf({ ...s([anchorKey(line, 1, 0)]), selection: [line] })).toBeNull();
  const both = { ...s([anchorKey(line, 0, 0), anchorKey(line, 1, 0)]), selection: [line] };
  expect(directionOf(both)).toBe(true);
  setDirection(s([anchorKey(ring, 1, 0)]), true);
  setDirection(s([anchorKey(ring, 1, 0), anchorKey(ring, 1, 1)], [anchorKey(ring, 1, 3)]), false);
  expect(commands()).toEqual([
    { type: "path_reverse", subpaths: [{ nodeId: ring, subpath: 1 }], clockwise: false },
  ]);
  const reversing = useStore.getState().reversing;
  expect(reversing).toEqual({
    commandId: "c",
    subpaths: [{ nodeId: ring, subpath: 1 }],
    clockwise: false,
    inputs: [{ nodeId: ring, ops: [{ op: "reverse", subpath: 1 }] }],
  });
  // In flight, the pressed subpath shows the direction pressed; the other its own (#276).
  expect(directionOf({ ...s([anchorKey(ring, 1, 0)]), reversing })).toBe(false);
  expect(directionOf({ ...s([anchorKey(ring, 0, 0), anchorKey(ring, 1, 0)]), reversing })).toBe(
    false,
  );
  if (!reversing) throw new Error("no press");
  const other = { ...reversing, subpaths: [{ nodeId: ring, subpath: 0 }] };
  expect(directionOf({ ...s([anchorKey(ring, 1, 0)]), reversing: other })).toBe(true);
});

it("disables both rows for a locked, hidden or locked-Group path and an Image, and Reverse for a plain path", () => {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 200 }],
  });
  const d = "M0 0 L9 0 L9 9 Z M1 1 L1 2 L2 2 Z";
  const { keyMap } = createNodes(doc, [
    { type: "path", clientKey: "locked", parentId, d },
    { type: "path", clientKey: "hidden", parentId, d },
    { type: "group", clientKey: "g", parentId, children: [{ type: "path", d }] },
    { type: "image", clientKey: "i", parentId, x: 0, y: 0, width: 2, height: 2, file: "a.png" },
    { type: "path", clientKey: "plain", parentId, d: "M0 0 L9 0 L9 9 Z" },
  ]);
  for (const [key, patch] of [
    ["locked", { locked: true }],
    ["hidden", { visible: false }],
    ["g", { locked: true }],
  ] as const) {
    const n = doc.nodes.get(keyMap[key] as string) as Node;
    doc.nodes.set(n.id, { ...n, ...patch });
  }
  const one = (key: string) => {
    const nodeId = keyMap[key] as string;
    const leaf = [...doc.nodes.values()].find((c) => c.parentId === nodeId)?.id ?? nodeId;
    return {
      doc,
      role: "owner" as const,
      selection: [leaf],
      anchors: [anchorKey(leaf, 0, 0)],
      segments: [],
      reversing: null,
    };
  };
  for (const key of ["locked", "hidden", "g", "i"]) {
    expect([fillRuleOf(one(key)), directionOf(one(key))]).toEqual([null, null]);
  }
  expect([fillRuleOf(one("plain")), directionOf(one("plain"))]).toEqual(["nonzero", null]);
});

/** Where `key` is in `d`, in the path's own coordinates. */
const at = (d: Document, key: string) => {
  const { nodeId, subpath, index } = parseKey(key);
  return localAnchors(d.nodes.get(nodeId) as PathNode)[subpath]?.anchors[index]?.anchor;
};
const reversed = (d: Document, nodeId: string) =>
  editPath({ ...d, nodes: new Map(d.nodes) }, { nodeId, ops: [{ op: "reverse", subpath: 1 }] })
    .node;
const rejected = message("rejected", {
  id: "c",
  error: { code: "INVALID_PATH", message: "No.", hint: "" },
});

/** Both rings selected with the keys `keys` names, after a press of On (command id "c"). */
function pressOn(keys: (a: Node, b: Node) => Partial<ViewState>, hole?: string) {
  vi.mocked(send).mockClear();
  // Every command is "c" again, after `serve` numbered them.
  vi.mocked(send).mockImplementation((c) => record("c", c));
  const { doc, a, b } = rings(hole);
  const state = viewState({ doc, selection: [a.id, b.id], role: "owner", ...keys(a, b) });
  setDirection(state, true);
  const pressed = { ...state, reversing: useStore.getState().reversing };
  /** The press's Transaction, reversing the holes of `ids` in `d`. */
  const answer = (d: Document, ...ids: string[]) =>
    message("tx", { rev: d.rev + 1, commandId: "c", updated: ids.map((id) => reversed(d, id)) });
  return { doc, a, b, state, pressed, answer };
}

it("keeps the keys until the answer, which renumbers them; a rejection leaves them (ADR-0110)", () => {
  const { doc, a, b, state, pressed, answer } = pressOn((a, b) => ({
    anchors: [anchorKey(a.id, 1, 1), anchorKey(b.id, 1, 2), anchorKey(b.id, 0, 1)],
    segments: [anchorKey(a.id, 1, 3), anchorKey(b.id, 1, 0)],
  }));
  const holes = [
    { nodeId: a.id, subpath: 1 },
    { nodeId: b.id, subpath: 1 },
  ];
  expect(commands()).toEqual([{ type: "path_reverse", subpaths: holes, clockwise: true }]);
  // The press sets no key, and its preview is its own, not the Direct Selection's.
  expect(pressed.reversing).toMatchObject({
    commandId: "c",
    subpaths: holes,
    inputs: [{ nodeId: a.id }, { nodeId: b.id }],
  });
  const accepted = { ...pressed, ...stateAfter(pressed, answer(doc, a.id, b.id)) };
  expect(accepted).toMatchObject({
    reversing: null,
    anchors: [anchorKey(a.id, 1, 3), anchorKey(b.id, 1, 2), anchorKey(b.id, 0, 1)],
    segments: [anchorKey(a.id, 1, 0), anchorKey(b.id, 1, 3)],
  });
  for (const [i, key] of state.anchors.entries()) {
    expect(at(accepted.doc as Document, accepted.anchors[i] as string)).toEqual(at(doc, key));
  }
  expect(stateAfter(pressed, rejected)).toMatchObject({ reversing: null, notice: "No." });
  expect(stateAfter(pressed, rejected)).not.toHaveProperty("anchors");
});

it("renumbers an Anchor clicked while the press is in flight with the rest (ADR-0110)", () => {
  const { doc, a, pressed, answer } = pressOn((a) => ({ anchors: [anchorKey(a.id, 1, 1)] }));
  useStore.setState(pressed);
  // Shift-click a's hole at (20, 10), its Anchor 3 as the Document runs.
  directTool.down(event(doc, 20, 10, true));
  const clicked = useStore.getState();
  expect(clicked.anchors).toEqual([anchorKey(a.id, 1, 1), anchorKey(a.id, 1, 3)]);
  const accepted = stateAfter(clicked, answer(doc, a.id));
  expect(accepted.anchors).toEqual([anchorKey(a.id, 1, 3), anchorKey(a.id, 1, 1)]);
  expect(at(accepted.doc as Document, anchorKey(a.id, 1, 1))).toEqual([20, 10]);
  expect(stateAfter(clicked, rejected)).not.toHaveProperty("anchors");
});

it("sends a drag made while the press is in flight once it is answered, on the chosen Anchor", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    // a's hole's first Anchor, at (10, 10), which the reverse keeps first.
    const { doc, a, pressed, answer } = pressOn((a) => ({ anchors: [anchorKey(a.id, 1, 0)] }));
    useStore.setState({ ...pressed, edit: null, drag: null });
    vi.mocked(send).mockClear();
    // Drag a's hole Anchor at (20, 10) right by 5, released before the answer.
    directTool.down(event(doc, 20, 10));
    directTool.move?.(event(doc, 25, 10));
    directTool.up?.(event(doc, 25, 10));
    expect(commands()).toEqual([]);
    const msg = outcome === "accepted" ? answer(doc, a.id) : rejected;
    deliver(msg, "d", 0);
    const index = outcome === "accepted" ? 1 : 3;
    expect(commands()).toEqual([
      {
        type: "path_edit",
        input: { nodeId: a.id, ops: [{ op: "move_anchor", subpath: 1, index, to: [25, 10] }] },
      },
    ]);
  }
});

it("keeps a drag on its Anchor and segment when the answer comes mid-drag", () => {
  // a's hole's first Anchor, at (10, 10), which the reverse keeps first.
  const { doc, a, pressed, answer } = pressOn((a) => ({ anchors: [anchorKey(a.id, 1, 0)] }));
  const settle = () => {
    deliver(answer(doc, a.id), "d", 0);
  };
  const ops = () => useStore.getState().edit?.inputs[0]?.ops;
  // An Anchor: (20, 10) is a's hole Anchor 3, then 1.
  useStore.setState({ ...pressed, edit: null, drag: null });
  directTool.down(event(doc, 20, 10));
  directTool.move?.(event(doc, 25, 10));
  expect(ops()).toMatchObject([{ op: "move_anchor", index: 3, to: [25, 10] }]);
  settle();
  const now = useStore.getState().doc as Document;
  directTool.move?.(event(now, 26, 10));
  expect(ops()).toMatchObject([{ op: "move_anchor", index: 1, to: [26, 10] }]);
  directTool.cancel?.(() => {});
  // A segment: a's hole runs (10, 10) to (10, 20) first, segment 0, and after the reverse its
  // segment 3 runs back along it; grabbed a quarter along, it is grabbed three quarters along.
  useStore.setState({ ...pressed, edit: null, drag: null });
  directTool.down(event(doc, 10, 12.5));
  directTool.move?.(event(doc, 15, 12.5));
  expect(ops()).toMatchObject([
    { op: "move_anchor", index: 0, to: [15, 10] },
    { op: "move_anchor", index: 1, to: [15, 20] },
  ]);
  settle();
  directTool.move?.(event(useStore.getState().doc as Document, 16, 12.5));
  expect(ops()).toMatchObject([
    { op: "move_anchor", index: 3, to: [16, 20] },
    { op: "move_anchor", index: 0, to: [16, 10] },
  ]);
  directTool.cancel?.(() => {});
});

it("keeps a Handle drag on its Handle when the answer comes mid-drag", () => {
  vi.mocked(send).mockClear();
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 200 }],
  });
  // A hole whose first segment curves, with Anchor 0's out Handle at (10, 15).
  const [ring] = createNodes(doc, [
    {
      type: "path",
      parentId,
      d: "M0 0 L30 0 L30 30 L0 30 Z M10 10 C10 15 10 15 10 20 L20 20 L20 10 Z",
    },
  ]).nodes as [Node];
  const state = viewState({
    doc,
    selection: [ring.id],
    role: "owner",
    anchors: [anchorKey(ring.id, 1, 0)],
  });
  setDirection(state, true);
  const pressed = { ...state, reversing: useStore.getState().reversing, edit: null };
  const ops = () => useStore.getState().edit?.inputs[0]?.ops;
  // The answer turns the Handle held; another Actor's reverse before it lets go of the drag, so it
  // previews nothing (#297).
  for (const theirs of [false, true]) {
    useStore.setState(pressed);
    directTool.down(event(doc, 10, 15));
    directTool.move?.(event(doc, 15, 15));
    expect(ops()).toMatchObject([{ op: "set_handles", index: 0, handleOut: [15, 15] }]);
    const msg = message("tx", {
      rev: doc.rev + 1,
      ...(theirs ? { actor: "agent" } : { commandId: "c" }),
      updated: [reversed(doc, ring.id)],
    });
    deliver(msg, "d", 0);
    directTool.move?.(event(useStore.getState().doc as Document, 16, 15));
    // Reversed, Anchor 0 stays first and the Handle is its in Handle.
    if (theirs) expect(ops()).toBeUndefined();
    else expect(ops()).toMatchObject([{ op: "set_handles", index: 0, handleIn: [16, 15] }]);
    directTool.cancel?.(() => {});
  }
});

// #296, #297: a drag still being made follows the answer to the person's own press, and another
// Actor's edit to its path lets go of it. Each grabs a's hole, or `hole` when given, at `at`, with
// the hole's Anchor 0 selected; `index` is the first op's before and after the answer. (20, 10) is
// the hole's Anchor 3, then 1; its segment 0 runs back as segment 3.
const grabs: Record<
  string,
  {
    at: [number, number];
    index: [number, number];
    hole?: string;
    down: (doc: Document, x: number, y: number) => void;
    move: (doc: Document, x: number, y: number) => void;
    up: (doc: Document, x: number, y: number) => void;
    cancel: () => void;
  }
> = {
  "a Direct Selection Anchor drag": {
    at: [20, 10],
    index: [3, 1],
    down: (doc, x, y) => directTool.down(event(doc, x, y)),
    move: (doc, x, y) => directTool.move?.(event(doc, x, y)),
    up: (doc, x, y) => directTool.up?.(event(doc, x, y)),
    cancel: () => directTool.cancel?.(() => {}),
  },
  "a Direct Selection Handle drag": {
    // Anchor 0's in Handle, at (12, 10), which the reverse makes its out Handle.
    at: [12, 10],
    index: [0, 0],
    hole: "M10 10 L10 20 L20 20 L20 10 C18 10 12 10 10 10 Z",
    down: (doc, x, y) => directTool.down(event(doc, x, y)),
    move: (doc, x, y) => directTool.move?.(event(doc, x, y)),
    up: (doc, x, y) => directTool.up?.(event(doc, x, y)),
    cancel: () => directTool.cancel?.(() => {}),
  },
  "a Direct Selection segment drag": {
    at: [10, 12.5],
    index: [0, 3],
    down: (doc, x, y) => directTool.down(event(doc, x, y)),
    move: (doc, x, y) => directTool.move?.(event(doc, x, y)),
    up: (doc, x, y) => directTool.up?.(event(doc, x, y)),
    cancel: () => directTool.cancel?.(() => {}),
  },
  "an Anchor Point drag out of an Anchor": {
    at: [20, 10],
    index: [3, 1],
    down: (doc, x, y) => anchorPointTool.down?.(event(doc, x, y)),
    move: (doc, x, y) => anchorPointTool.move?.(event(doc, x, y)),
    up: (doc, x, y) => anchorPointTool.up?.(event(doc, x, y)),
    cancel: () => anchorPointTool.cancel?.(() => {}),
  },
  "an Anchor Point drag of a segment": {
    at: [10, 15],
    index: [0, 3],
    down: (doc, x, y) => anchorPointTool.down?.(event(doc, x, y)),
    move: (doc, x, y) => anchorPointTool.move?.(event(doc, x, y)),
    up: (doc, x, y) => anchorPointTool.up?.(event(doc, x, y)),
    cancel: () => anchorPointTool.cancel?.(() => {}),
  },
  "a Curvature drag": {
    at: [20, 10],
    index: [3, 1],
    down: (_, x, y) => {
      // A press far away first, so a press here again is never read as a double-click.
      curvatureDown([-1000, -1000], 1, false);
      curvatureCancel();
      useStore.setState({ pen: null });
      curvatureDown([x, y], 1, false);
    },
    move: (_, x, y) => curvatureDrag([x, y]),
    up: () => curvatureUp(),
    cancel: () => curvatureCancel(),
  },
};

it("renumbers a drag still being made by the answer alone; another Actor's reverse lets go of it", () => {
  vi.useFakeTimers();
  for (const [name, g] of Object.entries(grabs)) {
    for (const source of ["answer", "rejected", "theirs"] as const) {
      const label = `${name}, ${source}`;
      const { doc, a, pressed, answer } = pressOn(
        (a) => ({ anchors: [anchorKey(a.id, 1, 0)] }),
        g.hole,
      );
      useStore.setState({ ...pressed, edit: null, drag: null, held: [], sentPreviews: [] });
      vi.advanceTimersByTime(1000);
      const index = () => firstIndex(useStore.getState().edit?.inputs[0]);
      const [x, y] = g.at;
      g.down(doc, x, y);
      g.move(doc, x + 5, y);
      expect(index(), label).toBe(g.index[0]);
      const msg =
        source === "answer"
          ? answer(doc, a.id)
          : source === "rejected"
            ? rejected
            : message("tx", { rev: doc.rev + 1, actor: "agent", updated: [reversed(doc, a.id)] });
      deliver(msg, "d", 0);
      const now = useStore.getState().doc as Document;
      if (source === "theirs") {
        // The drag lets go at once, with its preview, and shows the path as the Agent left it.
        expect(useStore.getState().edit, label).toBeNull();
        expect(useStore.getState().notice, label).toBeNull();
        expect(now.nodes.get(a.id), label).toEqual(reversed(doc, a.id));
      }
      g.move(now, x + 6, y);
      const after = { answer: g.index[1], rejected: g.index[0], theirs: undefined }[source];
      expect(index(), label).toBe(after);
      vi.mocked(send).mockClear();
      g.up(now, x + 6, y);
      if (source === "theirs") {
        // Released while the press is still in flight, nothing is held: the answer neither renumbers
        // nor brings back what the Agent's edit let go of, and nothing is sent.
        expect(commands(), label).toEqual([]);
        expect(useStore.getState().held, label).toEqual([]);
        deliver(answer(now, a.id), "d", 0);
        expect(commands(), label).toEqual([]);
        expect(useStore.getState().notice, label).toBeNull();
        continue;
      }
      // Released after the answer or the rejection, the edit is sent on the target as it left it.
      const [sent] = commands();
      expect(sent?.type === "path_edit" && firstIndex(sent.input), label).toBe(after);
    }
  }
  vi.useRealTimers();
});

/**
 * Each gesture in `grabs` made on a's hole with no press in flight, dragged right by 5; `then` is
 * the message that comes mid-drag, from the Document `doc` as the drag began.
 */
function dragThrough(
  then: (doc: Document, a: Node, b: Node) => Parameters<typeof stateAfter>[1],
  check: (label: string, g: (typeof grabs)[string], ctx: { doc: Document; a: Node }) => void,
) {
  for (const [name, g] of Object.entries(grabs)) {
    vi.mocked(send).mockClear();
    const { doc, a, b } = rings(g.hole);
    const keys = { anchors: [anchorKey(a.id, 1, 0)] };
    useStore.setState(viewState({ doc, selection: [a.id, b.id], role: "owner", ...keys }));
    const [x, y] = g.at;
    g.down(doc, x, y);
    g.move(doc, x + 5, y);
    expect(firstIndex(useStore.getState().edit?.inputs[0]), name).toBe(g.index[0]);
    deliver(then(doc, a, b), "d", 0);
    check(name, g, { doc, a });
  }
}

/** The rest of a drag from `dragThrough`: a move, then the release; what each sent. */
function finish(g: (typeof grabs)[string]) {
  const now = useStore.getState().doc as Document;
  const [x, y] = g.at;
  vi.mocked(send).mockClear();
  g.move(now, x + 6, y);
  const moved = firstIndex(useStore.getState().edit?.inputs[0]);
  g.up(now, x + 6, y);
  return { moved, sent: commands() };
}

it("lets go of a drag when another Actor edits or deletes its path, no press in flight", () => {
  const { doc: d, a: p } = rings();
  // Anchor 2 of a's hole moved to (-30, 40) turns the hole the other way and renumbers nothing.
  const flip = (doc: Document, a: Node) =>
    editPath(
      { ...doc, nodes: new Map(doc.nodes) },
      { nodeId: a.id, ops: [{ op: "move_anchor", subpath: 1, index: 2, to: [-30, 40] }] },
    ).node;
  expect(runsClockwise(d, p as PathNode, 1)).not.toBe(runsClockwise(d, flip(d, p), 1));
  const edits = {
    reverse: (doc: Document, a: Node) => ({ updated: [reversed(doc, a.id)] }),
    "added Anchor": (doc: Document, a: Node) => ({
      updated: [
        editPath(
          { ...doc, nodes: new Map(doc.nodes) },
          { nodeId: a.id, ops: [{ op: "add_anchor", subpath: 1, segment: 0, t: 0.5 }] },
        ).node,
      ],
    }),
    "winding flip": (doc: Document, a: Node) => ({ updated: [flip(doc, a)] }),
    delete: (_: Document, a: Node) => ({ updated: [], deletedIds: [a.id] }),
  };
  for (const [kind, edit] of Object.entries(edits)) {
    let theirs: Node | undefined;
    dragThrough(
      (doc, a) => {
        const e = edit(doc, a);
        theirs = e.updated[0];
        return message("tx", { rev: doc.rev + 1, actor: "agent", ...e });
      },
      (name, g, { a }) => {
        const label = `${name}, ${kind}`;
        const s = useStore.getState();
        expect(s.edit, label).toBeNull();
        expect(s.notice, label).toBeNull();
        expect(s.doc?.nodes.get(a.id), label).toEqual(theirs);
        expect(finish(g), label).toEqual({ moved: undefined, sent: [] });
        expect(useStore.getState().notice, label).toBeNull();
      },
    );
  }
});

it("keeps a drag going through another Actor's edit to a different path", () => {
  dragThrough(
    (doc, _, b) =>
      message("tx", { rev: doc.rev + 1, actor: "agent", updated: [reversed(doc, b.id)] }),
    (name, g) => {
      const { moved, sent } = finish(g);
      expect(moved, name).toBe(g.index[0]);
      expect(sent.length, name).toBe(1);
      const [c] = sent;
      expect(c?.type === "path_edit" && firstIndex(c.input), name).toBe(g.index[0]);
    },
  );
});

it("keeps a drag going through the answer to the person's own earlier edit on the same path", () => {
  for (const [name, g] of Object.entries(grabs)) {
    vi.mocked(send).mockClear();
    const { doc, a, b } = rings(g.hole);
    const keys = { anchors: [anchorKey(a.id, 1, 0)] };
    useStore.setState(viewState({ doc, selection: [a.id, b.id], role: "owner", ...keys }));
    const [x, y] = g.at;
    // The earlier drag, sent as command "c" and not yet answered.
    g.down(doc, x, y);
    g.move(doc, x + 5, y);
    g.up(doc, x + 5, y);
    const earlier = useStore.getState().sentPreviews.at(-1)?.edit;
    expect(earlier?.commandIds, name).toEqual(["c"]);
    // The next drag on the same path, whose preview takes the screen before that answer.
    g.down(doc, x, y);
    g.move(doc, x + 4, y);
    const answer = message("tx", {
      rev: doc.rev + 1,
      commandId: "c",
      updated: [previewEdit(doc, earlier as PathDrag).nodes.get(a.id) as Node],
    });
    deliver(answer, "d", 0);
    expect(firstIndex(useStore.getState().edit?.inputs[0]), name).toBe(g.index[0]);
    const { moved, sent } = finish(g);
    expect(moved, name).toBe(g.index[0]);
    expect(sent.length, name).toBe(1);
  }
});

it("lets go only of the Anchors on the path another Actor edits, in a drag of two paths", () => {
  vi.mocked(send).mockClear();
  const { doc, a, b } = rings();
  // Each hole's Anchor 3, a's at (20, 10) and b's at (70, 10), dragged together.
  const anchors = [anchorKey(a.id, 1, 3), anchorKey(b.id, 1, 3)];
  useStore.setState(viewState({ doc, selection: [a.id, b.id], role: "owner", anchors }));
  const paths = () => useStore.getState().edit?.inputs.map((i) => i.nodeId);
  directTool.down(event(doc, 20, 10));
  directTool.move?.(event(doc, 25, 10));
  expect(paths()).toEqual([a.id, b.id]);
  const theirs = message("tx", {
    rev: doc.rev + 1,
    actor: "agent",
    updated: [reversed(doc, a.id)],
  });
  deliver(theirs, "d", 0);
  expect(paths()).toEqual([b.id]);
  const now = useStore.getState().doc as Document;
  directTool.move?.(event(now, 26, 10));
  expect(useStore.getState().edit?.inputs).toEqual([
    { nodeId: b.id, ops: [{ op: "move_anchor", subpath: 1, index: 3, to: [76, 10] }] },
  ]);
  directTool.up?.(event(now, 26, 10));
  expect(commands()).toEqual([
    {
      type: "path_edit",
      input: { nodeId: b.id, ops: [{ op: "move_anchor", subpath: 1, index: 3, to: [76, 10] }] },
    },
  ]);
});

it("after a reconnect mid-drag, keeps the drag only on a path as it was or as the press leaves it", () => {
  const snapshot = (doc: Document, swap: (n: Node) => Node | null) =>
    message("document", {
      rev: doc.rev + 1,
      nodes: [...doc.nodes.values()].flatMap((n) => swap(n) ?? []),
    });
  // No press in flight: unchanged keeps the drag; reversed or deleted, by whoever, lets it go.
  const cases = {
    unchanged: (_: Document, n: Node) => n,
    reversed: (doc: Document, n: Node, a: Node) => (n.id === a.id ? reversed(doc, a.id) : n),
    deleted: (_: Document, n: Node, a: Node) => (n.id === a.id ? null : n),
  };
  for (const [kind, swap] of Object.entries(cases)) {
    dragThrough(
      (doc, a) => snapshot(doc, (n) => swap(doc, n, a)),
      (name, g) => {
        const label = `${name}, ${kind}`;
        expect(useStore.getState().notice, label).toBeNull();
        const { moved, sent } = finish(g);
        if (kind !== "unchanged")
          return expect({ moved, sent }, label).toEqual({ moved: undefined, sent: [] });
        expect(moved, label).toBe(g.index[0]);
        const [c] = sent;
        expect(c?.type === "path_edit" && firstIndex(c.input), label).toBe(g.index[0]);
      },
    );
  }
  // With a press in flight, the press's reverse renumbers the drag, as its answer does (#296); any
  // other reshape lets it go.
  vi.useFakeTimers();
  const reshapes = {
    reversed: reversed,
    "added Anchor": (doc: Document, id: string) =>
      editPath(
        { ...doc, nodes: new Map(doc.nodes) },
        { nodeId: id, ops: [{ op: "add_anchor", subpath: 1, segment: 0, t: 0.5 }] },
      ).node,
  };
  for (const [kind, reshape] of Object.entries(reshapes)) {
    for (const [name, g] of Object.entries(grabs)) {
      const label = `${name}, ${kind}`;
      const { doc, a, pressed } = pressOn((a) => ({ anchors: [anchorKey(a.id, 1, 0)] }), g.hole);
      useStore.setState({ ...pressed, edit: null, drag: null, held: [], sentPreviews: [] });
      vi.advanceTimersByTime(1000);
      const [x, y] = g.at;
      g.down(doc, x, y);
      g.move(doc, x + 5, y);
      const msg = snapshot(doc, (n) => (n.id === a.id ? reshape(doc, a.id) : n));
      deliver(msg, "d", 0);
      const { moved, sent } = finish(g);
      if (kind !== "reversed") {
        expect({ moved, sent }, label).toEqual({ moved: undefined, sent: [] });
        continue;
      }
      expect(moved, label).toBe(g.index[1]);
      const [c] = sent;
      expect(c?.type === "path_edit" && firstIndex(c.input), label).toBe(g.index[1]);
    }
  }
  vi.useRealTimers();
});

it("holds Direct Selection edits while a press is in flight and runs them in order after it", () => {
  const ran: number[] = [];
  const inFlight = { commandId: "c", subpaths: [], clockwise: true, inputs: [] };
  useStore.setState({ reversing: inFlight });
  afterReverse(() => ran.push(1));
  // A second press holds what comes after it.
  afterReverse(() => {
    ran.push(2);
    useStore.setState({ reversing: { ...inFlight, commandId: "c2" } });
  });
  afterReverse(() => ran.push(3));
  expect(ran).toEqual([]);
  useStore.setState({ reversing: null });
  runHeld();
  expect(ran).toEqual([1, 2]);
  useStore.setState({ reversing: null });
  runHeld();
  expect(ran).toEqual([1, 2, 3]);
  afterReverse(() => ran.push(4));
  expect(ran).toEqual([1, 2, 3, 4]);
});

it("after a press another Actor raced, names only the Anchors the Direct Selection named (ADR-0109)", () => {
  const { a, b, pressed, answer } = pressOn((a, b) => ({
    anchors: [anchorKey(a.id, 1, 1), anchorKey(b.id, 1, 1)],
  }));
  // An Agent reverses a's hole first, so the answer reverses only b's.
  const theirs = message("tx", {
    rev: (pressed.doc as Document).rev + 1,
    actor: "agent",
    updated: [reversed(pressed.doc as Document, a.id)],
  });
  const raced = { ...pressed, ...stateAfter(pressed, theirs) };
  expect(raced.anchors).toEqual([anchorKey(b.id, 1, 1)]);
  // The person then chooses an Anchor on a again, numbered as a now runs.
  const chosen = { ...raced, anchors: [...raced.anchors, anchorKey(a.id, 1, 1)] };
  const shown = chosen.doc as Document;
  const answered = { ...chosen, ...stateAfter(chosen, answer(shown, b.id)) };
  // b's follows the reverse to the same point; a's, which the answer left alone, stays.
  expect(answered).toMatchObject({
    reversing: null,
    anchors: [anchorKey(b.id, 1, 3), anchorKey(a.id, 1, 1)],
  });
  expect(at(answered.doc as Document, anchorKey(b.id, 1, 3))).toEqual([60, 20]);
  expect(stateAfter(chosen, rejected)).not.toHaveProperty("anchors");
});

it("after a reconnect, renumbers the keys only on a subpath the press reached", () => {
  const { doc, a, b, pressed } = pressOn((a, b) => ({
    anchors: [anchorKey(a.id, 1, 1), anchorKey(b.id, 1, 1)],
  }));
  // The press reached the Document DO for b only before the socket dropped.
  const nodes = [...doc.nodes.values()].map((n) => (n.id === b.id ? reversed(doc, b.id) : n));
  const snapshot = message("document", { rev: doc.rev + 1, nodes });
  // So too with another of the person's commands unanswered, such as a delete sent unheld (#298).
  for (const renumbering of [new Map(), new Map([["k", null]])]) {
    const s = { ...pressed, renumbering };
    expect({ ...s, ...stateAfter(s, snapshot) }).toMatchObject({
      edit: null,
      reversing: null,
      anchors: [anchorKey(a.id, 1, 1), anchorKey(b.id, 1, 3)],
    });
  }
});

// #276: on a reconnect, a winding flipped by someone else's reshape is not the press's reverse.
it("after a reconnect, drops the keys on a path someone else reshaped instead of renumbering them", () => {
  const { doc, a, b, pressed } = pressOn((a, b) => ({
    anchors: [anchorKey(a.id, 1, 1), anchorKey(b.id, 1, 1), anchorKey(b.id, 0, 1)],
    segments: [anchorKey(b.id, 1, 0)],
  }));
  // The press reversed a's hole; an Agent redrew b's hole running the other way, as no reverse would.
  const theirs = { ...b, d: "M50 0 L80 0 L80 30 L50 30 Z M60 10 L70 10 L70 25 L60 20 Z" } as Node;
  const nodes = [...doc.nodes.values()].map((n) =>
    n.id === a.id ? reversed(doc, a.id) : n.id === b.id ? theirs : n,
  );
  const snapshot = message("document", { rev: doc.rev + 2, nodes });
  expect(stateAfter(pressed, snapshot)).toMatchObject({
    reversing: null,
    anchors: [anchorKey(a.id, 1, 3)],
    segments: [],
  });
});

it("runs a held edit on the Anchors chosen when it was made, renumbered, not on a later click", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    const { doc, a, b, pressed, answer } = pressOn((a, b) => ({
      anchors: [anchorKey(a.id, 1, 1), anchorKey(b.id, 1, 1)],
    }));
    useStore.setState({ ...pressed, held: [] });
    const seen: string[][] = [];
    afterReverse((s) => seen.push(s.anchors));
    // A click after the edit, on a's hole Anchor 3 at (20, 10), is not the edit's.
    directTool.down(event(doc, 20, 10));
    directTool.up?.(event(doc, 20, 10));
    expect(useStore.getState().anchors).toEqual([anchorKey(a.id, 1, 3)]);
    const msg = outcome === "accepted" ? answer(doc, a.id, b.id) : rejected;
    deliver(msg, "d", 0);
    const [anchors] = seen as [string[]];
    expect(anchors).toEqual(
      outcome === "accepted"
        ? [anchorKey(a.id, 1, 3), anchorKey(b.id, 1, 3)]
        : [anchorKey(a.id, 1, 1), anchorKey(b.id, 1, 1)],
    );
    expect(at(useStore.getState().doc as Document, anchors[0] as string)).toEqual(
      at(doc, anchorKey(a.id, 1, 1)),
    );
  }
});

it("clears a held edit's keys on a path another Actor edits before the answer (ADR-0109)", () => {
  const { doc, a, b, pressed, answer } = pressOn((a, b) => ({
    anchors: [anchorKey(a.id, 1, 1), anchorKey(b.id, 1, 1)],
  }));
  useStore.setState({ ...pressed, held: [] });
  const seen: string[][] = [];
  afterReverse((s) => seen.push(s.anchors));
  // a Handle drag on a's hole, held too: an Agent's edit to a drops it.
  vi.mocked(send).mockClear();
  directTool.down(event(doc, 20, 20));
  directTool.move?.(event(doc, 25, 20));
  directTool.up?.(event(doc, 25, 20));
  const theirs = message("tx", {
    rev: doc.rev + 1,
    actor: "agent",
    updated: [reversed(doc, a.id)],
  });
  deliver(theirs, "d", 0);
  const shown = useStore.getState().doc as Document;
  deliver(answer(shown, b.id), "d", 0);
  expect(seen).toEqual([[anchorKey(b.id, 1, 3)]]);
  expect(commands()).toEqual([]);
});

// #276: the Anchor Point tools and the Curvature tool, used while a press is in flight, wait for its
// answer and act on what was under the pointer. a's hole runs (10, 10), (10, 20), (20, 20),
// (20, 10); reversed, (10, 10), (20, 10), (20, 20), (10, 20).
const toolEdits: Record<string, (doc: Document) => void> = {
  "Add Anchor Point": (doc) => addAnchorTool.down?.(event(doc, 10, 14)),
  "Delete Anchor Point": (doc) => deleteAnchorTool.down?.(event(doc, 20, 10)),
  "an Anchor Point segment drag": (doc) => {
    anchorPointTool.down?.(event(doc, 10, 14));
    anchorPointTool.move?.(event(doc, 5, 14));
    anchorPointTool.up?.(event(doc, 5, 14));
  },
  "a Curvature drag": () => {
    curvatureDown([20, 10], 1, false);
    curvatureDrag([25, 10]);
    curvatureUp();
  },
  "a Curvature double-click": () => {
    curvatureDown([20, 10], 1, false);
    curvatureUp();
    curvatureDown([20, 10], 1, false);
    curvatureUp();
  },
  "an Anchor Point drag out of an Anchor": (doc) => {
    anchorPointTool.down?.(event(doc, 20, 10));
    anchorPointTool.move?.(event(doc, 25, 10));
    anchorPointTool.up?.(event(doc, 25, 10));
  },
};

/** a's hole after the commands sent, as "x y" with each Anchor's Handles, rounded. */
function holeAfterSent(a: string, reverseBack: boolean) {
  const doc = structuredClone(useStore.getState().doc as Document);
  for (const c of commands()) if (c.type === "path_edit") editPath(doc, c.input);
  if (reverseBack) editPath(doc, { nodeId: a, ops: [{ op: "reverse", subpath: 1 }] });
  const r = (p: [number, number] | null) =>
    p ? p.map((v) => Math.round(v * 1000) / 1000).join(" ") : null;
  return localAnchors(doc.nodes.get(a) as PathNode)[1]?.anchors.map((x) => ({
    at: r(x.anchor),
    in: r(x.handleIn),
    out: r(x.handleOut),
  }));
}

/**
 * a's hole after `run` while a press is in flight with a's hole Anchor `index` chosen, then the
 * press accepted and rejected; `prep` edits the committed Document first. The accepted hole is
 * reversed back to compare.
 */
function heldEdit(
  run: (doc: Document) => void,
  name: string,
  { index = 0, prep }: { index?: number; prep?: (doc: Document, a: string) => void } = {},
) {
  return (["accepted", "rejected"] as const).map((outcome) => {
    const { doc, a, pressed, answer } = pressOn((a) => ({ anchors: [anchorKey(a.id, 1, index)] }));
    prep?.(doc, a.id);
    useStore.setState({ ...pressed, edit: null, drag: null, held: [] });
    vi.advanceTimersByTime(1000);
    vi.mocked(send).mockClear();
    run(doc);
    expect(commands(), name).toEqual([]);
    useStore.setState(
      stateAfter(useStore.getState(), outcome === "accepted" ? answer(doc, a.id) : rejected),
    );
    runHeld();
    expect(commands().length, name).toBeGreaterThan(0);
    return holeAfterSent(a.id, outcome === "accepted");
  });
}

it("holds the Anchor Point and Curvature tools' edits for the press and puts them on the point chosen", () => {
  vi.useFakeTimers();
  for (const [name, run] of Object.entries(toolEdits)) {
    const [accepted, rejected_] = heldEdit(run, name);
    const corners = ["10 10", "10 20", "20 20", "20 10"].map((at) => ({ at, in: null, out: null }));
    expect(rejected_, name).not.toEqual(corners);
    if (name === "an Anchor Point drag out of an Anchor") {
      // The Handle at the pointer leads the way the path then runs, as if dragged after the press.
      expect(rejected_?.[3], name).toEqual({ at: "20 10", in: "15 10", out: "25 10" });
      expect(accepted?.[3], name).toEqual({ at: "20 10", in: "25 10", out: "15 10" });
    } else expect(accepted, name).toEqual(rejected_);
  }
  vi.useRealTimers();
});

// #280: a held edit on one Anchor, Handle or segment acts on its `target` as the answer left it,
// with no second look at the Document: whatever the held target then names, the edit lands there.
it("runs a held edit on its held target alone, as renumbered, kept or dropped", () => {
  vi.useFakeTimers();
  for (const name of ["a Curvature drag", "an Anchor Point drag out of an Anchor"]) {
    for (const source of ["renumbered", "kept", "dropped"] as const) {
      const label = `${name}, ${source}`;
      const { doc, a, pressed, answer } = pressOn((a) => ({ anchors: [anchorKey(a.id, 1, 0)] }));
      useStore.setState({ ...pressed, edit: null, drag: null, held: [] });
      vi.advanceTimersByTime(1000);
      vi.mocked(send).mockClear();
      toolEdits[name]?.(doc);
      useStore.setState(stateAfter(useStore.getState(), answer(doc, a.id)));
      const [h] = useStore.getState().held;
      // The answer turned a's hole, so the target on (20, 10) went from index 3 to index 1.
      expect(h?.chosen.target, label).toEqual({ kind: "anchor", key: anchorKey(a.id, 1, 1) });
      if (h && source !== "renumbered") {
        const { target: _, ...chosen } = h.chosen;
        const kept = { target: { kind: "anchor", key: anchorKey(a.id, 1, 3) } as const };
        const next = source === "kept" ? { ...chosen, ...kept } : { ...chosen, anchors: [] };
        useStore.setState({ held: [{ ...h, chosen: next }] });
      }
      const before = holeAfterSent(a.id, false);
      runHeld();
      if (source === "dropped") {
        expect(commands(), label).toEqual([]);
        expect(useStore.getState().edit, label).toBeNull();
        continue;
      }
      const after = holeAfterSent(a.id, false);
      const changed = after?.filter((x, i) => JSON.stringify(x) !== JSON.stringify(before?.[i]));
      // Index 3 of the turned hole is (10, 20); the Curvature drag moves it, and its neighbours'
      // Handles follow, so only the Anchor itself is checked.
      const on = source === "renumbered" ? 1 : 3;
      if (name === "a Curvature drag")
        expect(after?.[on]?.at, label).toBe(on === 1 ? "25 10" : "15 20");
      else
        expect(
          changed?.map((x) => x.at),
          label,
        ).toEqual([before?.[on]?.at]);
    }
  }
  vi.useRealTimers();
});

it("adds a held Anchor on its held segment alone, as renumbered, kept or dropped", () => {
  for (const source of ["renumbered", "kept", "dropped"] as const) {
    const { doc, a, pressed, answer } = pressOn((a) => ({ anchors: [anchorKey(a.id, 1, 0)] }));
    useStore.setState({ ...pressed, edit: null, drag: null, held: [] });
    vi.mocked(send).mockClear();
    toolEdits["Add Anchor Point"]?.(doc);
    useStore.setState(stateAfter(useStore.getState(), answer(doc, a.id)));
    const [h] = useStore.getState().held;
    // The answer turned a's hole: the segment from (10, 10) to (10, 20) went from 0 to 3.
    expect(h?.chosen.target, source).toMatchObject({ kind: "segment", segment: 3 });
    if (h?.chosen.target?.kind === "segment" && source !== "renumbered") {
      const { target, ...chosen } = h.chosen;
      const next =
        source === "kept"
          ? { ...chosen, target: { ...target, segment: 0, t: 1 - target.t } }
          : { ...chosen, segments: [] };
      useStore.setState({ held: [{ ...h, chosen: next }] });
    }
    runHeld();
    const added = holeAfterSent(a.id, false)?.map((x) => x.at);
    if (source === "dropped") expect(commands(), source).toEqual([]);
    // Segment 0 of the turned hole runs from (10, 10) to (20, 10).
    else {
      const [x, y] = source === "renumbered" ? [10, 14] : [14, 10];
      const near = (at: string | null | undefined) => {
        const [ax = 0, ay = 0] = (at ?? "").split(" ").map(Number);
        return Math.hypot(ax - x, ay - y) < 0.01;
      };
      expect(added?.some(near), `${source}: ${added}`).toBe(true);
    }
  }
});

it("drags a held Direct Selection segment on its held target alone, as renumbered, kept or dropped", () => {
  for (const source of ["renumbered", "kept", "dropped"] as const) {
    const { doc, a, pressed, answer } = pressOn((a) => ({ anchors: [anchorKey(a.id, 1, 0)] }));
    useStore.setState({ ...pressed, edit: null, drag: null, held: [] });
    vi.mocked(send).mockClear();
    directTool.down(event(doc, 10, 14));
    directTool.move?.(event(doc, 5, 14));
    directTool.up?.(event(doc, 5, 14));
    useStore.setState(stateAfter(useStore.getState(), answer(doc, a.id)));
    const [h] = useStore.getState().held;
    // The answer turned a's hole: the segment from (10, 10) to (10, 20) went from 0 to 3.
    expect(h?.chosen.target, source).toMatchObject({ kind: "segment", segment: 3 });
    if (h?.chosen.target?.kind === "segment" && source !== "renumbered") {
      const { target, ...chosen } = h.chosen;
      const next =
        source === "kept"
          ? { ...chosen, target: { ...target, segment: 0, t: 1 - target.t } }
          : { ...chosen, segments: [] };
      useStore.setState({ held: [{ ...h, chosen: next }] });
    }
    const before = holeAfterSent(a.id, false);
    runHeld();
    if (source === "dropped") {
      expect(commands(), source).toEqual([]);
      expect(useStore.getState().edit, source).toBeNull();
      continue;
    }
    const after = holeAfterSent(a.id, false);
    const changed = after?.filter((x, i) => JSON.stringify(x) !== JSON.stringify(before?.[i]));
    // A straight segment moves whole, 5 left: segment 3 of the turned hole runs from (10, 20) to
    // (10, 10), segment 0 from (10, 10) to (20, 10).
    const ends = source === "renumbered" ? ["5 10", "5 20"] : ["15 10", "5 10"];
    expect(changed?.map((x) => x.at).sort(), source).toEqual(ends);
  }
});

// With Handles on (20, 10), its In toward (20, 20) and its Out toward (10, 10), which the reverse
// swaps: with (20, 10) chosen, the Anchor Point tool acts on the Handle under the pointer, and a
// click on the Anchor retracts both.
/** Each edit, and what it leaves of (20, 10) whatever the answer. */
const handleEdits: Record<string, [(doc: Document) => void, object]> = {
  "an Anchor Point Handle drag": [
    (doc) => {
      anchorPointTool.down?.(event(doc, 15, 6));
      anchorPointTool.move?.(event(doc, 15, 2));
      anchorPointTool.up?.(event(doc, 15, 2));
    },
    { at: "20 10", in: "24 15", out: expect.not.stringMatching(/^15 6$/) },
  ],
  "an Anchor Point Handle click": [
    (doc) => {
      anchorPointTool.down?.(event(doc, 24, 15));
      anchorPointTool.up?.(event(doc, 24, 15));
    },
    { at: "20 10", in: null, out: "15 6" },
  ],
  "an Anchor Point click on an Anchor": [
    (doc) => {
      anchorPointTool.down?.(event(doc, 20, 10));
      anchorPointTool.up?.(event(doc, 20, 10));
    },
    { at: "20 10", in: null, out: null },
  ],
};

it("holds the Anchor Point tool's Handle edits for the press and keeps them on the Handle chosen", () => {
  vi.useFakeTimers();
  const handles = (doc: Document, a: string) =>
    editPath(doc, {
      nodeId: a,
      ops: [{ op: "set_handles", subpath: 1, index: 3, handleIn: [24, 15], handleOut: [15, 6] }],
    });
  for (const [name, [run, last]] of Object.entries(handleEdits)) {
    const [accepted, rejected_] = heldEdit(run, name, { index: 3, prep: handles });
    expect(rejected_?.[3], name).toEqual(last);
    expect(accepted, name).toEqual(rejected_);
  }
  vi.useRealTimers();
});

// #278: the Pen and the Pencil, used while a press is in flight, wait for its answer and act on the
// Endpoint or stretch drawn on. p's open subpath runs (50, 0), (80, 0), (80, 30); reversed,
// (80, 30), (80, 0), (50, 0). q is an open line from (0, 100) to (20, 100).
const drawnEdits = {
  "a Pen continuing from an Endpoint": () => {
    penDown([80, 30], 1);
    penUp();
    penDown([100, 30], 1);
    penUp();
    finishPen();
  },
  "a Pen path ending on an Endpoint": () => {
    penDown([100, 60], 1);
    penUp();
    penDown([50, 0], 1);
    penUp();
  },
  "a Pen continuing one path onto another's Endpoint": () => {
    penDown([20, 100], 1);
    penUp();
    penDown([50, 0], 1);
    penUp();
  },
  "a Pencil redraw": () => {
    pencilDown([80, 10]);
    for (const p of [
      [85, 12],
      [90, 15],
      [95, 18],
      [90, 21],
      [85, 23],
      [80, 25],
    ] as const)
      pencilMove([[...p]], { shift: false, alt: false });
    pencilUp(1);
  },
  "a Pen closing the path it continues": () => {
    penDown([80, 30], 1);
    penUp();
    penDown([50, 0], 1);
    penUp();
  },
} satisfies Record<string, () => void>;

/**
 * Each subpath with an Anchor at (50, 0), as "x y" lists ending in "Z" when closed, after the
 * commands sent.
 */
function subpathsAfterSent() {
  return [...docAfterSent().nodes.values()].flatMap((n) =>
    n.type === "path"
      ? localAnchors(n)
          .map((s) => [...s.anchors.map((a) => xy(a.anchor)), ...(s.closed ? ["Z"] : [])])
          .filter((s) => s.includes("50 0"))
      : [],
  );
}

/** The Document with the path edits and Joins sent applied. */
function docAfterSent() {
  const doc = structuredClone(useStore.getState().doc as Document);
  for (const c of commands()) {
    if (c.type === "path_edit") editPath(doc, c.input);
    if (c.type === "path_join") {
      editPath(doc, c.edit);
      pathOp(doc, c.join);
    }
  }
  return doc;
}

const xy = (p: [number, number]) => p.map((v) => Math.round(v)).join(" ");

/**
 * p and q selected after a press reversing p's open subpath, q inside a Group when `grouped`;
 * `answer(outcome)` settles it.
 */
function pressOnOpen({ grouped = false } = {}) {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 200 }],
  });
  const line = { type: "path" as const, d: "M0 100 L20 100" };
  const [p, q] = createNodes(doc, [
    { type: "path", parentId, d: "M0 0 L9 0 L9 9 Z M50 0 L80 0 L80 30" },
    grouped ? { type: "group", parentId, children: [line] } : { ...line, parentId },
  ]).nodes.filter((n) => n.type === "path") as [PathNode, PathNode];
  vi.mocked(send).mockClear();
  const state = viewState({
    doc,
    selection: [p.id, q.id],
    role: "owner",
    tool: "pen",
    anchors: [anchorKey(p.id, 1, 0)],
  });
  setDirection(state, !runsClockwise(doc, p, 1));
  useStore.setState({ ...state, reversing: useStore.getState().reversing });
  vi.mocked(send).mockClear();
  return (outcome: "accepted" | "rejected") => {
    // The press reverses p as it is then, after any other Actor's edit.
    const { doc: now } = useStore.getState() as { doc: Document };
    const answered =
      outcome === "accepted"
        ? message("tx", { rev: now.rev + 1, commandId: "c", updated: [reversed(now, p.id)] })
        : rejected;
    deliver(answered, "d", 0);
  };
}

/** Another Actor's Transaction moving the first Anchor of `subpath` of `nodeId` to (50, 5). */
function theirEdit(nodeId: string, subpath: number) {
  const { doc } = useStore.getState() as { doc: Document };
  const moved = editPath(structuredClone(doc), {
    nodeId,
    ops: [{ op: "move_anchor", subpath, index: 0, to: [50, 5] }],
  }).node;
  const theirs = message("tx", { rev: doc.rev + 1, actor: "agent", updated: [moved] });
  useStore.setState(stateAfter(useStore.getState(), theirs));
  return moved;
}

it("holds the Pen's and the Pencil's edits for the press and puts them on the Endpoint or stretch drawn on", () => {
  const results = Object.entries(drawnEdits).map(([name, run]) =>
    (["accepted", "rejected"] as const).map((outcome) => {
      const answer = pressOnOpen();
      run();
      expect(commands(), name).toEqual([]);
      answer(outcome);
      expect(commands().length, name).toBeGreaterThan(0);
      expect(useStore.getState().notice, name).toBe(outcome === "rejected" ? "No." : null);
      return subpathsAfterSent();
    }),
  );
  const [continued, ended, joined, redrawn, closed] = results.map(([accepted, rejected_]) => ({
    accepted,
    rejected_,
  }));
  // The stored path keeps the direction the press gave it, or had before a rejection.
  expect(continued?.rejected_).toEqual([["50 0", "80 0", "80 30", "100 30"]]);
  expect(continued?.accepted).toEqual([["100 30", "80 30", "80 0", "50 0"]]);
  expect(ended?.rejected_).toEqual([["100 60", "50 0", "80 0", "80 30"]]);
  expect(ended?.accepted).toEqual([["80 30", "80 0", "50 0", "100 60"]]);
  // The Join connects q's (20, 100) to p's (50, 0), whichever way it then runs.
  const line = ["0 100", "20 100", "50 0", "80 0", "80 30"];
  for (const s of [joined?.accepted, joined?.rejected_]) {
    expect(s?.map((x) => (x[0] === "0 100" ? x : x.toReversed()))).toEqual([line]);
  }
  // The redraw replaces the stretch from (80, 10) to (80, 25) on the subpath as it then runs.
  const [r] = redrawn?.rejected_ ?? [];
  expect(r?.slice(0, 3)).toEqual(["50 0", "80 0", "80 10"]);
  expect(r?.slice(-2)).toEqual(["80 25", "80 30"]);
  expect(redrawn?.accepted).toEqual([r?.toReversed()]);
  // The close joins p's two Endpoints, so p keeps its three Anchors in one closed subpath.
  expect(closed?.rejected_).toEqual([["50 0", "80 0", "80 30", "Z"]]);
  expect(closed?.accepted).toEqual([["80 30", "80 0", "50 0", "Z"]]);
});

it("keeps the Pen on the Endpoint it continues when the answer comes while it draws", () => {
  const [accepted, rejected_] = (["accepted", "rejected"] as const).map((outcome) => {
    const answer = pressOnOpen();
    penDown([80, 30], 1);
    penUp();
    answer(outcome);
    penDown([100, 30], 1);
    penUp();
    finishPen();
    return subpathsAfterSent();
  });
  expect(rejected_).toEqual([["50 0", "80 0", "80 30", "100 30"]]);
  expect(accepted).toEqual([["100 30", "80 30", "80 0", "50 0"]]);
});

// #280: one rule renumbers a Pen's Endpoints, so a continuation or a connection lands on the same
// Endpoint whether the answer comes while the Pen draws or after its finish was held.
it("puts the Pen on the same Endpoint whether the answer comes while it draws or once it is held", () => {
  const pen = {
    "a Pen continuing from an Endpoint": [
      () => {
        penDown([80, 30], 1);
        penUp();
      },
      () => {
        penDown([100, 30], 1);
        penUp();
        finishPen();
      },
    ],
    "a Pen path ending on an Endpoint": [
      () => {
        penDown([100, 60], 1);
        penUp();
        penDown([50, 0], 1);
      },
      () => penUp(),
    ],
    "a Pen continuing one path onto another's Endpoint": [
      () => {
        penDown([20, 100], 1);
        penUp();
        penDown([50, 0], 1);
      },
      () => penUp(),
    ],
  } satisfies Record<string, [() => void, () => void]>;
  for (const [name, [before, after]] of Object.entries(pen)) {
    for (const outcome of ["accepted", "rejected"] as const) {
      const [drawing, held] = [true, false].map((midway) => {
        const answer = pressOnOpen();
        before();
        if (midway) answer(outcome);
        after();
        if (!midway) answer(outcome);
        expect(commands().length, name).toBeGreaterThan(0);
        return subpathsAfterSent();
      });
      expect(drawing, `${name}, ${outcome}`).toEqual(held);
    }
  }
});

// #282: the Document sent on reconnect that carries the press's reverse of the path the Pen
// continues leaves the continuation on its Endpoint; one that also carries another Actor's reshape
// of it ends the continuation.
it("after a reconnect, ends a Pen continuation only when someone else changed its path", () => {
  for (const theirs of [false, true]) {
    const label = theirs ? "their reshape too" : "the press alone";
    pressOnOpen();
    const [p] = useStore.getState().selection as [string];
    penDown([80, 30], 1);
    penUp();
    const now = useStore.getState().doc as Document;
    const turned = reversed(now, p);
    const after = theirs ? { ...turned, d: `${(turned as PathNode).d} M0 50 L9 50` } : turned;
    const nodes = [...now.nodes.values()].map((n) => (n.id === p ? after : n));
    useStore.setState(
      stateAfter(useStore.getState(), message("document", { rev: now.rev + 1, nodes })),
    );
    runHeld();
    expect(useStore.getState().pen === null, label).toBe(theirs);
    penDown([100, 30], 1);
    penUp();
    finishPen();
    if (theirs) {
      expect(commands(), label).toEqual([]);
      continue;
    }
    expect(useStore.getState().notice, label).toBeNull();
    expect(subpathsAfterSent(), label).toEqual([["100 30", "80 30", "80 0", "50 0"]]);
  }
});

it("drops a held Pen edit when another Actor edits its path before the answer (ADR-0109)", () => {
  const answer = pressOnOpen();
  drawnEdits["a Pen continuing from an Endpoint"]();
  theirEdit(useStore.getState().selection[0] as string, 1);
  answer("rejected");
  expect(commands()).toEqual([]);
  expect(useStore.getState().edit).toBeNull();
});

// #282: another Actor's edit to the path the Pen is still continuing while a press is in flight
// ends the continuation; their edit to another path leaves it to finish on the Endpoint drawn on.
it("ends a Pen continuation another Actor's edit reaches while a press is in flight", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    for (const theirsOn of ["p", "q"] as const) {
      const label = `${outcome}, their edit on ${theirsOn}`;
      const answer = pressOnOpen();
      const [p, q] = useStore.getState().selection as [string, string];
      penDown([80, 30], 1);
      penUp();
      const moved = theirsOn === "p" ? theirEdit(p, 1) : theirEdit(q, 0);
      const after = useStore.getState().doc as Document;
      expect(useStore.getState().pen === null, label).toBe(theirsOn === "p");
      answer(outcome);
      penDown([100, 30], 1);
      penUp();
      finishPen();
      if (theirsOn === "q") {
        expect(subpathsAfterSent(), label).toEqual(
          outcome === "accepted"
            ? [["100 30", "80 30", "80 0", "50 0"]]
            : [["50 0", "80 0", "80 30", "100 30"]],
        );
        continue;
      }
      expect(commands(), label).toEqual([]);
      const stored = ((useStore.getState().doc as Document).nodes.get(p) as PathNode).d;
      expect(stored, label).toBe(outcome === "accepted" ? reversed(after, p).d : moved.d);
    }
  }
});

// #281: another Actor's edit to the path a held Pencil redraw starts on drops it, as it drops the
// Pen's; their edit to another path leaves it.
it("drops a held Pencil redraw when another Actor edits its path before the answer (ADR-0109)", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    for (const theirsOn of ["p", "q"] as const) {
      const label = `${outcome}, their edit on ${theirsOn}`;
      const answer = pressOnOpen();
      drawnEdits["a Pencil redraw"]();
      const [p, q] = useStore.getState().selection as [string, string];
      const moved = theirsOn === "p" ? theirEdit(p, 1) : theirEdit(q, 0);
      const after = useStore.getState().doc as Document;
      answer(outcome);
      const s = useStore.getState();
      const stored = (id: string) => ((s.doc as Document).nodes.get(id) as PathNode).d;
      const shown = (id: string) =>
        (previewAll(s.doc as Document, previewsOf(s)).nodes.get(id) as PathNode).d;
      if (theirsOn === "p") {
        // Nothing is sent over their edit, which stays as they made it, and the preview goes.
        expect(commands(), label).toEqual([]);
        expect(stored(p), label).toBe(outcome === "accepted" ? reversed(after, p).d : moved.d);
        expect(shown(p), label).toBe(stored(p));
        // #291: and a notice says the Pencil edit was not applied, beside the rejection's.
        expect(s.notice, label).toMatch(/Pencil edit was not applied/);
        expect(s.notice?.endsWith(" No."), label).toBe(outcome === "rejected");
      } else {
        // The redraw replaces the stretch from (80, 10) to (80, 25) on p as it then runs.
        expectRedrawn(outcome, label);
        expect(stored(q), label).toBe(moved.d);
        expect(s.notice, label).toBe(outcome === "rejected" ? "No." : null);
      }
    }
  }
});

// #291: another Actor's edit that drops a held Pen finish tells the person, as one that ends a
// continuation still being drawn does (#282): what the Pen drew is gone from the screen.
it("tells the person when another Actor's edit drops a held Pen finish", () => {
  const finishes: Record<string, [() => void, "p" | "q"]> = {
    "continue p, their edit on p": [drawnEdits["a Pen continuing from an Endpoint"], "p"],
    "close p, their edit on p": [drawnEdits["a Pen closing the path it continues"], "p"],
    "end on p, their edit on p": [drawnEdits["a Pen path ending on an Endpoint"], "p"],
    "connect q onto p, their edit on q": [
      drawnEdits["a Pen continuing one path onto another's Endpoint"],
      "q",
    ],
    "connect q onto p, their edit on p": [
      drawnEdits["a Pen continuing one path onto another's Endpoint"],
      "p",
    ],
  };
  for (const outcome of ["accepted", "rejected"] as const) {
    for (const [name, [run, theirsOn]] of Object.entries(finishes)) {
      const label = `${name}, ${outcome}`;
      const answer = pressOnOpen();
      const [p, q] = useStore.getState().selection as [string, string];
      run();
      expect(useStore.getState().held, label).toHaveLength(1);
      if (theirsOn === "p") theirEdit(p, 1);
      else theirEdit(q, 0);
      answer(outcome);
      expect(commands(), label).toEqual([]);
      expect(useStore.getState().edit, label).toBeNull();
      const { notice } = useStore.getState();
      expect(notice, label).toMatch(/Pen .*not applied/);
      // A rejection's notice comes from the same message, so it is shown too.
      expect(notice?.endsWith(" No."), label).toBe(outcome === "rejected");
    }
  }
});

// #284: a held Pencil redraw acts on the path it was drawn over, whatever the person does to the
// Selection meanwhile, and its Ink moves with that path when the person moves it whole.

/** This tab's own Selection tool move of `nodeId` by (dx, dy), sent and answered in the window. */
function ownMove(nodeId: string, dx: number, dy: number) {
  vi.mocked(send).mockReturnValueOnce("m");
  useStore.setState({ drag: { nodeIds: [nodeId], dx, dy, copy: false } });
  commitDrag(unheld("the test's Selection tool move"));
  const { doc } = useStore.getState() as { doc: Document };
  const { nodes } = transformNodes(structuredClone(doc), {
    nodeIds: [nodeId],
    translate: { x: dx, y: dy },
  });
  const moved = message("tx", { rev: doc.rev + 1, commandId: "m", updated: nodes });
  useStore.setState(stateAfter(useStore.getState(), moved));
}

/** The stretch from (80, 10) to (80, 25) redrawn on p's open subpath, run as the answer left it. */
function expectRedrawn(outcome: "accepted" | "rejected", label: string) {
  const sent = subpathsAfterSent();
  expect(sent, label).toHaveLength(1);
  const run = outcome === "accepted" ? sent[0]?.toReversed() : sent[0];
  expect(run?.slice(0, 3), label).toEqual(["50 0", "80 0", "80 10"]);
  expect(run?.slice(-2), label).toEqual(["80 25", "80 30"]);
}

it("redraws the path drawn over though the person changes the Selection before the answer", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    for (const now of ["q", "none"] as const) {
      const label = `${outcome}, Selection ${now}`;
      const answer = pressOnOpen();
      drawnEdits["a Pencil redraw"]();
      const [, q] = useStore.getState().selection as [string, string];
      useStore.setState({ selection: now === "q" ? [q] : [] });
      answer(outcome);
      expectRedrawn(outcome, label);
      expect(useStore.getState().notice ?? "", label).not.toMatch(/Pencil/);
    }
  }
});

it("moves a held Pencil redraw's Ink with its path when the person moves the path before the answer", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    const answer = pressOnOpen();
    drawnEdits["a Pencil redraw"]();
    const [p] = useStore.getState().selection as [string, string];
    ownMove(p, 100, 50);
    answer(outcome);
    // In p's own coordinates the stretch drawn over is redrawn, and p stays where it was moved.
    expectRedrawn(outcome, outcome);
    const stored = (useStore.getState().doc as Document).nodes.get(p) as PathNode;
    expect(stored.transform, outcome).toEqual([1, 0, 0, 1, 100, 50]);
  }
});

it("keeps a held Pencil redraw's Ink in a rotated and scaled path's own coordinates", () => {
  // p turned 90° and doubled: (x, y) in p is drawn at (150 - 2y, 20 + 2x).
  const t = ([x, y]: readonly [number, number]): [number, number] => [150 - 2 * y, 20 + 2 * x];
  for (const outcome of ["accepted", "rejected"] as const) {
    const answer = pressOnOpen();
    const [p] = useStore.getState().selection as [string, string];
    const doc = structuredClone(useStore.getState().doc as Document);
    (doc.nodes.get(p) as PathNode).transform = [0, 2, -2, 0, 150, 20];
    useStore.setState({ doc });
    pencilDown(t([80, 10]));
    for (const q of [
      [85, 12],
      [90, 15],
      [95, 18],
      [90, 21],
      [85, 23],
      [80, 25],
    ] as const)
      pencilMove([t(q)], { shift: false, alt: false });
    pencilUp(1);
    ownMove(p, 100, 50);
    answer(outcome);
    expectRedrawn(outcome, outcome);
  }
});

it("tells the person a held Pencil redraw was dropped when their own edit took the path off its Ink", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    const answer = pressOnOpen();
    drawnEdits["a Pencil redraw"]();
    const [p] = useStore.getState().selection as [string, string];
    // The answer to the person's Direct Selection drag sent before the press puts p's open subpath
    // far from the Ink.
    useStore.setState({ sentPreviews: [{ edit: { inputs: [], commandIds: ["e"] }, drag: null }] });
    const { doc } = useStore.getState() as { doc: Document };
    const { node } = editPath(structuredClone(doc), {
      nodeId: p,
      ops: [{ op: "set_d", d: "M0 0 L9 0 L9 9 Z M150 150 L180 150 L180 180" }],
    });
    const ours = message("tx", { rev: doc.rev + 1, commandId: "e", updated: [node] });
    useStore.setState(stateAfter(useStore.getState(), ours));
    answer(outcome);
    const s = useStore.getState();
    expect(commands(), outcome).toEqual([]);
    const no = outcome === "rejected" ? " No." : "";
    expect(s.notice, outcome).toBe(
      `The Pencil edit was not applied; your own earlier change reshaped its path.${no}`,
    );
    const shown = previewAll(s.doc as Document, previewsOf(s)).nodes.get(p) as PathNode;
    expect(shown.d, outcome).toBe(((s.doc as Document).nodes.get(p) as PathNode).d);
  }
});

// #301: a held Pen finish keeps what the person drew in the own coordinates of the path it continues or
// connects to, so the person's own Selection tool move in the window carries it with the path, as
// #284 carries the held Pencil redraw.

/** Node `id` after the commands sent: its subpaths, in its own coordinates, and its transform. */
function storedAfterSent(id: string) {
  const n = docAfterSent().nodes.get(id) as PathNode;
  return {
    subpaths: localAnchors(n).map((s) => s.anchors.map((a) => xy(a.anchor))),
    transform: n.transform,
  };
}

/** The Pen continuing q from (20, 100) to (40, 100), finished while the press is in flight. */
function continueQ() {
  penDown([20, 100], 1);
  penUp();
  penDown([40, 100], 1);
  penUp();
  finishPen();
}

const penSent = () => commands().filter((c) => c.type === "path_edit" || c.type === "path_join");
const noticeAfter = (outcome: "accepted" | "rejected") => (outcome === "rejected" ? "No." : null);

it("carries a held Pen continuation with its path when the person moves the path before the answer (#301)", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    const answer = pressOnOpen();
    const [, q] = useStore.getState().selection as [string, string];
    continueQ();
    ownMove(q, 100, 50);
    answer(outcome);
    expect(useStore.getState().notice, outcome).toBe(noticeAfter(outcome));
    expect(
      penSent().map((c) => c.type),
      outcome,
    ).toEqual(["path_edit"]);
    expect(storedAfterSent(q), outcome).toEqual({
      subpaths: [["0 100", "20 100", "40 100"]],
      transform: [1, 0, 0, 1, 100, 50],
    });
  }
});

it("carries a held Pen continuation with its path's Group when the person moves the Group (#301)", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    const answer = pressOnOpen({ grouped: true });
    const { doc, selection } = useStore.getState() as { doc: Document; selection: string[] };
    const q = selection[1] as string;
    const group = doc.nodes.get(q)?.parentId as string;
    continueQ();
    ownMove(group, 100, 50);
    answer(outcome);
    expect(useStore.getState().notice, outcome).toBe(noticeAfter(outcome));
    expect(
      penSent().map((c) => c.type),
      outcome,
    ).toEqual(["path_edit"]);
    // A Group has no matrix, so the move is q's, and none of q stays at the old place.
    expect(storedAfterSent(q), outcome).toEqual({
      subpaths: [["0 100", "20 100", "40 100"]],
      transform: [1, 0, 0, 1, 100, 50],
    });
  }
});

it("carries a held new Pen path with the path it ends on when the person moves that path (#301)", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    const answer = pressOnOpen();
    const [p] = useStore.getState().selection as [string, string];
    drawnEdits["a Pen path ending on an Endpoint"]();
    ownMove(p, 100, 50);
    answer(outcome);
    const joined = ["100 60", "50 0", "80 0", "80 30"];
    expect(subpathsAfterSent(), outcome).toEqual([
      outcome === "accepted" ? joined.toReversed() : joined,
    ]);
    expect(storedAfterSent(p).transform, outcome).toEqual([1, 0, 0, 1, 100, 50]);
    expect(useStore.getState().notice, outcome).toBe(noticeAfter(outcome));
  }
});

it("joins a held Pen connection of two paths moved together, and drops it when one moved alone (#301)", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    for (const together of [true, false]) {
      const label = `${outcome}, ${together ? "together" : "q alone"}`;
      const answer = pressOnOpen();
      const [p, q] = useStore.getState().selection as [string, string];
      drawnEdits["a Pen continuing one path onto another's Endpoint"]();
      if (together) ownMove(p, 100, 50);
      ownMove(q, 100, 50);
      answer(outcome);
      const s = useStore.getState();
      if (together) {
        expect(
          penSent().map((c) => c.type),
          label,
        ).toEqual(["path_join"]);
        const after = docAfterSent();
        const [line] = [...after.nodes.values()]
          .filter((n) => n.type === "path" && (n.id === p || n.id === q))
          .flatMap((n) => anchorsOf(after, n as PathNode).filter((x) => !x.closed))
          .map((x) => x.anchors.map((a) => xy(a.anchor)));
        const moved = ["100 150", "120 150", "150 50", "180 50", "180 80"];
        expect(line?.[0] === "100 150" ? line : line?.toReversed(), label).toEqual(moved);
        expect(s.notice, label).toBe(noticeAfter(outcome));
        continue;
      }
      expect(penSent(), label).toEqual([]);
      expect(s.notice, label).toMatch(/moved before the connection was made/);
      expect(s.notice, label).not.toMatch(/Someone else/);
      const shown = previewAll(s.doc as Document, previewsOf(s));
      for (const n of [p, q]) {
        const d = (x: Document) => (x.nodes.get(n) as PathNode).d;
        expect(d(shown), label).toBe(d(s.doc as Document));
      }
    }
  }
});

// #301: the press is sent before the move, so its answer comes first, and the held Join runs
// while the move is still unanswered; the Document DO applies the Join after the move.
it("drops a held Pen connection of two paths when one moved alone and its move is answered after the press (#301)", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    for (const together of [true, false]) {
      const label = `${outcome}, ${together ? "together" : "q alone"}`;
      const answer = pressOnOpen();
      const [p, q] = useStore.getState().selection as [string, string];
      drawnEdits["a Pen continuing one path onto another's Endpoint"]();
      const moved = together ? [p, q] : [q];
      vi.mocked(send).mockReturnValueOnce("m");
      useStore.setState({
        drag: { nodeIds: moved, dx: 100, dy: 50, copy: false },
      });
      commitDrag(unheld("the test's Selection tool move"));
      answer(outcome);
      const s = useStore.getState();
      if (together) {
        expect(
          penSent().map((c) => c.type),
          label,
        ).toEqual(["path_join"]);
        expect(s.notice, label).toBe(noticeAfter(outcome));
        continue;
      }
      expect(penSent(), label).toEqual([]);
      expect(s.notice, label).toMatch(/moved before the connection was made/);
    }
  }
});

it("drops a sent Pen connection and its preview when the server finds its Endpoints apart (#303)", () => {
  const answer = pressOnOpen();
  const [p, q] = useStore.getState().selection as [string, string];
  drawnEdits["a Pen continuing one path onto another's Endpoint"]();
  answer("accepted");
  expect(penSent().map((c) => c.type)).toEqual(["path_join"]);
  const apart = message("rejected", {
    id: "c",
    error: { code: "ENDPOINTS_APART", message: "Moved.", hint: "" },
  });
  useStore.setState(stateAfter(useStore.getState(), apart));
  const s = useStore.getState();
  expect(s.notice).toMatch(
    /^A path the Pen was connecting to moved before the connection was made/,
  );
  expect(s.edit).toBeNull();
  const shown = previewAll(s.doc as Document, previewsOf(s));
  for (const n of [p, q]) {
    const d = (x: Document) => (x.nodes.get(n) as PathNode).d;
    expect(d(shown), n).toBe(d(s.doc as Document));
  }
});

// #283: a held edit, when it runs or is dropped, touches its own preview only. Each edit is held on
// a's hole, or on p's open subpath, and another Actor's deletion of that path drops it.
const heldOnRings: Record<string, (doc: Document) => void> = {
  ...toolEdits,
  "a Direct Selection drag": (doc) => {
    directTool.down(event(doc, 10, 10));
    directTool.move?.(event(doc, 15, 10));
    directTool.up?.(event(doc, 15, 10));
  },
};

/**
 * Holds `run` on `path` while a press is in flight, then answers it `outcome`, after another Actor
 * deletes `path` when `dropped`; `meanwhile` runs between the hold and the answer.
 */
function settleHeld(
  hold: () => { path: string; answer: (outcome: "accepted" | "rejected") => void },
  run: () => void,
  meanwhile: () => void,
  outcome: "accepted" | "rejected",
  dropped: boolean,
) {
  const { path, answer } = hold();
  run();
  meanwhile();
  if (dropped) {
    const { doc } = useStore.getState() as { doc: Document };
    const theirs = message("tx", { rev: doc.rev + 1, actor: "agent", deletedIds: [path] });
    useStore.setState(stateAfter(useStore.getState(), theirs));
  }
  answer(outcome);
}

const onRings = () => {
  const { doc, a, b, pressed } = pressOn((a) => ({ anchors: [anchorKey(a.id, 1, 0)] }));
  useStore.setState({ ...pressed, edit: null, drag: null, held: [] });
  vi.advanceTimersByTime(1000);
  vi.mocked(send).mockClear();
  return {
    doc,
    b,
    path: a.id,
    answer: (outcome: "accepted" | "rejected") => {
      const { doc: now } = useStore.getState() as { doc: Document };
      const tx = message("tx", {
        rev: now.rev + 1,
        commandId: "c",
        updated: [a, b].filter((n) => now.nodes.has(n.id)).map((n) => reversed(now, n.id)),
      });
      deliver(outcome === "accepted" ? tx : rejected, "d", 0);
    },
  };
};

const onOpen = () => {
  const answer = pressOnOpen();
  const [path] = useStore.getState().selection as [string];
  return {
    path,
    answer: (outcome: "accepted" | "rejected") => {
      const { doc } = useStore.getState() as { doc: Document };
      if (doc.nodes.has(path) || outcome === "rejected") return answer(outcome);
      const tx = message("tx", { rev: doc.rev + 1, commandId: "c", updated: [] });
      deliver(tx, "d", 0);
    },
  };
};

/**
 * #285: held edits with no preview of their own, each on a alone with its hole's Anchor 0 chosen,
 * as `onRings` chose it, so that another Actor's deletion of a leaves them nothing to send.
 */
const unpreviewed: Record<string, () => void> = {
  "Edit > Clear": () => {
    chooseOnA([]);
    menuItem("Clear").run();
  },
  "Direct Selection's Delete": () => {
    chooseOnA();
    menuItem("Clear").run();
  },
  "Remove Anchor Points": () => {
    chooseOnA();
    menuItem("Remove Anchor Points").run();
  },
  Join: () => {
    chooseOnA();
    menuItem("Join").run();
  },
  Average: () => {
    chooseOnA();
    averageAnchors("both");
  },
  Convert: () => {
    chooseOnA();
    convertAnchors("smooth");
  },
  "the Attributes panel's direction buttons": () => {
    // The outer subpath runs On, so Off sends whichever way the press left the hole.
    const [hole = ""] = useStore.getState().anchors;
    chooseOnA([hole, anchorKey(parseKey(hole).nodeId, 0, 0)]);
    pressDirection(false);
  },
};

/** Selects a alone, the path whose hole Anchor 0 `onRings` chose, with the Anchors `anchors`. */
function chooseOnA(anchors = useStore.getState().anchors) {
  const [hole = ""] = useStore.getState().anchors;
  useStore.setState({ selection: [parseKey(hole).nodeId], anchors, segments: [], tool: "direct" });
}

const everyHeld = [
  ...Object.entries(heldOnRings).map(([name, run]) => ({
    name,
    hold: onRings,
    run: () => run(useStore.getState().doc as Document),
  })),
  ...Object.entries(unpreviewed).map(([name, run]) => ({ name, hold: onRings, run })),
  ...Object.entries(drawnEdits).map(([name, run]) => ({ name, hold: onOpen, run })),
];

it("leaves another gesture's unsent preview when a held edit runs or is dropped, with every tool", () => {
  vi.useFakeTimers();
  for (const { name, hold, run } of everyHeld) {
    for (const outcome of ["accepted", "rejected"] as const) {
      for (const dropped of [false, true]) {
        const label = `${name}, ${outcome}${dropped ? ", dropped" : ""}`;
        // A drag of another path begun after the held edit: a Direct Selection drag's path edit,
        // and a Selection tool drag's move.
        const edit = { inputs: [{ nodeId: "other", ops: [] }] };
        const drag = { nodeIds: ["other"], dx: 3, dy: 0 };
        settleHeld(hold, run, () => useStore.setState({ edit, drag }), outcome, dropped);
        expect(useStore.getState().edit, label).toBe(edit);
        expect(useStore.getState().drag, label).toBe(drag);
        expect(
          commands().filter((c) => c.type === "transform"),
          label,
        ).toEqual([]);
        expect(commands().length > 0, label).toBe(!dropped);
        // #291: only dropped drawn work, which is gone from the screen, is announced.
        const notice = useStore.getState().notice;
        if (dropped && name in drawnEdits)
          expect(notice, label).toMatch(
            name.includes("Pencil") ? /Pencil .*not applied/ : /Pen .*not applied/,
          );
        else expect(notice, label).toBe(outcome === "rejected" ? "No." : null);
      }
    }
  }
  vi.useRealTimers();
});

it("keeps a Direct Selection drag in progress, and stores what it dragged, when a held edit is dropped", () => {
  vi.useFakeTimers();
  for (const outcome of ["accepted", "rejected"] as const) {
    let b = "";
    let shown: unknown;
    settleHeld(
      () => {
        const r = onRings();
        b = r.b.id;
        return r;
      },
      () => heldOnRings["a Curvature drag"]?.(useStore.getState().doc as Document),
      () => {
        // Drags b's top-left corner, (50, 0), to (55, 5).
        const { doc } = useStore.getState() as { doc: Document };
        directTool.down(event(doc, 50, 0));
        directTool.move?.(event(doc, 55, 5));
        shown = useStore.getState().edit;
      },
      outcome,
      true,
    );
    expect(useStore.getState().edit, outcome).toEqual(shown);
    vi.mocked(send).mockClear();
    directTool.up?.(event(useStore.getState().doc as Document, 55, 5));
    expect(commands(), outcome).toEqual([
      {
        type: "path_edit",
        input: { nodeId: b, ops: [{ op: "move_anchor", subpath: 0, index: 0, to: [55, 5] }] },
      },
    ]);
  }
  vi.useRealTimers();
});

it("keeps a Pencil drag in progress, and stores what it drew, when a held edit is dropped", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    settleHeld(
      onOpen,
      drawnEdits["a Pen continuing from an Endpoint"],
      // Redraws q, the line from (0, 100) to (20, 100), from (4, 100) to (16, 100) through (10, 106).
      () => {
        const { doc } = useStore.getState() as { doc: Document };
        const q = [...doc.nodes.values()].find(
          (n) => n.type === "path" && n.d === "M 0 100 L 20 100",
        );
        useStore.setState({ selection: [q?.id as string] });
        pencilDown([4, 100]);
        for (const x of [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
          pencilMove([[x, 106 - Math.abs(x - 10)]], { shift: false, alt: false });
      },
      outcome,
      true,
    );
    expect(commands(), outcome).toEqual([]);
    pencilMove([[16, 100]], { shift: false, alt: false });
    pencilUp(1);
    const [edit] = commands();
    expect(edit, outcome).toMatchObject({ type: "path_edit" });
    expect(useStore.getState().sentPreviews.at(-1)?.edit?.inputs, outcome).toEqual([
      (edit as { input: unknown }).input,
    ]);
  }
});

it("keeps each held edit's preview on screen until that edit runs or is dropped", () => {
  vi.useFakeTimers();
  for (const outcome of ["accepted", "rejected"] as const) {
    for (const dropped of [false, true]) {
      const label = `${outcome}${dropped ? ", dropped" : ""}`;
      let a = "";
      let b = "";
      /** Where the held edits put a's hole Anchor at (10, 10) and b's corner at (80, 0). */
      const shown = () => {
        const s = useStore.getState();
        const d = previewAll(s.doc as Document, previewsOf(s));
        return [d.nodes.has(a) ? at(d, anchorKey(a, 1, 0)) : null, at(d, anchorKey(b, 0, 1))];
      };
      settleHeld(
        () => {
          const r = onRings();
          [a, b] = [r.path, r.b.id];
          return r;
        },
        () => {
          // A drag of a's hole Anchor, a press on b's hole, then a Curvature drag of b's corner.
          heldOnRings["a Direct Selection drag"]?.(useStore.getState().doc as Document);
          afterReverse(
            (s) =>
              setDirection(
                s,
                !runsClockwise(s.doc as Document, s.doc?.nodes.get(b) as PathNode, 1),
              ),
            { anchors: [anchorKey(b, 1, 0)], segments: [] },
          );
          curvatureDown([80, 0], 1, false);
          curvatureDrag([85, 0]);
          curvatureUp();
        },
        () =>
          expect(shown(), label).toEqual([
            [15, 10],
            [85, 0],
          ]),
        outcome,
        dropped,
      );
      // The drag ran or was dropped, and the second press holds the Curvature drag.
      expect(useStore.getState().reversing, label).not.toBeNull();
      expect(shown(), label).toEqual([dropped ? null : [15, 10], [85, 0]]);
      // The drag's answer, which the mock gives the press's id too, takes its preview down.
      useStore.setState(stateAfter(useStore.getState(), rejected));
      expect(shown()[0], label).toEqual(dropped ? null : [10, 10]);
    }
  }
  vi.useRealTimers();
});

// #288: the answer to the person's own command that the browser did not work out keys for keeps
// keys on a path whose geometry it left as it was, and clears them on one it reshaped.

/** The person's own Transaction for command `id` on `n` as `change` leaves it, sent and answered. */
function ownTx(id: string, n: Node, change: "paint" | "reshape") {
  record(
    id,
    change === "paint"
      ? { type: "update", nodeId: n.id, patch: { visible: true } }
      : { type: "undo" },
  );
  const { doc } = useStore.getState() as { doc: Document };
  const updated =
    change === "paint"
      ? { ...n, appearance: { fills: [], strokes: [] } }
      : editPath(structuredClone(doc), {
          nodeId: n.id,
          ops: [{ op: "move_anchor", subpath: 0, index: 0, to: [n.id.length, -5] }],
        }).node;
  const tx = message("tx", { rev: doc.rev + 1, commandId: id, updated: [updated as Node] });
  deliver(tx, "d", 0);
  return updated as Node;
}

it("runs a held drag past the answer to the person's own paint change, and drops it after their reshape (#288)", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    for (const change of ["paint", "reshape"] as const) {
      const label = `${outcome}, ${change}`;
      // b's hole Anchor 0 chosen; its Anchor at (70, 10) is 3, and 1 once reversed.
      const { doc, b, pressed, answer } = pressOn((_, b) => ({ anchors: [anchorKey(b.id, 1, 0)] }));
      useStore.setState({ ...pressed, edit: null, drag: null, held: [], sentPreviews: [] });
      vi.mocked(send).mockClear();
      directTool.down(event(doc, 70, 10));
      directTool.move?.(event(doc, 75, 10));
      directTool.up?.(event(doc, 75, 10));
      expect(useStore.getState().held, label).toHaveLength(1);
      // The answer to a command sent before the press, such as a Gradient panel paint or an Undo.
      ownTx("g", b, change);
      const now = useStore.getState().doc as Document;
      useStore.setState(
        stateAfter(useStore.getState(), outcome === "accepted" ? answer(now, b.id) : rejected),
      );
      runHeld();
      if (change === "reshape") {
        expect(commands(), label).toEqual([]);
        expect(useStore.getState().notice, label).toBe(outcome === "rejected" ? "No." : null);
        continue;
      }
      const index = outcome === "accepted" ? 1 : 3;
      expect(commands(), label).toEqual([
        {
          type: "path_edit",
          input: { nodeId: b.id, ops: [{ op: "move_anchor", subpath: 1, index, to: [75, 10] }] },
        },
      ]);
    }
  }
});

it("redraws a held Pencil stretch past the answer to the person's own paint change on its path (#288)", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    const answer = pressOnOpen();
    drawnEdits["a Pencil redraw"]();
    const [p] = useStore.getState().selection as [string, string];
    ownTx("g", (useStore.getState().doc as Document).nodes.get(p) as Node, "paint");
    answer(outcome);
    expectRedrawn(outcome, outcome);
  }
});

it("ends a Pen continuation on the person's own reshape of its path, not on their paint change (#288)", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    for (const change of ["paint", "reshape", "held edit that ran"] as const) {
      const label = `${outcome}, ${change}`;
      const answer = pressOnOpen();
      const [p] = useStore.getState().selection as [string, string];
      penDown([80, 30], 1);
      penUp();
      // A held edit that ran, such as a Pencil redraw, is drawn in `sentPreviews` until its answer; the Pen's
      // Anchors predate it all the same.
      if (change === "held edit that ran") {
        const edit = { inputs: [], commandIds: ["u"] };
        useStore.setState({ sentPreviews: [{ edit, drag: null, fromHeld: true }] });
      }
      // Their own Undo, say, reshapes p's closed subpath; a Fill change leaves p's Anchors.
      const n = (useStore.getState().doc as Document).nodes.get(p) as Node;
      const mine = ownTx("u", n, change === "paint" ? "paint" : "reshape");
      expect(useStore.getState().pen === null, label).toBe(change !== "paint");
      const after = useStore.getState().doc as Document;
      answer(outcome);
      penDown([100, 30], 1);
      penUp();
      finishPen();
      if (change === "paint") {
        expect(subpathsAfterSent(), label).toEqual(
          outcome === "accepted"
            ? [["100 30", "80 30", "80 0", "50 0"]]
            : [["50 0", "80 0", "80 30", "100 30"]],
        );
        continue;
      }
      expect(commands(), label).toEqual([]);
      const stored = ((useStore.getState().doc as Document).nodes.get(p) as PathNode).d;
      expect(stored, label).toBe(
        outcome === "accepted" ? reversed(after, p).d : (mine as PathNode).d,
      );
    }
  }
});

it("sends Undo and Redo after the edits held for a press, in input order; at once with none (#288)", () => {
  const menus = documentMenus({ open() {}, close() {} });
  for (const keys of ["Ctrl+Z", "Shift+Ctrl+Z"]) {
    const { doc, a, pressed, answer } = pressOn((a) => ({ anchors: [anchorKey(a.id, 1, 0)] }));
    useStore.setState({ ...pressed, edit: null, drag: null, held: [], sentPreviews: [] });
    vi.mocked(send).mockClear();
    directTool.down(event(doc, 20, 10));
    directTool.move?.(event(doc, 25, 10));
    directTool.up?.(event(doc, 25, 10));
    findByKeys(menus, keys)?.run();
    expect(commands(), keys).toEqual([]);
    deliver(answer(doc, a.id), "d", 0);
    expect(
      commands().map((c) => c.type),
      keys,
    ).toEqual(["path_edit", keys === "Ctrl+Z" ? "undo" : "redo"]);
    // With nothing in flight, it is sent at once.
    useStore.setState(stateAfter(useStore.getState(), message("rejected", { id: "c" })));
    vi.mocked(send).mockClear();
    findByKeys(menus, keys)?.run();
    expect(
      commands().map((c) => c.type),
      keys,
    ).toEqual([keys === "Ctrl+Z" ? "undo" : "redo"]);
  }
});

// Case 5: a's hole runs (10, 10), (10, 20), (20, 20), (20, 10). A held Pencil redraw from its bottom
// round to its right side is drawn in `sentPreviews` once sent and renumbers its Anchors in a way the browser
// cannot number, so its answer mid-drag lets go of a drag on a. An Add Anchor click it can number
// keeps the drag (#298 T3).
const heldOnA = {
  "Pencil redraw": () => {
    pencilDown([12, 20]);
    for (const p of [
      [14, 28],
      [18, 34],
      [24, 30],
      [26, 22],
      [20, 16],
    ] as const)
      pencilMove([[...p]], { shift: false, alt: false });
    pencilUp(1);
  },
};

it("lets go of a drag when the answer to the person's own held reshape of its path comes mid-drag; their paint change keeps it (#288)", () => {
  vi.useFakeTimers();
  for (const mine of [...(Object.keys(heldOnA) as (keyof typeof heldOnA)[]), "paint" as const]) {
    for (const [name, g] of Object.entries(grabs)) {
      const label = `${name}, ${mine}`;
      vi.mocked(send).mockClear();
      const { doc, a, b } = rings(g.hole);
      // A press reversing b's hole, in flight.
      const on = { anchors: [anchorKey(b.id, 1, 0)] };
      const state = viewState({ doc, selection: [b.id], role: "owner", ...on });
      setDirection(state, true);
      const { reversing } = useStore.getState();
      expect(reversing?.subpaths, label).toEqual([{ nodeId: b.id, subpath: 1 }]);
      vi.mocked(send).mockClear();
      useStore.setState({ ...state, selection: [a.id], anchors: [], reversing, tool: "selection" });
      vi.advanceTimersByTime(1000);
      const held = mine === "paint" ? null : heldOnA[mine];
      if (held) {
        held();
        expect(useStore.getState().held, label).toHaveLength(1);
        // Sent as "k" once the press is answered.
        vi.mocked(send).mockImplementationOnce((c) => record("k", c));
      }
      const pressed = message("tx", {
        rev: doc.rev + 1,
        commandId: "c",
        updated: [reversed(doc, b.id)],
      });
      deliver(pressed, "d", 0);
      const now = useStore.getState().doc as Document;
      useStore.setState({
        selection: [a.id, b.id],
        anchors: [anchorKey(a.id, 1, 0)],
        segments: [],
      });
      const [x, y] = g.at;
      g.down(now, x, y);
      g.move(now, x + 5, y);
      expect(firstIndex(useStore.getState().edit?.inputs[0]), label).toBe(g.index[0]);
      let stored: Node;
      if (held) {
        const [edit] = commands();
        expect(edit?.type, label).toBe("path_edit");
        stored = editPath(structuredClone(now), (edit as { input: PathEditInput }).input).node;
        expect(localAnchors(stored as PathNode)[1]?.anchors.length, label).toBeGreaterThan(4);
        const msg = message("tx", { rev: now.rev + 1, commandId: "k", updated: [stored] });
        deliver(msg, "d", 0);
      } else {
        stored = ownTx("g", now.nodes.get(a.id) as Node, "paint");
      }
      const s = useStore.getState();
      expect(s.notice, label).toBeNull();
      const result = finish(g);
      expect(useStore.getState().doc?.nodes.get(a.id), label).toEqual(stored);
      if (held) {
        // Nothing more is drawn or sent, and a is stored as the held edit left it.
        expect(s.edit, label).toBeNull();
        expect(result, label).toEqual({ moved: undefined, sent: [] });
        expect(useStore.getState().held, label).toEqual([]);
      } else {
        expect(result.moved, label).toBe(g.index[0]);
        expect(result.sent.length, label).toBe(1);
      }
    }
  }
  vi.useRealTimers();
});

it("lets go only of the Anchors on the path the person's own Undo reshapes, in a drag of two paths (#288)", () => {
  vi.mocked(send).mockClear();
  const { doc, a, b } = rings();
  const anchors = [anchorKey(a.id, 1, 3), anchorKey(b.id, 1, 3)];
  useStore.setState(viewState({ doc, selection: [a.id, b.id], role: "owner", anchors }));
  const paths = () => useStore.getState().edit?.inputs.map((i) => i.nodeId);
  directTool.down(event(doc, 20, 10));
  directTool.move?.(event(doc, 25, 10));
  expect(paths()).toEqual([a.id, b.id]);
  ownTx("u", a, "reshape");
  expect(paths()).toEqual([b.id]);
  const now = useStore.getState().doc as Document;
  directTool.move?.(event(now, 26, 10));
  directTool.up?.(event(now, 26, 10));
  expect(commands()).toEqual([
    {
      type: "path_edit",
      input: { nodeId: b.id, ops: [{ op: "move_anchor", subpath: 1, index: 3, to: [76, 10] }] },
    },
  ]);
});

// #298: an edit by index made before the answer to the person's own command that may renumber its
// path waits for that answer, which renumbers it, so it acts on the point the person pressed, as in
// Illustrator, which runs each command before it takes the next input.

/**
 * The Document DO for #298's tests: each command sent is queued under its own id, and `answer`
 * applies the next one to `server` as the socket delivers it, or rejects it, then runs what was
 * held. Undo puts back the Document before the last command it applied, and Redo what it undid.
 */
function serve(doc: Document) {
  const server = structuredClone(doc);
  const queue: { id: string; command: Command }[] = [];
  const history: Document["nodes"][] = [];
  const future: Document["nodes"][] = [];
  let ids = 0;
  vi.mocked(send).mockClear();
  vi.mocked(send).mockImplementation((command) => {
    const id = `k${++ids}`;
    queue.push({ id, command });
    return record(id, command);
  });
  /** The server's change since `before` as a Transaction, the answer to `commandId` if given. */
  const tx = (before: Document["nodes"], commandId?: string) =>
    message("tx", {
      rev: server.rev,
      commandId,
      actor: commandId ? "user" : "agent",
      created: [...server.nodes.values()].filter((n) => !before.has(n.id)),
      updated: [...server.nodes.values()].filter(
        (n) => before.has(n.id) && JSON.stringify(before.get(n.id)) !== JSON.stringify(n),
      ),
      deletedIds: [...before.keys()].filter((k) => !server.nodes.has(k)),
    });
  const answer = (reject = false) => {
    const { id, command: c } = queue.shift() as { id: string; command: Command };
    const no = message("rejected", {
      id,
      error: { code: "INVALID_PATH", message: "No.", hint: "" },
    });
    const before = structuredClone(server.nodes);
    try {
      if (reject) throw new Error("Rejected.");
      if (c.type === "path_edit") editPath(server, c.input);
      else if (c.type === "path_op") pathOp(server, c.input);
      else if (c.type === "delete") for (const n of c.nodeIds) server.nodes.delete(n);
      else if (c.type === "transform") transformNodes(server, c.input);
      else if (c.type === "duplicate") duplicateNodes(server, c.input);
      else if (c.type === "path_reverse") {
        for (const { nodeId, subpath } of c.subpaths) {
          const n = server.nodes.get(nodeId) as PathNode;
          if (runsClockwise(server, n, subpath) === c.clockwise) continue;
          editPath(server, { nodeId, ops: [{ op: "reverse", subpath }] });
        }
      } else if (c.type === "undo" || c.type === "redo") {
        const [from, to] = c.type === "undo" ? [history, future] : [future, history];
        const last = from.pop();
        if (!last) throw new Error("NOTHING_TO_UNDO");
        to.push(before);
        server.nodes = last;
      } else throw new Error(`The test server does not run ${c.type}.`);
    } catch {
      server.nodes = before;
      deliver(no, "d", 0);
      return;
    }
    if (c.type !== "undo" && c.type !== "redo") {
      history.push(before);
      future.length = 0;
    }
    server.rev++;
    deliver(tx(before, id), "d", 0);
  };
  /** Another Actor's edit to the server's Document, delivered at once. */
  const theirs = (change: (d: Document) => void) => {
    const before = structuredClone(server.nodes);
    change(server);
    server.rev++;
    deliver(tx(before), "d", 0);
  };
  const serveAll = () => {
    while (queue.length > 0) answer();
  };
  return { server, queue, answer, serveAll, theirs };
}

/** Subpath `k` of `id` in `doc` as "x y" per Anchor, with its Handles, rounded. */
function stored(doc: Document, id: string, k = 1) {
  const n = doc.nodes.get(id);
  const r = (p: [number, number] | null) =>
    p ? p.map((v) => Math.round(v * 100) / 100).join(" ") : "";
  const s = n?.type === "path" ? localAnchors(n)[k] : undefined;
  return (
    s && [...s.anchors.map((a) => [r(a.anchor), r(a.handleIn), r(a.handleOut)].join(",")), s.closed]
  );
}

type Step = (doc: Document, a: Node) => void;

/**
 * a's hole as the DO stores it after the person makes `first` and then `then` on a with its hole's
 * Anchor 0 chosen. `when` says whether `then` was made once `first` was answered, or before, with
 * `first` then accepted or rejected.
 */
function inOrder(first: Step, then: Step, when: "after" | "accepted" | "rejected", hole?: string) {
  const { doc, a } = rings(hole);
  const chosen = { anchors: [anchorKey(a.id, 1, 0)] };
  useStore.setState(viewState({ doc, selection: [a.id], role: "owner", ...chosen }));
  vi.advanceTimersByTime(1000);
  const { server, answer, serveAll } = serve(doc);
  first(doc, a);
  if (when === "after") serveAll();
  then(useStore.getState().doc as Document, a);
  if (when === "rejected") answer(true);
  serveAll();
  return stored(server, a.id);
}

/** Each gesture in `grabs` dragged right by 6. */
const gestureOf =
  (g: (typeof grabs)[string]): Step =>
  (doc) => {
    const [x, y] = g.at;
    g.down(doc, x, y);
    g.move(doc, x + 3, y);
    g.move(doc, x + 6, y);
    g.up(doc, x + 6, y);
  };

/** What a rejected command leaves: it was sent, so the keys it cleared stay cleared. */
const nothing: Step = () => useStore.setState({ anchors: [], segments: [] });
const addAnchorClick: Step = (doc) => addAnchorTool.down?.(event(doc, 10, 14));
/** An Add Anchor click on the hole's bottom, out of reach of every gesture's press. */
const addAnchorBelow: Step = (doc) => addAnchorTool.down?.(event(doc, 15, 20));

it("sends a drag made before an Add Anchor click's answer after it, on the Anchor pressed (#298 T1)", () => {
  vi.useFakeTimers();
  for (const outcome of ["accepted", "rejected"] as const) {
    const { doc, a } = rings();
    useStore.setState(viewState({ doc, selection: [a.id], role: "owner" }));
    const { server, answer, serveAll } = serve(doc);
    addAnchorClick(doc, a);
    directTool.down(event(doc, 20, 10));
    directTool.move?.(event(doc, 25, 10));
    directTool.up?.(event(doc, 25, 10));
    // Nothing but the click goes out until its answer.
    expect(commands().map((c) => c.type)).toEqual(["path_edit"]);
    answer(outcome === "rejected");
    expect(commands()[1], outcome).toEqual({
      type: "path_edit",
      input: {
        nodeId: a.id,
        ops: [
          { op: "move_anchor", subpath: 1, index: outcome === "accepted" ? 4 : 3, to: [25, 10] },
        ],
      },
    });
    serveAll();
    const at = (stored(server, a.id) as string[]).slice(0, -1).map((s) => s.split(",")[0]);
    expect(at, outcome).toEqual(
      outcome === "accepted"
        ? ["10 10", "10 14", "10 20", "20 20", "25 10"]
        : ["10 10", "10 20", "20 20", "25 10"],
    );
  }
  vi.useRealTimers();
});

it("stores what each gesture made before an Add Anchor click's answer would store after it (#298 T2)", () => {
  vi.useFakeTimers();
  for (const [name, g] of Object.entries(grabs)) {
    const then = gestureOf(g);
    const after = inOrder(addAnchorBelow, then, "after", g.hole);
    expect(inOrder(addAnchorBelow, then, "accepted", g.hole), name).toEqual(after);
    expect(after, name).not.toEqual(inOrder(nothing, then, "after", g.hole));
    expect(inOrder(addAnchorBelow, then, "rejected", g.hole), name).toEqual(
      inOrder(nothing, then, "after", g.hole),
    );
  }
  vi.useRealTimers();
});

it("renumbers a drag still being made when the answer it waits for comes mid-drag, and the drag goes on (#298 T3)", () => {
  vi.useFakeTimers();
  for (const [name, g] of Object.entries(grabs)) {
    const then = gestureOf(g);
    const expected = inOrder(addAnchorBelow, then, "after", g.hole);
    const { doc, a } = rings(g.hole);
    const chosen = { anchors: [anchorKey(a.id, 1, 0)] };
    useStore.setState(viewState({ doc, selection: [a.id], role: "owner", ...chosen }));
    vi.advanceTimersByTime(1000);
    const { server, queue, answer } = serve(doc);
    addAnchorBelow(doc, a);
    const [x, y] = g.at;
    g.down(doc, x, y);
    g.move(doc, x + 3, y);
    answer();
    // The drag goes on, its preview on the point pressed: as the next move to the same place draws it.
    const now = useStore.getState().doc as Document;
    const shown = () => stored(previewAll(now, previewsOf(useStore.getState())), a.id);
    const kept = shown();
    expect(useStore.getState().edit, name).not.toBeNull();
    g.move(now, x + 3, y);
    expect(kept, name).toEqual(shown());
    g.move(now, x + 6, y);
    g.up(now, x + 6, y);
    // The release is sent at once.
    expect(queue.length, name).toBe(1);
    answer();
    expect(stored(server, a.id), name).toEqual(expected);
  }
  vi.useRealTimers();
});

/** A path along y = 0 with Anchors at x = 0, 10, 20, 30 and 40, selected. */
function line() {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 200 }],
  });
  const [p] = createNodes(doc, [{ type: "path", parentId, d: "M 0 0 L 10 0 L 20 0 L 30 0 L 40 0" }])
    .nodes as [PathNode];
  useStore.setState(viewState({ doc, selection: [p.id], role: "owner", tool: "pen" }));
  return { doc, p };
}

it("sends quick Add and Delete Anchor and Pen Auto Add/Delete clicks one answer apart, each on the point clicked (#298 T4)", () => {
  const pen = (x: number) => () => {
    penDown([x, 0], 1);
    penUp();
  };
  const clicks: Record<string, [Record<number, () => void>, number[]]> = {
    "Delete Anchor Point": [
      {
        10: () => deleteAnchorTool.down?.(event(useStore.getState().doc as Document, 10, 0)),
        30: () => deleteAnchorTool.down?.(event(useStore.getState().doc as Document, 30, 0)),
      },
      [0, 20, 40],
    ],
    "Add Anchor Point": [
      {
        5: () => addAnchorTool.down?.(event(useStore.getState().doc as Document, 5, 0)),
        25: () => addAnchorTool.down?.(event(useStore.getState().doc as Document, 25, 0)),
      },
      [0, 5, 10, 20, 25, 30, 40],
    ],
    "the Pen's Auto Delete": [{ 10: pen(10), 30: pen(30) }, [0, 20, 40]],
    "the Pen's Auto Add": [{ 5: pen(5), 25: pen(25) }, [0, 5, 10, 20, 25, 30, 40]],
  };
  for (const [name, [click, xs]] of Object.entries(clicks)) {
    const { doc, p } = line();
    const { server, answer } = serve(doc);
    for (const run of Object.values(click)) run();
    // The second waits for the first one's answer.
    expect(commands(), name).toHaveLength(1);
    answer();
    expect(commands(), name).toHaveLength(2);
    answer();
    const at = (server.nodes.get(p.id) as PathNode).d;
    const anchors = toAnchors(parsePath(at, "d"))[0]?.anchors.map((a) => Math.round(a.anchor[0]));
    expect(anchors, name).toEqual(xs);
  }
});

it("adds a quick second Add Anchor click on the half of the segment it was clicked on (#298 T4)", () => {
  const { doc, p } = line();
  editPath(doc, { nodeId: p.id, ops: [{ op: "set_d", d: "M 0 0 L 100 0" }] });
  const { server, serveAll } = serve(doc);
  for (const x of [30, 70]) addAnchorTool.down?.(event(useStore.getState().doc as Document, x, 0));
  serveAll();
  const anchors = toAnchors(parsePath((server.nodes.get(p.id) as PathNode).d, "d"))[0]?.anchors;
  expect(anchors?.map((a) => Math.round(a.anchor[0]))).toEqual([0, 30, 70, 100]);
});

/** The Edit menu's Clear, or an Object > Path item by its label. */
const menuItem = (label: string) => {
  const find = (items: Item[]): MenuItem | undefined => {
    for (const i of items) {
      if (i === "-") continue;
      const found = "items" in i ? find(i.items) : i.label === label ? i : undefined;
      if (found) return found;
    }
  };
  return find(documentMenus({ open() {}, close() {} })) as MenuItem;
};

/** Chooses a's hole Anchor at `index` with `tool`, then `run`s. */
const onChosen =
  (index: number, run: () => void, tool: ViewState["tool"] = "direct"): Step =>
  (_, a) => {
    useStore.setState({ anchors: [anchorKey(a.id, 1, index)], segments: [], tool });
    run();
  };

it("adds an Anchor clicked before a Clear's answer on the subpath the Clear renumbered (#298)", () => {
  const { doc, a } = rings();
  const outer = [0, 1, 2, 3].map((i) => anchorKey(a.id, 0, i));
  useStore.setState(viewState({ doc, selection: [a.id], role: "owner", anchors: outer }));
  const { server, serveAll } = serve(doc);
  menuItem("Clear").run();
  addAnchorClick(doc, a);
  serveAll();
  const at = (stored(server, a.id, 0) as string[]).slice(0, -1).map((s) => s.split(",")[0]);
  expect(at).toEqual(["10 10", "10 14", "10 20", "20 20", "20 10"]);
});

// Each command that may renumber a's hole, made on its Anchor at (10, 20), or on its bottom.
const renumbering: Record<string, Step> = {
  "Edit > Clear": onChosen(1, () => menuItem("Clear").run()),
  "Remove Anchor Points": onChosen(1, () => menuItem("Remove Anchor Points").run()),
  "the Curvature tool's Clear": onChosen(1, () => menuItem("Clear").run(), "curvature"),
  "the Pen's Auto Add": (_, a) => {
    useStore.setState({ selection: [a.id], tool: "pen" });
    penDown([15, 20], 1);
    penUp();
  },
  "an Add Anchor click": addAnchorBelow,
};

/** A Direct Selection drag of the Anchor at (20, 10) to (26, 10). */
const dragAnchor: Step = (doc) => {
  directTool.down(event(doc, 20, 10));
  directTool.move?.(event(doc, 23, 10));
  directTool.move?.(event(doc, 26, 10));
  directTool.up?.(event(doc, 26, 10));
};

it("holds a drag behind each command that may renumber its path, and stores what the order the person used stores (#298 T5)", () => {
  vi.useFakeTimers();
  for (const [name, first] of Object.entries(renumbering)) {
    const after = inOrder(first, dragAnchor, "after");
    expect(inOrder(first, dragAnchor, "accepted"), name).toEqual(after);
    expect(inOrder(first, dragAnchor, "rejected"), name).toEqual(
      inOrder(nothing, dragAnchor, "after"),
    );
  }
  vi.useRealTimers();
});

it("drops a held drag whose pressed Anchor the command removed, silently (#298 T5)", () => {
  vi.useFakeTimers();
  for (const name of ["Edit > Clear", "Remove Anchor Points", "the Curvature tool's Clear"]) {
    const clear = { "Edit > Clear": "Clear", "Remove Anchor Points": "Remove Anchor Points" }[name];
    const first = onChosen(
      3,
      () => menuItem(clear ?? "Clear").run(),
      clear ? "direct" : "curvature",
    );
    const cleared = inOrder(first, nothing, "after");
    expect(inOrder(first, dragAnchor, "accepted"), name).toEqual(cleared);
    expect(commands(), name).toHaveLength(1);
    expect(useStore.getState().notice, name).toBeNull();
  }
  vi.useRealTimers();
});

it("deletes with Edit > Clear the Anchor chosen before the answer that renumbered it (#298)", () => {
  vi.useFakeTimers();
  const chooseAndClear: Step = (doc) => {
    // A click selects at once, on the Document shown.
    directTool.down(event(doc, 20, 20));
    directTool.up?.(event(doc, 20, 20));
    menuItem("Clear").run();
  };
  const deleteClick: Step = (doc) => deleteAnchorTool.down?.(event(doc, 10, 20));
  const after = inOrder(deleteClick, chooseAndClear, "after");
  expect(inOrder(deleteClick, chooseAndClear, "accepted")).toEqual(after);
  expect(inOrder(deleteClick, chooseAndClear, "rejected")).toEqual(
    inOrder(nothing, chooseAndClear, "after"),
  );
  vi.useRealTimers();
});

it("never sends an edit made before the answer to Undo, Redo or Simplify with indices from before it (#298 T6)", () => {
  vi.useFakeTimers();
  const menus = documentMenus({ open() {}, close() {} });
  const undo = () => findByKeys(menus, "Ctrl+Z")?.run();
  const redo = () => findByKeys(menus, "Shift+Ctrl+Z")?.run();
  const commandsOf: Record<string, (a: Node) => void> = {
    Undo: undo,
    Redo: undo,
    Simplify: (a) => sendPreviewedOp({ nodeIds: [a.id], op: "simplify", tolerance: 5 }, false),
  };
  for (const [name, command] of Object.entries(commandsOf)) {
    for (const outcome of ["accepted", "rejected"] as const) {
      const label = `${name}, ${outcome}`;
      const { doc, a } = rings();
      useStore.setState(viewState({ doc, selection: [a.id], role: "owner" }));
      vi.advanceTimersByTime(1000);
      const { server, answer, serveAll } = serve(doc);
      // An earlier Add Anchor click on a, answered; Redo first undoes it.
      addAnchorClick(doc, a);
      answer();
      command(a);
      if (name === "Redo") {
        answer();
        redo();
      }
      const before = structuredClone(server.nodes.get(a.id));
      dragAnchor(useStore.getState().doc as Document, a);
      expect(commands().at(-1)?.type, label).not.toBe("path_edit");
      answer(outcome === "rejected");
      serveAll();
      // Accepted, the answer reshapes a and drops the drag; rejected, the drag is sent and stored.
      const reshaped = JSON.stringify(server.nodes.get(a.id)) !== JSON.stringify(before);
      const moved = commands().filter((c) => c.type === "path_edit").length > 1;
      expect({ reshaped, moved }, label).toEqual({ reshaped: true, moved: outcome === "rejected" });
      expect(useStore.getState().held, label).toEqual([]);
    }
  }
  vi.useRealTimers();
});

it("runs a drag held behind an Undo whose answer leaves its path as it was (#298 T6)", () => {
  vi.useFakeTimers();
  const { doc, a, b } = rings();
  useStore.setState(viewState({ doc, selection: [a.id, b.id], role: "owner" }));
  vi.advanceTimersByTime(1000);
  const { server, answer, serveAll } = serve(doc);
  // An earlier Add Anchor click on b's hole, answered, which the Undo takes back.
  addAnchorTool.down?.(event(doc, 60, 14));
  answer();
  findByKeys(documentMenus({ open() {}, close() {} }), "Ctrl+Z")?.run();
  dragAnchor(useStore.getState().doc as Document, a);
  expect(commands().at(-1)?.type).toBe("undo");
  serveAll();
  expect(commands().at(-1)).toEqual({
    type: "path_edit",
    input: { nodeId: a.id, ops: [{ op: "move_anchor", subpath: 1, index: 3, to: [26, 10] }] },
  });
  expect((stored(server, a.id) as string[])[3]?.split(",")[0]).toBe("26 10");
  vi.useRealTimers();
});

it("drops a drag held behind the person's own command when another Actor reshapes its path (#298 T8)", () => {
  vi.useFakeTimers();
  const { doc, a } = rings();
  useStore.setState(viewState({ doc, selection: [a.id], role: "owner" }));
  const { server, answer, theirs } = serve(doc);
  addAnchorClick(doc, a);
  dragAnchor(doc, a);
  theirs((d) =>
    editPath(d, { nodeId: a.id, ops: [{ op: "move_anchor", subpath: 1, index: 2, to: [22, 22] }] }),
  );
  answer();
  expect(commands().map((c) => c.type)).toEqual(["path_edit"]);
  const at = (stored(server, a.id) as string[]).slice(0, -1).map((s) => s.split(",")[0]);
  expect(at).toEqual(["10 10", "10 14", "10 20", "22 22", "20 10"]);
  vi.useRealTimers();
});

it("redraws a Pencil stretch held behind the person's own command from its Ink, or drops it with its notice (#298)", () => {
  const del = (x: number, y: number) => (doc: Document) =>
    deleteAnchorTool.down?.(event(doc, x, y));
  // A Delete Anchor click elsewhere, even on the path's first Anchor, leaves the stretch to redraw;
  // Add Anchor Points reshapes the path in a way the browser cannot number.
  const cases: [string, (doc: Document) => void, boolean][] = [
    ["Delete Anchor (9, 9)", del(9, 9), true],
    ["Delete Anchor (0, 0)", del(0, 0), true],
    ["Add Anchor Points", () => menuItem("Add Anchor Points").run(), false],
  ];
  for (const [name, first, runs] of cases) {
    const { doc, defaultLayerId: parentId } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 200, height: 200 }],
    });
    const [p] = createNodes(doc, [
      { type: "path", parentId, d: "M0 0 L9 0 L9 9 L0 9 Z M50 0 L80 0 L80 30" },
    ]).nodes as [PathNode];
    useStore.setState(viewState({ doc, selection: [p.id], role: "owner", tool: "pencil" }));
    const { server, serveAll } = serve(doc);
    first(doc);
    drawnEdits["a Pencil redraw"]();
    expect(commands(), name).toHaveLength(1);
    serveAll();
    expect(commands(), name).toHaveLength(runs ? 2 : 1);
    expect(useStore.getState().notice ?? "", name).toMatch(runs ? /^$/ : /Pencil .*not applied/);
    const open = (stored(server, p.id) as string[])
      .slice(0, -1)
      .map((s) => (s.split(",")[0] as string).split(" ").map(Number).map(Math.round).join(" "));
    if (runs) {
      expect(open.slice(0, 3), name).toEqual(["50 0", "80 0", "80 10"]);
      expect(open.slice(-2), name).toEqual(["80 25", "80 30"]);
    } else expect(open, name).toEqual(["50 0", "65 0", "80 0", "80 15", "80 30"]);
  }
});

it("after a reconnect with the person's own command unanswered, runs a held drag only on a path as it was (#298 T9)", () => {
  vi.useFakeTimers();
  for (const applied of [false, true]) {
    const { doc, a } = rings();
    useStore.setState(viewState({ doc, selection: [a.id], role: "owner" }));
    const { server, queue } = serve(doc);
    addAnchorClick(doc, a);
    dragAnchor(doc, a);
    // The socket drops before the click's answer; the DO applied it or not.
    const [click] = queue.splice(0);
    if (applied && click?.command.type === "path_edit") editPath(server, click.command.input);
    const nodes = [...server.nodes.values()];
    const after = stateAfter(
      useStore.getState(),
      message("document", { rev: server.rev + 1, artboards: doc.artboards, nodes }),
    );
    useStore.setState(after);
    runHeld(after.notice);
    expect(commands().slice(1), `${applied}`).toEqual(
      applied
        ? []
        : [
            {
              type: "path_edit",
              input: {
                nodeId: a.id,
                ops: [{ op: "move_anchor", subpath: 1, index: 3, to: [26, 10] }],
              },
            },
          ],
    );
    expect(useStore.getState().held, `${applied}`).toEqual([]);
  }
  vi.useRealTimers();
});

it("drops a drag made before the answer to a Remove Anchor Points that deletes its path, silently (#298 T5)", () => {
  vi.useFakeTimers();
  const { doc, p } = line();
  useStore.setState({ tool: "direct" });
  const { server, serveAll } = serve(doc);
  useStore.setState({ anchors: [1, 2, 3, 4].map((i) => anchorKey(p.id, 0, i)) });
  menuItem("Remove Anchor Points").run();
  directTool.down(event(doc, 0, 0));
  directTool.move?.(event(doc, 0, 5));
  directTool.up?.(event(doc, 0, 5));
  serveAll();
  expect(commands().map((c) => c.type)).toEqual(["delete"]);
  expect(server.nodes.has(p.id)).toBe(false);
  expect(useStore.getState().notice).toBeNull();
  vi.useRealTimers();
});

/** `n` with a red Fill, its geometry as it was. */
const refilled = (n: Node) =>
  ({ ...n, appearance: { fills: [{ type: "solid", color: "#FF0000" }], strokes: [] } }) as Node;

// #287: with only a press in flight, the Document sent on reconnect drops a held edit on a path the
// press did not name once someone else reshaped it, whether the press was applied or not; a change
// to its Fill alone, or none, leaves the edit to run.
it("after a reconnect, drops a held edit on a path the press did not name that someone else reshaped (#287)", () => {
  vi.useFakeTimers();
  const edits = {
    "a Pencil redraw": () => {
      pencilDown([10, 100]);
      for (const p of [
        [15, 95],
        [20, 90],
        [25, 92],
        [30, 105],
        [30, 115],
      ] as const)
        pencilMove([[...p]], { shift: false, alt: false });
      pencilUp(1);
    },
    "a Direct Selection drag": (doc: Document) => {
      directTool.down(event(doc, 30, 100));
      directTool.move?.(event(doc, 35, 100));
      directTool.up?.(event(doc, 35, 100));
    },
  };
  for (const [name, run] of Object.entries(edits)) {
    for (const applied of [false, true]) {
      for (const theirs of ["none", "fill", "reshape"] as const) {
        const label = `${name}, press ${applied ? "applied" : "lost"}, their ${theirs}`;
        const { doc, defaultLayerId: parentId } = createDocument({
          id: "d",
          name: "Doc",
          artboards: [{ width: 200, height: 200 }],
        });
        const [p, q] = createNodes(doc, [
          { type: "path", parentId, d: "M0 0 L9 0 L9 9 Z M50 0 L80 0 L80 30" },
          { type: "path", parentId, d: "M0 100 L30 100 L30 130" },
        ]).nodes as [PathNode, PathNode];
        const state = viewState({
          doc,
          selection: [p.id],
          role: "owner",
          anchors: [anchorKey(p.id, 1, 0)],
        });
        setDirection(state, !runsClockwise(doc, p, 1));
        const { reversing } = useStore.getState();
        expect(
          reversing?.subpaths.map((t) => t.nodeId),
          label,
        ).toEqual([p.id]);
        useStore.setState({
          ...state,
          reversing,
          selection: [p.id, q.id],
          held: [],
          sentPreviews: [],
        });
        vi.advanceTimersByTime(1000);
        vi.mocked(send).mockClear();
        run(doc);
        expect(commands(), label).toEqual([]);
        expect(useStore.getState().held.length, label).toBe(1);
        // The socket drops; meanwhile an Agent edits q, or not.
        const agents = {
          none: q,
          fill: refilled(q),
          reshape: editPath(structuredClone(doc), {
            nodeId: q.id,
            ops: [{ op: "move_anchor", subpath: 0, index: 0, to: [0, 90] }],
          }).node,
        }[theirs];
        const nodes = [...doc.nodes.values()].map((n) =>
          n.id === q.id ? agents : applied && n.id === p.id ? reversed(doc, p.id) : n,
        );
        deliver(message("document", { rev: 9, nodes }), "d", 0);
        const s = useStore.getState();
        expect(s.held, label).toEqual([]);
        if (theirs === "reshape") {
          expect(commands(), label).toEqual([]);
          expect(previewsOf(s), label).toEqual([{ edit: null, drag: null }]);
          expect(s.doc?.nodes.get(q.id), label).toEqual(agents);
          // The live key the drag left stays: the person sees the new q before acting on it.
          if (name === "a Direct Selection drag") {
            expect(s.anchors, label).toContain(anchorKey(q.id, 0, 1));
          }
          continue;
        }
        const [c] = commands();
        expect(c?.type === "path_edit" && c.input.nodeId, label).toBe(q.id);
      }
    }
  }
  vi.useRealTimers();
});

// #287: the Document sent on reconnect reads a change to the dragged path by its geometry, as it
// does for the keys, so a change to its Fill alone keeps the drag, with or without a press.
it("after a reconnect that changes only a dragged path's Fill, keeps the drag (#287)", () => {
  const snapshot = (doc: Document, a: Node, swap: (n: Node) => Node) =>
    message("document", {
      rev: doc.rev + 1,
      nodes: [...doc.nodes.values()].map((n) => (n.id === a.id ? swap(n) : n)),
    });
  const kept = (label: string, g: (typeof grabs)[string], index: number) => {
    expect(useStore.getState().grab?.targets.length ?? 0, label).toBeGreaterThan(0);
    const { moved, sent } = finish(g);
    expect(moved, label).toBe(index);
    const [c] = sent;
    expect(c?.type === "path_edit" && firstIndex(c.input), label).toBe(index);
  };
  dragThrough(
    (doc, a) => snapshot(doc, a, refilled),
    (name, g) => {
      expect(useStore.getState().notice, name).toBeNull();
      kept(name, g, g.index[0]);
    },
  );
  vi.useFakeTimers();
  for (const applied of [false, true]) {
    for (const [name, g] of Object.entries(grabs)) {
      const label = `${name}, press ${applied ? "applied" : "lost"}`;
      const { doc, a, pressed } = pressOn((a) => ({ anchors: [anchorKey(a.id, 1, 0)] }), g.hole);
      useStore.setState({ ...pressed, edit: null, drag: null, held: [], sentPreviews: [] });
      vi.advanceTimersByTime(1000);
      const [x, y] = g.at;
      g.down(doc, x, y);
      g.move(doc, x + 5, y);
      const msg = snapshot(doc, a, (n) => refilled(applied ? reversed(doc, n.id) : n));
      deliver(msg, "d", 0);
      kept(label, g, g.index[applied ? 1 : 0]);
    }
  }
  vi.useRealTimers();
});

// #301: a reconnect that only moves the path a held Pen finish continues, alone or inside its
// Group, keeps the finish, which goes with the path, as a held Pencil redraw does (#284).
it("after a reconnect that only moves the path a held Pen finish continues, carries it along (#301)", () => {
  for (const grouped of [false, true]) {
    for (const shift of [0, 40]) {
      const label = `${grouped ? "grouped" : "alone"}, ${shift}`;
      pressOnOpen({ grouped });
      const [, q] = useStore.getState().selection as [string, string];
      continueQ();
      expect(commands(), label).toEqual([]);
      const now = useStore.getState().doc as Document;
      const nodes = [...now.nodes.values()].map((n) =>
        n.id === q ? ({ ...n, transform: [1, 0, 0, 1, 0, shift] } as Node) : n,
      );
      deliver(message("document", { rev: 9, nodes }), "d", 0);
      expect(useStore.getState().notice, label).toBeNull();
      expect(storedAfterSent(q), label).toEqual({
        subpaths: [["0 100", "20 100", "40 100"]],
        transform: [1, 0, 0, 1, 0, shift],
      });
    }
  }
});

// #287: so does the Pen's continuation.
it("after a reconnect that changes only a continued path's Fill, keeps the Pen's continuation (#287)", () => {
  for (const applied of [false, true]) {
    pressOnOpen();
    const [p] = useStore.getState().selection as [string];
    penDown([80, 30], 1);
    penUp();
    const now = useStore.getState().doc as Document;
    const after = refilled(applied ? reversed(now, p) : (now.nodes.get(p) as Node));
    const nodes = [...now.nodes.values()].map((n) => (n.id === p ? after : n));
    useStore.setState(
      stateAfter(useStore.getState(), message("document", { rev: now.rev + 1, nodes })),
    );
    runHeld();
    expect(useStore.getState().pen, `${applied}`).not.toBeNull();
    expect(useStore.getState().notice, `${applied}`).toBeNull();
    penDown([100, 30], 1);
    penUp();
    finishPen();
    expect(subpathsAfterSent(), `${applied}`).toEqual([
      applied ? ["100 30", "80 30", "80 0", "50 0"] : ["50 0", "80 0", "80 30", "100 30"],
    ]);
  }
});

/** Every path in `d` but `skip`, as its Anchors where the canvas draws them, sorted: copies' ids are new. */
const shapesBut = (d: Document, skip: string) =>
  [...d.nodes.values()]
    .filter((n): n is PathNode => n.type === "path" && n.id !== skip)
    .map((n) =>
      JSON.stringify(
        anchorsOf(d, n).map((x) => x.anchors.map((p) => p.anchor.map((v) => Math.round(v * 100)))),
      ),
    )
    .sort();

/** The Document as the canvas draws it: committed, with every preview in the order drawn. */
const drawnDoc = () => {
  const s = useStore.getState();
  return previewAll(s.doc as Document, previewsOf(s));
};

// #285: a Selection tool Alt-drag of a, sent at once, copies a before the Direct Selection edit held
// on a reshapes it, so the copy keeps a as it was; a plain move of a and the edit commute.
it("draws the previews in the order the Document DO applies their edits (#285)", () => {
  vi.useFakeTimers();
  // What opens the window the drag on a waits in, on b's hole: a press, or the person's own
  // renumbering command (#298).
  const openers: Record<string, (b: Node) => void> = {
    "a press": (b) =>
      setDirection({ ...useStore.getState(), anchors: [anchorKey(b.id, 1, 0)] }, true),
    "an Add Anchor click": () =>
      addAnchorTool.down?.(event(useStore.getState().doc as Document, 65, 20)),
  };
  for (const [opener, open] of Object.entries(openers)) {
    for (const outcome of ["accepted", "rejected"] as const) {
      for (const copy of [true, false]) {
        const label = `${opener}, ${outcome}, ${copy ? "copied" : "moved"}`;
        const { doc, a, b } = rings();
        useStore.setState(viewState({ doc, selection: [a.id, b.id], role: "owner" }));
        vi.advanceTimersByTime(1000);
        const { server, answer } = serve(doc);
        open(b);
        // a's hole Anchor at (20, 10) dragged to (26, 10), held for the opener's answer.
        directTool.down(event(doc, 20, 10));
        directTool.move?.(event(doc, 26, 10));
        directTool.up?.(event(doc, 26, 10));
        expect(useStore.getState().held, label).toHaveLength(1);
        // Then a Selection tool drag of a, released and sent at once.
        useStore.setState({ drag: { nodeIds: [a.id], dx: 100, dy: 50, copy } });
        commitDrag(unheld("the test's Selection tool drag"));
        const drawn = [shapesBut(drawnDoc(), b.id)];
        answer(outcome === "rejected");
        // The held edit ran and is sent, drawn after the drag sent before it, as a held edit's.
        const sent = useStore.getState().sentPreviews;
        expect(
          sent.map((p) => !!p.fromHeld),
          label,
        ).toEqual([false, true]);
        expect(sent[1]?.edit?.inputs[0]?.nodeId, label).toBe(a.id);
        drawn.push(shapesBut(drawnDoc(), b.id));
        answer();
        drawn.push(shapesBut(drawnDoc(), b.id));
        answer();
        const stored = shapesBut(server, b.id);
        expect(drawn, label).toEqual([stored, stored, stored]);
        expect(shapesBut(drawnDoc(), b.id), label).toEqual(stored);
      }
    }
  }
  vi.useRealTimers();
});

it("runs the held edits after one that throws, leaves a drag in progress alone, and throws its error (#285)", () => {
  vi.useFakeTimers();
  for (const outcome of ["accepted", "rejected"] as const) {
    const { b, answer } = onRings();
    const doc = useStore.getState().doc as Document;
    // A held edit with a preview of its own, which throws when it runs; then one that sends.
    const own = { inputs: [{ nodeId: b.id, ops: [] }] };
    useStore.setState({ edit: own });
    afterReverse(
      () => {
        throw new Error("Boom.");
      },
      { previewed: true },
    );
    expect(useStore.getState().held[0]?.preview.edit, outcome).toBe(own);
    heldOnRings["a Direct Selection drag"]?.(doc);
    // A Direct Selection drag of b's top-left corner, (50, 0), to (55, 5), in progress.
    directTool.down(event(doc, 50, 0));
    directTool.move?.(event(doc, 55, 5));
    const shown = useStore.getState().edit;
    expect(() => answer(outcome), outcome).toThrow("Boom.");
    expect(useStore.getState().edit, outcome).toEqual(shown);
    expect(useStore.getState().held, outcome).toEqual([]);
    expect(
      commands().map((c) => c.type),
      outcome,
    ).toEqual(["path_edit"]);
    vi.mocked(send).mockClear();
    directTool.up?.(event(useStore.getState().doc as Document, 55, 5));
    expect(commands(), outcome).toEqual([
      {
        type: "path_edit",
        input: { nodeId: b.id, ops: [{ op: "move_anchor", subpath: 0, index: 0, to: [55, 5] }] },
      },
    ]);
  }
  vi.useRealTimers();
});

it("leaves the person's unanswered edit on screen through their next Direct Selection gestures (#285)", () => {
  const { doc, a, b } = rings();
  useStore.setState(viewState({ doc, selection: [a.id, b.id], role: "owner" }));
  const { answer } = serve(doc);
  const shown = () => stored(drawnDoc(), a.id);
  // a's hole Anchor at (20, 10) dragged to (26, 10), sent.
  directTool.down(event(doc, 20, 10));
  directTool.move?.(event(doc, 26, 10));
  directTool.up?.(event(doc, 26, 10));
  const edited = shown();
  expect(edited).not.toEqual(stored(doc, a.id));
  // Then b's Anchor at (50, 0) dragged, and b dragged whole, with every Anchor of it selected.
  for (const anchors of [[], allKeys(b as PathNode)]) {
    useStore.setState({ anchors, segments: [] });
    directTool.down(event(doc, 50, 0));
    directTool.move?.(event(doc, 53, 0));
    expect(shown(), `${anchors.length}`).toEqual(edited);
    directTool.up?.(event(doc, 53, 0));
    expect(shown(), `${anchors.length}`).toEqual(edited);
  }
  answer();
  expect(shown()).toEqual(edited);
  expect(useStore.getState().sentPreviews).toHaveLength(2);
});

it("after a reconnect, keeps drawing a drag it keeps, as its next move draws it (#285)", () => {
  vi.useFakeTimers();
  const cases: Record<string, { press: boolean; swap: (d: Document, n: Node, a: Node) => Node }> = {
    unchanged: { press: false, swap: (_, n) => n },
    "unchanged, a press in flight": { press: true, swap: (_, n) => n },
    "the press's reverse": {
      press: true,
      swap: (d, n, a) => (n.id === a.id ? reversed(d, a.id) : n),
    },
    "only its Fill changed": { press: false, swap: (_, n, a) => (n.id === a.id ? refilled(n) : n) },
    "only its Fill changed, a press in flight": {
      press: true,
      swap: (_, n, a) => (n.id === a.id ? refilled(n) : n),
    },
    // A drag the reconnect lets go of loses its preview.
    "reshaped, no press": {
      press: false,
      swap: (d, n, a) => (n.id === a.id ? reversed(d, a.id) : n),
    },
  };
  for (const [name, g] of Object.entries(grabs)) {
    for (const [kind, { press, swap }] of Object.entries(cases)) {
      const label = `${name}, ${kind}`;
      const chosen = (a: Node) => ({ anchors: [anchorKey(a.id, 1, 0)] });
      const { doc, a, pressed } = press
        ? pressOn(chosen, g.hole)
        : { ...rings(g.hole), pressed: {} };
      useStore.setState(
        press ? pressed : viewState({ doc, selection: [a.id], role: "owner", ...chosen(a) }),
      );
      vi.advanceTimersByTime(1000);
      const [x, y] = g.at;
      g.down(doc, x, y);
      g.move(doc, x + 5, y);
      const nodes = [...doc.nodes.values()].map((n) => swap(doc, n, a));
      const snapshot = message("document", { rev: doc.rev + 1, nodes });
      deliver(snapshot, "d", 0);
      const now = useStore.getState().doc as Document;
      const shown = stored(drawnDoc(), a.id);
      if (kind === "reshaped, no press") {
        expect(useStore.getState().edit, label).toBeNull();
        expect(shown, label).toEqual(stored(now, a.id));
      } else {
        expect(shown, label).not.toEqual(stored(now, a.id));
        g.move(now, x + 5, y);
        expect(stored(drawnDoc(), a.id), label).toEqual(shown);
      }
      g.cancel();
    }
  }
  vi.useRealTimers();
});

it("keeps commands with no preview in `sent` alone, beside the sent previews (#285)", () => {
  const { doc, a, b } = rings();
  useStore.setState(viewState({ doc, selection: [a.id, b.id], role: "owner" }));
  const { answer } = serve(doc);
  // A Direct Selection drag of a's hole Anchor at (20, 10), sent with its preview.
  directTool.down(event(doc, 20, 10));
  directTool.move?.(event(doc, 26, 10));
  directTool.up?.(event(doc, 26, 10));
  // An Add Anchor click on b's hole and a gradient Fill on b, each sent with no preview in the list.
  addAnchorTool.down?.(event(doc, 65, 20));
  const g = placeOn(b as LeafNode, {
    type: "linear",
    stops: [
      { offset: 0, color: "#000000" },
      { offset: 1, color: "#FFFFFF" },
    ],
  });
  sendPaint(paintUpdates([b as LeafNode], "fill", () => g));
  const s = useStore.getState();
  expect(commands().map((c) => c.type)).toEqual(["path_edit", "path_edit", "appearance"]);
  expect([...s.sent]).toEqual(["k1", "k2", "k3"]);
  expect(s.sentPreviews).toEqual([
    {
      edit: { inputs: [expect.objectContaining({ nodeId: a.id })], commandIds: ["k1"] },
      drag: null,
    },
  ]);
  // Each answer takes its own id out of `sent`, and only the edit's takes a preview out of the list.
  answer();
  expect([...useStore.getState().sent]).toEqual(["k2", "k3"]);
  expect(useStore.getState().sentPreviews).toEqual([]);
  answer();
  expect([...useStore.getState().sent]).toEqual(["k3"]);
  expect(useStore.getState().sentPreviews).toEqual([]);
});

// #286: a held edit's preview follows every answer that renumbers its keys, so it draws what the edit
// sends when it runs: a press's turn moves an index preview with the keys, and a `set_d` preview is
// worked out again on what its run will see.

/** Subpath `k` of `id` as the Direct Selection edit `p`'s preview draws it on the shown Document. */
const drawnBy = (id: string, p: PathDrag | null, k = 1) =>
  stored(previewEdit(useStore.getState().doc as Document, p ?? { inputs: [] }), id, k);

/** Held edits on a's hole whose preview names Anchors by index, each on the Anchor at (20, 10). */
const indexEdits: Record<string, Step> = {
  "a Direct Selection drag": dragAnchor,
  "a Curvature drag": (doc) => toolEdits["a Curvature drag"]?.(doc),
  "an Anchor Point drag out of an Anchor": (doc) =>
    toolEdits["an Anchor Point drag out of an Anchor"]?.(doc),
};

it("draws an edit held behind a second press on the Anchors it sends, after the first press turned its subpath (#286)", () => {
  vi.useFakeTimers();
  // A hole of Smooth Anchors too, whose Handles a Curvature drag sets the way the path runs.
  const k = 2.761;
  const round = `M10 10 C${10 - k} ${10 + k} ${10 - k} ${20 - k} 10 20 C${10 + k} ${20 + k} ${20 - k} ${20 + k} 20 20 C${20 + k} ${20 - k} ${20 + k} ${10 + k} 20 10 C${20 - k} ${10 - k} ${10 + k} ${10 - k} 10 10 Z`;
  for (const [name, edit] of Object.entries(indexEdits)) {
    for (const [outcome, hole] of [
      ["accepted", undefined],
      ["rejected", undefined],
      ["accepted", round],
      ["rejected", round],
    ] as const) {
      const label = `${name}, first press ${outcome}${hole ? ", Smooth" : ""}`;
      const { doc, a, b } = rings(hole);
      const chosen = { anchors: [anchorKey(a.id, 1, 0)] };
      useStore.setState(viewState({ doc, selection: [a.id, b.id], role: "owner", ...chosen }));
      vi.advanceTimersByTime(1000);
      const { server, answer, serveAll } = serve(doc);
      // A press on a's hole, then one on b's, held, then the edit on a's hole, held behind both.
      setDirection(useStore.getState(), true);
      afterReverse((s) => setDirection({ ...s, anchors: [anchorKey(b.id, 1, 0)] }, true));
      edit(doc, a);
      answer(outcome === "rejected");
      expect(useStore.getState().reversing, label).not.toBeNull();
      const [held] = useStore.getState().held;
      const shown = drawnBy(a.id, held?.preview.edit ?? null);
      expect(shown, label).not.toEqual(stored(useStore.getState().doc as Document, a.id));
      // The second press rejected, the edit runs on the Document as it is shown.
      answer(true);
      serveAll();
      expect(stored(server, a.id), label).toEqual(shown);
    }
  }
  vi.useRealTimers();
});

/** p, a closed subpath and an open one from (50, 0) through (80, 0) to (80, 30), and a line q. */
function pAndQ(tool: ViewState["tool"]) {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 200 }],
  });
  const [p, q] = createNodes(doc, [
    { type: "path", parentId, d: "M0 0 L9 0 L9 9 L0 9 Z M50 0 L80 0 L80 30" },
    { type: "path", parentId, d: "M0 100 L10 100 L20 100" },
  ]).nodes as [PathNode, PathNode];
  useStore.setState(viewState({ doc, selection: [p.id, q.id], role: "owner", tool }));
  return { doc, p, q };
}

it("draws a Pen finish held behind a second press as what it sends, after the first press turned its subpath (#286)", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    const { doc, p } = pAndQ("pen");
    const { answer } = serve(doc);
    // A press on p's open subpath, then one on its closed one, held, then the Pen continuing the
    // open one from (80, 30), held behind both.
    const press = (subpath: number) => (s: ViewState) =>
      setDirection(
        { ...s, anchors: [anchorKey(p.id, subpath, 0)] },
        !runsClockwise(s.doc as Document, s.doc?.nodes.get(p.id) as PathNode, subpath),
      );
    press(1)(useStore.getState());
    afterReverse(press(0));
    drawnEdits["a Pen continuing from an Endpoint"]();
    answer(outcome === "rejected");
    expect(useStore.getState().reversing, outcome).not.toBeNull();
    const shown = useStore.getState().held[0]?.preview.edit?.inputs;
    expect(shown, outcome).toHaveLength(1);
    answer(true);
    const sent = commands()[2];
    expect(sent && "input" in sent ? [sent.input] : sent, outcome).toEqual(shown);
  }
});

const deleteAt = (x: number, y: number) =>
  deleteAnchorTool.down?.(event(useStore.getState().doc as Document, x, y));

it("keeps a held Pencil redraw's and Pen finish's preview through a Delete Anchor click's answer, as what each sends (#286)", () => {
  const drawn = {
    "a Pencil redraw": ["pencil", drawnEdits["a Pencil redraw"]],
    "a Pen finish": ["pen", drawnEdits["a Pen continuing from an Endpoint"]],
  } as const;
  for (const [name, [tool, draw]] of Object.entries(drawn)) {
    for (const outcome of ["accepted", "rejected"] as const) {
      const label = `${name}, click ${outcome}`;
      const { doc } = pAndQ(tool);
      const { answer } = serve(doc);
      // A Delete Anchor click on p's closed subpath, then one on q, held, then the edit on p, held.
      deleteAt(9, 9);
      deleteAt(10, 100);
      draw();
      expect(commands(), label).toHaveLength(1);
      answer(outcome === "rejected");
      expect(commands(), label).toHaveLength(2);
      const [held] = useStore.getState().held;
      const shown = held?.preview.edit?.inputs;
      expect(shown, label).toHaveLength(1);
      // q's click rejected, the edit runs on the Document as it is shown.
      answer(true);
      const sent = commands()[2];
      expect(sent && "input" in sent ? [sent.input] : sent, label).toEqual(shown);
    }
  }
});

it("guards: a drag held behind two Delete Anchor clicks, or behind a press and a Delete Anchor click, draws what it sends (#286)", () => {
  vi.useFakeTimers();
  const firsts: Record<string, (b: Node) => void> = {
    "a Delete Anchor click": () => deleteAt(20, 20),
    "a press on b's hole": (b) =>
      setDirection({ ...useStore.getState(), anchors: [anchorKey(b.id, 1, 0)] }, true),
  };
  for (const [name, first] of Object.entries(firsts)) {
    const { doc, a, b } = rings();
    useStore.setState(viewState({ doc, selection: [a.id, b.id], role: "owner" }));
    vi.advanceTimersByTime(1000);
    const { server, answer, serveAll } = serve(doc);
    first(b);
    deleteAt(10, 20);
    dragAnchor(doc, a);
    answer();
    const shown = drawnBy(a.id, useStore.getState().held[0]?.preview.edit ?? null);
    answer(true);
    serveAll();
    expect(stored(server, a.id), name).toEqual(shown);
  }
  vi.useRealTimers();
});
