import { createDocument, createNodes, type Document, type Node } from "@zibel/core";
import type { TxMessage } from "@zibel/sync";
import { expect, it } from "vitest";
import { anchorKey } from "./direct.ts";
import { preview, previewEdit, receive } from "./receive.ts";

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
    notice: null,
    edit: null,
    anchors: [],
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
    notice: null,
    edit: null,
    anchors: [],
  };
  const error = { code: "NODE_GONE" as const, message: "gone", hint: "", nodeIds: [a.id] };
  const next = receive(state, { type: "rejected", id: "c1", error }, "d");
  expect(next).toMatchObject({ drag: null, notice: expect.stringContaining("deleted") });
});

it("drops deleted Nodes from the Selection", () => {
  const { doc, a, b } = fixture();
  const state = {
    doc,
    selection: [a.id, b.id],
    drag: null,
    pen: null,
    notice: null,
    edit: null,
    anchors: [],
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
    notice: null,
    edit: null,
    anchors: [],
  };
  expect(receive(state, tx(doc, { rev: doc.rev + 2 }), "d")).toBeNull();
  const msg = { type: "document" as const, rev: 9, name: "N", artboards: [], nodes: [a] };
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
    notice: null,
    edit: null,
    anchors: [],
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
    notice: null,
    edit: null,
    anchors: [],
  };
  const group = { ...a, id: "g", type: "group" } as unknown as Node;
  const moved = [a, b].map((n) => ({ ...n, parentId: "g" }));
  const made = { created: [group], updated: moved };
  expect(receive(state, tx(doc, { ...made, commandId: "m1" }), "d")).toMatchObject({
    selection: ["g"],
  });
  expect(receive(state, tx(doc, made), "d")).toMatchObject({ selection: [a.id, b.id] });
});

const pen = (commandId: string | null) => ({
  points: [
    [0, 0],
    [10, 0],
  ] as [number, number][],
  closed: false,
  commandId,
});

it("keeps the Pen's path until its create is answered, then selects what it made", () => {
  const { doc, a } = fixture();
  const state = {
    doc,
    selection: [a.id],
    drag: null,
    pen: pen("c1"),
    notice: null,
    edit: null,
    anchors: [],
  };
  const other = receive(state, tx(doc, { actor: "agent-a" }), "d");
  expect(other).not.toHaveProperty("pen");
  expect(other?.selection).toEqual([a.id]);
  const path = { ...a, id: "p" };
  const answer = tx(doc, { actor: "user", commandId: "c1", created: [path] });
  expect(receive(state, answer, "d")).toMatchObject({ pen: null, selection: ["p"] });
  const error = { code: "INVALID_PATH" as const, message: "no", hint: "" };
  expect(receive(state, { type: "rejected", id: "c1", error }, "d")).toMatchObject({ pen: null });
});

it("keeps a path the Pen is still drawing across a reconnect", () => {
  const { doc, a } = fixture();
  const state = {
    doc,
    selection: [],
    drag: null,
    pen: pen(null),
    notice: null,
    edit: null,
    anchors: [],
  };
  const msg = { type: "document" as const, rev: 9, name: "N", artboards: [], nodes: [a] };
  expect(receive(state, msg, "d")).not.toHaveProperty("pen");
  expect(receive({ ...state, pen: pen("c1") }, msg, "d")).toMatchObject({ pen: null });
});

const move = (nodeId: string, index = 0) => ({
  nodeId,
  ops: [{ op: "move_anchor" as const, index, to: [5, 5] as [number, number] }],
});

it("keeps a Direct Selection drag's preview until every path_edit is answered", () => {
  const { doc, a, b } = fixture();
  const edit = { inputs: [move(a.id), move(b.id)], commandIds: ["c1", "c2"] };
  const state = { doc, selection: [a.id], drag: null, pen: null, notice: null, edit, anchors: [] };
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
  const msg = { type: "document" as const, rev: 9, name: "N", artboards: [], nodes: [a, b] };
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
    notice: null,
    edit: null,
    anchors,
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
});
