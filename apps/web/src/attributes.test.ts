import {
  createDocument,
  createNodes,
  type Document,
  editPath,
  type Node,
  type PathNode,
  parsePath,
  pathOp,
  signedArea,
  toAnchors,
} from "@kalamo/core";
import { expect, it, vi } from "vitest";
import { directionOf, fillRuleOf, setDirection, setFillRule } from "./attributes.ts";
import { anchorKey, localAnchors, parseKey } from "./direct.ts";
import { directTool } from "./directTool.ts";
import type { ViewState } from "./receive.ts";
import { afterReverse, runHeld, send, useStore } from "./store.ts";
import { message, stateAfter, viewState } from "./testing.ts";
import type { ToolEvent } from "./toolbox.ts";

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
  expect(useStore.getState().reversing).toEqual({
    commandId: "c",
    subpaths: [{ nodeId: ring, subpath: 1 }],
    inputs: [{ nodeId: ring, ops: [{ op: "reverse", subpath: 1 }] }],
  });
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
  const inFlight = { commandId: "c", subpaths: [], inputs: [] };
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
