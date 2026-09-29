import { bounds, createDocument, createNodes, type Document, type Node } from "@kalamo/core";
import type { TxMessage } from "@kalamo/sync";
import { expect, it } from "vitest";
import { anchorKey } from "./direct.ts";
import { afterProbe, copyInput, preview, previewEdit, previewOp, receive } from "./receive.ts";

function fixture() {
  const { doc, defaultLayerId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 100, height: 100 }],
  });
  const rect = { type: "rect", parentId: defaultLayerId, x: 0, y: 0, width: 10, height: 10 };
  const [a, b] = createNodes(doc, [rect, rect] as never).nodes as [Node, Node];
  return { doc, a, b };
}

const tx = (doc: Document, extra: Partial<TxMessage>): TxMessage => ({
  type: "tx",
  rev: doc.rev + 1,
  txId: "t",
  actor: "agent-a",
  intent: null,
  created: [],
  updated: [],
  deletedIds: [],
  ...extra,
});

const drag = (nodeIds: string[], commandId: string | null) => ({
  nodeIds,
  dx: 5,
  dy: 0,
  commandId,
});

it("keeps the drag preview until the tx answering its command arrives", () => {
  const { doc, a } = fixture();
  const state = {
    doc,
    selection: [a.id],
    drag: drag([a.id], "c1"),
    pen: null,
    pending: [],
    opPreview: null,
    notice: null,
    edit: null,
    anchors: [],
    segments: [],
    isolated: null,
  };
  const other = { ...state, ...receive(state, tx(doc, { actor: "agent-a" }), "d") };
  expect(other.drag).toBe(state.drag);
  expect(receive(state, tx(doc, { actor: "user", commandId: "c1" }), "d")).toMatchObject({
    drag: null,
  });
});

it("snaps back and shows a notice when its command is rejected", () => {
  const { doc, a } = fixture();
  const state = {
    doc,
    selection: [a.id],
    drag: drag([a.id], "c1"),
    pen: null,
    pending: [],
    opPreview: null,
    notice: null,
    edit: null,
    anchors: [],
    segments: [],
    isolated: null,
  };
  const error = { code: "NODE_GONE" as const, message: "gone", hint: "", nodeIds: [a.id] };
  const next = receive(state, { type: "rejected", id: "c1", error }, "d");
  expect(next).toMatchObject({ drag: null, notice: expect.stringContaining("deleted") });
});

it("shows a LAST_LAYER rejection's message and keeps the Selection (ADR-0073)", () => {
  const { doc, a } = fixture();
  const state = {
    doc,
    selection: [a.id, a.parentId as string],
    drag: null,
    pen: null,
    pending: [],
    opPreview: null,
    notice: null,
    edit: null,
    anchors: [],
    segments: [],
    isolated: null,
  };
  const message = "A Document keeps at least one top-level Layer.";
  const error = { code: "LAST_LAYER" as const, message, hint: "", nodeIds: [a.parentId as string] };
  const next = { ...state, ...receive(state, { type: "rejected", id: "c1", error }, "d") };
  expect(next.notice).toBe(message);
  expect(next.selection).toEqual(state.selection);
  expect(next.doc).toBe(doc);
});

it("drops deleted Nodes from the Selection", () => {
  const { doc, a, b } = fixture();
  const state = {
    doc,
    selection: [a.id, b.id],
    drag: null,
    pen: null,
    pending: [],
    opPreview: null,
    notice: null,
    edit: null,
    anchors: [],
    segments: [],
    isolated: null,
  };
  expect(receive(state, tx(doc, { deletedIds: [a.id] }), "d")).toMatchObject({
    selection: [b.id],
  });
});

it("asks to reconnect on a missed rev, and drops an unanswered drag on a new Document", () => {
  const { doc, a } = fixture();
  const state = {
    doc,
    selection: [a.id],
    drag: drag([a.id], "c1"),
    pen: null,
    pending: [],
    opPreview: null,
    notice: null,
    edit: null,
    anchors: [],
    segments: [],
    isolated: null,
  };
  expect(receive(state, tx(doc, { rev: doc.rev + 2 }), "d")).toBeNull();
  const msg = {
    type: "document" as const,
    rev: 9,
    name: "N",
    artboards: [],
    nodes: [a],
    role: "owner" as const,
  };
  expect(receive(state, msg, "d")).toMatchObject({ drag: null, selection: [a.id] });
});

it("previews a drag as core moves it, skipping Nodes deleted meanwhile", () => {
  const { doc, a, b } = fixture();
  const shown = preview(doc, drag([a.id, "gone"], null));
  expect(shown.nodes.get(a.id)?.transform).toEqual([1, 0, 0, 1, 5, 0]);
  expect(shown.nodes.get(b.id)).toBe(b);
  expect(doc.nodes.get(a.id)).toBe(a);
});

