import {
  createDocument,
  createNodes,
  type Document,
  editPath,
  type Node,
  type PathNode,
  parsePath,
  pathOp,
  runsClockwise,
  signedArea,
  toAnchors,
  transformNodes,
} from "@kalamo/core";
import { expect, it, vi } from "vitest";
import { addAnchorTool, anchorPointTool, deleteAnchorTool } from "./anchorTools.ts";
import { directionOf, fillRuleOf, setDirection, setFillRule } from "./attributes.ts";
import { commitDrag } from "./canvas.ts";
import { curvatureDown, curvatureDrag, curvatureUp } from "./curvature.ts";
import { anchorKey, localAnchors, parseKey } from "./direct.ts";
import { directTool } from "./directTool.ts";
import { pencilDown, pencilMove, pencilUp } from "./pencil.ts";
import { previewAll, previewsOf, type ViewState } from "./receive.ts";
import { afterReverse, runHeld, send, unheld, useStore } from "./store.ts";
import { message, stateAfter, viewState } from "./testing.ts";
import type { ToolEvent } from "./toolbox.ts";
import { finishPen, penDown, penUp } from "./tools.ts";

vi.mock("./store.ts", async (original) => ({
  ...(await original<typeof import("./store.ts")>()),
  send: vi.fn(() => "c"),
}));

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

/** Two Compound Paths, each a clockwise square with a counter-clockwise hole. */
function rings() {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 200 }],
  });
  const ring = (x: number) =>
    `M${x} 0 L${x + 30} 0 L${x + 30} 30 L${x} 30 Z M${x + 10} 10 L${x + 10} 20 L${x + 20} 20 L${x + 20} 10 Z`;
  const [a, b] = createNodes(doc, [
    { type: "path", parentId, d: ring(0) },
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
function pressOn(keys: (a: Node, b: Node) => Partial<ViewState>) {
  vi.mocked(send).mockClear();
  const { doc, a, b } = rings();
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
    useStore.setState(stateAfter(useStore.getState(), msg));
    runHeld();
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
    useStore.setState(stateAfter(useStore.getState(), answer(doc, a.id)));
    runHeld();
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
  useStore.setState({ ...state, reversing: useStore.getState().reversing, edit: null });
  const ops = () => useStore.getState().edit?.inputs[0]?.ops;
  directTool.down(event(doc, 10, 15));
  directTool.move?.(event(doc, 15, 15));
  expect(ops()).toMatchObject([{ op: "set_handles", index: 0, handleOut: [15, 15] }]);
  const answer = message("tx", {
    rev: doc.rev + 1,
    commandId: "c",
    updated: [reversed(doc, ring.id)],
  });
  useStore.setState(stateAfter(useStore.getState(), answer));
  // Reversed, Anchor 0 stays first and the Handle is its in Handle.
  directTool.move?.(event(useStore.getState().doc as Document, 16, 15));
  expect(ops()).toMatchObject([{ op: "set_handles", index: 0, handleIn: [16, 15] }]);
  directTool.cancel?.(() => {});
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
  expect(stateAfter(pressed, snapshot)).toMatchObject({
    edit: null,
    reversing: null,
    anchors: [anchorKey(a.id, 1, 1), anchorKey(b.id, 1, 3)],
  });
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
    useStore.setState(stateAfter(useStore.getState(), msg));
    runHeld();
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
  useStore.setState(stateAfter(useStore.getState(), theirs));
  const shown = useStore.getState().doc as Document;
  useStore.setState(stateAfter(useStore.getState(), answer(shown, b.id)));
  runHeld();
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
const drawnEdits: Record<string, () => void> = {
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
};

/** Each subpath with an Anchor at (50, 0), as "x y" lists, after the commands sent. */
function openAfterSent() {
  const doc = structuredClone(useStore.getState().doc as Document);
  for (const c of commands()) {
    if (c.type === "path_edit") editPath(doc, c.input);
    if (c.type === "path_join") {
      editPath(doc, c.edit);
      pathOp(doc, c.join);
    }
  }
  const r = (p: [number, number]) => p.map((v) => Math.round(v)).join(" ");
  return [...doc.nodes.values()].flatMap((n) =>
    n.type === "path"
      ? localAnchors(n)
          .map((s) => s.anchors.map((a) => r(a.anchor)))
          .filter((s) => s.includes("50 0"))
      : [],
  );
}

/** p and q selected after a press reversing p's open subpath; `answer(outcome)` settles it. */
function pressOnOpen() {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 200 }],
  });
  const [p, q] = createNodes(doc, [
    { type: "path", parentId, d: "M0 0 L9 0 L9 9 Z M50 0 L80 0 L80 30" },
    { type: "path", parentId, d: "M0 100 L20 100" },
  ]).nodes as [PathNode, PathNode];
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
    useStore.setState(stateAfter(useStore.getState(), answered));
    runHeld();
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
      return openAfterSent();
    }),
  );
  const [continued, ended, joined, redrawn] = results.map(([accepted, rejected_]) => ({
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
    return openAfterSent();
  });
  expect(rejected_).toEqual([["50 0", "80 0", "80 30", "100 30"]]);
  expect(accepted).toEqual([["100 30", "80 30", "80 0", "50 0"]]);
});

