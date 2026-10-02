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
import { send, useStore } from "./store.ts";
import { message, stateAfter, viewState } from "./testing.ts";

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
const commands = () => vi.mocked(send).mock.calls.map(([c]) => c);

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
  setDirection(s([anchorKey(ring, 1, 0)]), true);
  setDirection(s([anchorKey(ring, 1, 0), anchorKey(ring, 1, 1)], [anchorKey(ring, 1, 3)]), false);
  expect(commands()).toEqual([
    { type: "path_reverse", subpaths: [{ nodeId: ring, subpath: 1 }], clockwise: false },
  ]);
  // The chosen Anchors stay chosen, renumbered as the reverse renumbers its four: 0 stays, 1 is 3,
  // and the closing segment from 3 to 0 now runs from 0 to 1.
  expect(useStore.getState()).toMatchObject({
    anchors: [anchorKey(ring, 1, 0), anchorKey(ring, 1, 3)],
    segments: [anchorKey(ring, 1, 0)],
    edit: { inputs: [{ nodeId: ring, ops: [{ op: "reverse", subpath: 1 }] }], commandIds: ["c"] },
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

it("after a press another Actor raced, names only the Anchors the Direct Selection named (ADR-0109)", () => {
  vi.mocked(send).mockClear();
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 200 }],
  });
  // Two Compound Paths, each a clockwise square with a counter-clockwise hole.
  const ring = (x: number) =>
    `M${x} 0 L${x + 30} 0 L${x + 30} 30 L${x} 30 Z M${x + 10} 10 L${x + 10} 20 L${x + 20} 20 L${x + 20} 10 Z`;
  const [a, b] = createNodes(doc, [
    { type: "path", parentId, d: ring(0) },
    { type: "path", parentId, d: ring(50) },
  ]).nodes as [Node, Node];
  const at = (d: Document, key: string) => {
    const { nodeId, subpath, index } = parseKey(key);
    return localAnchors(d.nodes.get(nodeId) as PathNode)[subpath]?.anchors[index]?.anchor;
  };
  const state = viewState({
    doc,
    selection: [a.id, b.id],
    anchors: [anchorKey(a.id, 1, 1), anchorKey(b.id, 1, 1)],
    role: "owner",
  });
  setDirection(state, true);
  const holes = [
    { nodeId: a.id, subpath: 1 },
    { nodeId: b.id, subpath: 1 },
  ];
  expect(commands()).toEqual([{ type: "path_reverse", subpaths: holes, clockwise: true }]);
  const { edit, anchors, segments } = useStore.getState();
  const pressed = { ...state, edit, anchors, segments };
  const reversed = (d: Document, nodeId: string) =>
    editPath({ ...d, nodes: new Map(d.nodes) }, { nodeId, ops: [{ op: "reverse", subpath: 1 }] })
      .node;
  // An Agent reverses a's hole first, so the answer reverses only b's.
  const theirs = message("tx", {
    rev: doc.rev + 1,
    actor: "agent",
    updated: [reversed(doc, a.id)],
  });
  const raced = { ...pressed, ...stateAfter(pressed, theirs) };
  const shown = raced.doc as Document;
  const answer = message("tx", {
    rev: shown.rev + 1,
    commandId: "c",
    updated: [reversed(shown, b.id)],
  });
  const answered = { ...raced, ...stateAfter(raced, answer) };
  // a's Anchor goes with the Agent's edit, as any other Actor's edit to a path clears it; b's
  // follows the reverse to the same point.
  expect(answered).toMatchObject({ edit: null, anchors: [anchorKey(b.id, 1, 3)] });
  expect(at(answered.doc as Document, anchorKey(b.id, 1, 3))).toEqual([60, 20]);
  expect(at(doc, anchorKey(b.id, 1, 1))).toEqual([60, 20]);
});