it("tells the person when an undo skipped Nodes deleted meanwhile", () => {
  const { doc, a } = fixture();
  const state = {
    doc,
    selection: [],
    drag: null,
    pen: null,
    pending: [],
    opPreview: null,
    notice: null,
    edit: null,
    anchors: [],
    segments: [],
    isolated: null,
  };
  expect(receive(state, tx(doc, { skippedIds: [a.id] }), "d")).toMatchObject({
    notice: expect.stringContaining("Skipped 1"),
  });
  expect(receive(state, tx(doc, {}), "d")).not.toHaveProperty("notice");
});

it("selects the Group a selected Node was just moved into, as Make Clipping Mask leaves it", () => {
  const { doc, a, b } = fixture();
  const state = {
    doc,
    selection: [a.id, b.id],
    drag: null,
    pen: null,
    pending: [],
    opPreview: null,
    notice: null,
    edit: null,
    anchors: [],
    segments: [],
    isolated: null,
  };
  const group = { ...a, id: "g", type: "group" } as unknown as Node;
  const moved = [a, b].map((n) => ({ ...n, parentId: "g" }));
  const made = { created: [group], updated: moved };
  expect(receive(state, tx(doc, { ...made, commandId: "m1" }), "d")).toMatchObject({
    selection: ["g"],
  });
  expect(receive(state, tx(doc, made), "d")).toMatchObject({ selection: [a.id, b.id] });
});

const pen = {
  anchors: [
    { anchor: [0, 0] as [number, number], handleIn: null, handleOut: null },
    { anchor: [10, 0] as [number, number], handleIn: null, handleOut: null },
  ],
  closed: false,
};
const pending = (commandId: string, select = true) => ({
  commandId,
  nodes: [{ type: "path" as const, parentId: "l", d: "M 0 0 L 10 0" }],
  select,
});

it("keeps each drawn create until its own answer, which selects what it made", () => {
  const { doc, a } = fixture();
  const state = {
    doc,
    selection: [a.id],
    drag: null,
    pen,
    pending: [pending("c1"), pending("c2", false)],
    opPreview: null,
    notice: null,
    edit: null,
    anchors: [],
    segments: [],
    isolated: null,
  };
  const other = receive(state, tx(doc, { actor: "agent-a" }), "d");
  expect(other).not.toHaveProperty("pending");
  expect(other?.selection).toEqual([a.id]);
  const path = { ...a, id: "p" };
  const answer = (commandId: string) =>
    receive(state, tx(doc, { actor: "user", commandId, created: [path] }), "d");
  // The path being drawn is not the one answered.
  expect(answer("c1")).not.toHaveProperty("pen");
  expect(answer("c1")).toMatchObject({ pending: [pending("c2", false)], selection: ["p"] });
  expect(answer("c2")).toMatchObject({ pending: [pending("c1")], selection: [] });
  const error = { code: "INVALID_PATH" as const, message: "no", hint: "" };
  const rejected = receive(state, { type: "rejected", id: "c1", error }, "d");
  expect(rejected).toEqual({ pending: [pending("c2", false)], notice: "no" });
});

it("keeps a path the Pen is still drawing across a reconnect, and drops every create in flight", () => {
  const { doc, a } = fixture();
  const state = {
    doc,
    selection: [a.id],
    drag: null,
    pen,
    pending: [],
    opPreview: null,
    notice: null,
    edit: null,
    anchors: [],
    segments: [],
    isolated: null,
  };
  const msg = {
    type: "document" as const,
    rev: 9,
    name: "N",
    artboards: [],
    nodes: [a],
    role: "owner" as const,
  };
  expect(receive(state, msg, "d")).not.toHaveProperty("pen");
  expect(receive(state, msg, "d")).not.toHaveProperty("pending");
  const sent = { ...state, pending: [pending("c1"), pending("c2")] };
  expect(receive(sent, msg, "d")).toMatchObject({ pending: [], selection: [a.id], isolated: null });
});

const move = (nodeId: string, index = 0) => ({
  nodeId,
  ops: [{ op: "move_anchor" as const, index, to: [5, 5] as [number, number] }],
});