it("drops a held Pen edit when another Actor edits its path before the answer (ADR-0109)", () => {
  const answer = pressOnOpen();
  drawnEdits["a Pen continuing from an Endpoint"]?.();
  theirEdit(useStore.getState().selection[0] as string, 1);
  answer("rejected");
  expect(commands()).toEqual([]);
  expect(useStore.getState().edit).toBeNull();
});

// #281: another Actor's edit to the path a held Pencil redraw starts on drops it, as it drops the
// Pen's; their edit to another path leaves it.
it("drops a held Pencil redraw when another Actor edits its path before the answer (ADR-0109)", () => {
  for (const outcome of ["accepted", "rejected"] as const) {
    for (const theirsOn of ["p", "q"] as const) {
      const label = `${outcome}, their edit on ${theirsOn}`;
      const answer = pressOnOpen();
      drawnEdits["a Pencil redraw"]?.();
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
      } else {
        // The redraw replaces the stretch from (80, 10) to (80, 25) on p as it then runs.
        expectRedrawn(outcome, label);
        expect(stored(q), label).toBe(moved.d);
      }
    }
  }
});

// #284: a held Pencil redraw acts on the path it was drawn over, whatever the person does to the
// Selection meanwhile, and its Ink moves with that path when the person moves it whole.

/** This tab's own Selection tool move of `nodeId` by (dx, dy), sent and answered in the window. */
function ownMove(nodeId: string, dx: number, dy: number) {
  vi.mocked(send).mockReturnValueOnce("m");
  useStore.setState({ drag: { nodeIds: [nodeId], dx, dy, commandId: null, copy: false } });
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
  const sent = openAfterSent();
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
      drawnEdits["a Pencil redraw"]?.();
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
    drawnEdits["a Pencil redraw"]?.();
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
    drawnEdits["a Pencil redraw"]?.();
    const [p] = useStore.getState().selection as [string, string];
    // The answer to the person's Direct Selection drag sent before the press puts p's open subpath
    // far from the Ink.
    useStore.setState({ edit: { inputs: [], commandIds: ["e"] } });
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
    expect(s.notice, outcome).toMatch(/Pencil/);
    const shown = previewAll(s.doc as Document, previewsOf(s)).nodes.get(p) as PathNode;
    expect(shown.d, outcome).toBe(((s.doc as Document).nodes.get(p) as PathNode).d);
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
      useStore.setState(stateAfter(useStore.getState(), outcome === "accepted" ? tx : rejected));
      runHeld();
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
      useStore.setState(stateAfter(useStore.getState(), tx));
      runHeld();
    },
  };
};

const everyHeld = [
  ...Object.entries(heldOnRings).map(([name, run]) => ({
    name,
    hold: onRings,
    run: () => run(useStore.getState().doc as Document),
  })),
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
        const edit = {
          inputs: [{ nodeId: "other", ops: [] }],
          commandIds: null,
        };
        const drag = { nodeIds: ["other"], dx: 3, dy: 0, commandId: null };
        settleHeld(hold, run, () => useStore.setState({ edit, drag }), outcome, dropped);
        expect(useStore.getState().edit, label).toBe(edit);
        expect(useStore.getState().drag, label).toBe(drag);
        expect(
          commands().filter((c) => c.type === "transform"),
          label,
        ).toEqual([]);
        expect(commands().length > 0, label).toBe(!dropped);
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
      drawnEdits["a Pen continuing from an Endpoint"] as () => void,
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
    expect(useStore.getState().edit?.inputs, outcome).toEqual([(edit as { input: unknown }).input]);
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