it("keeps a Direct Selection drag's preview until every path_edit is answered", () => {
  const { doc, a, b } = fixture();
  const edit = { inputs: [move(a.id), move(b.id)], commandIds: ["c1", "c2"] };
  const state = {
    doc,
    selection: [a.id],
    drag: null,
    pen: null,
    pending: [],
    opPreview: null,
    notice: null,
    edit,
    anchors: [],
    segments: [],
    isolated: null,
  };
  expect(receive(state, tx(doc, { actor: "agent-a" }), "d")).not.toHaveProperty("edit");
  const first = { ...state, ...receive(state, tx(doc, { commandId: "c1" }), "d") };
  expect(first.edit).toEqual({ inputs: [move(b.id)], commandIds: ["c2"] });
  expect(receive(first, tx(first.doc ?? doc, { commandId: "c2" }), "d")).toMatchObject({
    edit: null,
  });
  // A rejection drops only that path's part of the preview.
  const error = { code: "INVALID_PATH" as const, message: "no", hint: "" };
  expect(receive(state, { type: "rejected", id: "c1", error }, "d")).toMatchObject({
    edit: { inputs: [move(b.id)], commandIds: ["c2"] },
  });
  // A reconnect loses the answers, so the preview goes.
  const msg = {
    type: "document" as const,
    rev: 9,
    name: "N",
    artboards: [],
    nodes: [a, b],
    role: "owner" as const,
  };
  expect(receive(state, msg, "d")).toMatchObject({ edit: null });
  // The preview converts the rect as core will, and leaves the Document alone.
  expect(previewEdit(doc, edit).nodes.get(a.id)).toMatchObject({ id: a.id, type: "path" });
  expect(doc.nodes.get(a.id)).toBe(a);
});

it("drops selected Anchors of a Node someone else changed, and keeps ours still in range", () => {
  const { doc, a, b } = fixture();
  const anchors = [anchorKey(a.id, 0, 3), anchorKey(b.id, 0, 1)];
  const state = {
    doc,
    selection: [a.id, b.id],
    drag: null,
    pen: null,
    pending: [],
    opPreview: null,
    notice: null,
    edit: null,
    anchors,
    segments: [],
    isolated: null,
  };
  const other = receive(state, tx(doc, { updated: [a] }), "d");
  expect(other?.anchors).toEqual([anchorKey(b.id, 0, 1)]);
  // Our own path_edit left a with three Anchors: its Anchor 3 is gone, b's stays.
  const triangle = { ...a, type: "path", d: "M 0 0 L 10 0 L 0 10 Z", fillRule: "nonzero" } as Node;
  const edit = { inputs: [move(a.id)], commandIds: ["c1"] };
  const own = receive({ ...state, edit }, tx(doc, { commandId: "c1", updated: [triangle] }), "d");
  expect(own?.anchors).toEqual([anchorKey(b.id, 0, 1)]);
  const kept = receive(
    { ...state, anchors: [anchorKey(a.id, 0, 2)], edit },
    tx(doc, { commandId: "c1", updated: [triangle] }),
    "d",
  );
  expect(kept?.anchors).toEqual([anchorKey(a.id, 0, 2)]);
  expect(receive(state, tx(doc, { deletedIds: [b.id] }), "d")?.anchors).toEqual([
    anchorKey(a.id, 0, 3),
  ]);
  // Selected segments follow the same rule: the rect's closing segment 3 is past the triangle's.
  const segments = [anchorKey(a.id, 0, 3), anchorKey(b.id, 0, 3)];
  const cut = { ...state, anchors: [], segments };
  expect(receive(cut, tx(doc, { updated: [a] }), "d")?.segments).toEqual([anchorKey(b.id, 0, 3)]);
  const ours = { ...cut, segments: [...segments, anchorKey(a.id, 0, 2)], edit };
  expect(receive(ours, tx(doc, { commandId: "c1", updated: [triangle] }), "d")?.segments).toEqual([
    anchorKey(b.id, 0, 3),
    anchorKey(a.id, 0, 2),
  ]);
});

it("keeps a Simplify preview until the answer to its path_op, and previews it with core", () => {
  const { doc, a } = fixture();
  const input = { nodeIds: [a.id], op: "simplify" as const };
  const opPreview = { input, showOriginal: false, commandId: null };
  const base = {
    doc,
    selection: [a.id],
    drag: null,
    pen: null,
    pending: [],
    opPreview: null,
    notice: null,
    edit: null,
  };
  const open = { ...base, opPreview, anchors: [], segments: [], isolated: null };
  // Not yet sent: nothing answers it, a reconnect included.
  expect(receive(open, tx(doc, { commandId: "c1" }), "d")).not.toHaveProperty("simplify");
  const msg = {
    type: "document" as const,
    rev: 9,
    name: "N",
    artboards: [],
    nodes: [a],
    role: "owner" as const,
  };
  expect(receive(open, msg, "d")).not.toHaveProperty("simplify");
  const sent = { ...open, opPreview: { ...opPreview, commandId: "c1" } };
  expect(receive(sent, tx(doc, { actor: "agent-a" }), "d")).not.toHaveProperty("simplify");
  expect(receive(sent, tx(doc, { commandId: "c1" }), "d")).toMatchObject({ opPreview: null });
  const error = { code: "INVALID_PATH" as const, message: "no", hint: "" };
  expect(receive(sent, { type: "rejected", id: "c1", error }, "d")).toMatchObject({
    opPreview: null,
  });
  expect(receive(sent, msg, "d")).toMatchObject({ opPreview: null });
  // The preview converts the rect as core will, and leaves the Document alone.
  expect(previewOp(doc, { input }).nodes.get(a.id)).toMatchObject({ id: a.id, type: "path" });
  expect(doc.nodes.get(a.id)).toBe(a);
  expect(previewOp(doc, { input: { ...input, nodeIds: ["gone"] } })).toBe(doc);
});

it("stops a tab only when the probe after an unopened socket reads 404 DOC_NOT_FOUND or 401", () => {
  expect(afterProbe({ status: 200 })).toBe("retry");
  expect(afterProbe({ status: 404, code: "DOC_NOT_FOUND" })).toEqual({
    notice: "This Document is no longer available to you.",
  });
  expect(afterProbe({ status: 401, code: "PERMISSION_DENIED" })).toBe("sign-in");
  expect(afterProbe(null)).toBe("retry");
  expect(afterProbe({ status: 503 })).toBe("retry");
  expect(afterProbe({ status: 404 })).toBe("retry");
});

it("previews an Alt-drag as copies above the topmost dragged Node, originals left (ADR-0076)", () => {
  const { doc, a, b } = fixture();
  const layer = a.parentId as string;
  expect(copyInput(doc, drag([b.id, a.id], null))).toEqual({
    nodeIds: [b.id, a.id],
    offset: { x: 5, y: 0 },
    targetParentId: layer,
    after: b.id,
  });
  const shown = preview(doc, { ...drag([a.id, b.id], null), copy: true });
  const kids = [...shown.nodes.values()].filter((n) => n.parentId === layer);
  kids.sort((p, q) => (p.index < q.index ? -1 : 1));
  expect(kids.map((n) => n.id).slice(0, 2)).toEqual([a.id, b.id]);
  expect(kids).toHaveLength(4);
  expect(kids.slice(2).map((n) => bounds(shown, n)?.x)).toEqual([5, 5]);
  expect(bounds(shown, shown.nodes.get(a.id) as Node)?.x).toBe(0);
  expect(doc.nodes.size).toBe(3);
});

it("copies the outermost Nodes a plain drag moves, and a Layer above its own original", () => {
  const { doc, a } = fixture();
  const layer = a.parentId as string;
  const [g, x] = createNodes(doc, [
    {
      type: "group",
      parentId: layer,
      children: [{ type: "rect", x: 0, y: 0, width: 5, height: 5 }],
    },
  ]).nodes as [Node, Node];
  // A Group with its own child: the Group's parent takes the block, above the Group.
  expect(copyInput(doc, drag([g.id, x.id], null))).toMatchObject({
    targetParentId: layer,
    after: g.id,
  });
  expect(preview(doc, { ...drag([g.id, x.id], null), copy: true }).nodes.size).toBe(
    doc.nodes.size + 2,
  );
  // A Layer with art from another Layer: each copy above its own original, the Layer's at the top level.
  const [other] = createNodes(doc, [{ type: "layer" }]).nodes as [Node];
  const input = copyInput(doc, drag([other.id, a.id], null));
  expect(input).toEqual({ nodeIds: [other.id, a.id], offset: { x: 5, y: 0 } });
  const shown = preview(doc, { ...drag([other.id, a.id], null), copy: true });
  const layers = [...shown.nodes.values()].filter((n) => n.parentId === null);
  layers.sort((p, q) => (p.index < q.index ? -1 : 1));
  expect(layers.map((n) => n.type)).toEqual(["layer", "layer", "layer"]);
  expect(layers.map((n) => n.id).slice(0, 2)).toEqual([layer, other.id]);
  expect([...shown.nodes.values()].filter((n) => n.parentId === layer)).toHaveLength(4);
});

it("selects an Alt-drag's copies once its own answer creates them, and only then", () => {
  const { doc, a } = fixture();
  const state = {
    doc,
    selection: [a.id],
    drag: { ...drag([a.id], "c1"), copy: true },
    pen: null,
    pending: [],
    opPreview: null,
    notice: null,
    edit: null,
    anchors: [],
    segments: [],
    isolated: null,
  };
  const group = { ...a, id: "g", type: "group", index: "b0" } as unknown as Node;
  const inside = { ...a, id: "x", parentId: "g" } as Node;
  const created = [group, inside];
  const agent = receive(state, tx(doc, { created, commandId: "other" }), "d");
  expect(agent).toMatchObject({ selection: [a.id] });
  expect(receive(state, tx(doc, { actor: "user", created, commandId: "c1" }), "d")).toMatchObject({
    drag: null,
    selection: ["g"],
  });
  const moved = { ...state, drag: drag([a.id], "c1") };
  expect(receive(moved, tx(doc, { actor: "user", created, commandId: "c1" }), "d")).toMatchObject({
    selection: [a.id],
  });
});
