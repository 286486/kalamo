import { bounds, createDocument, createNodes, type Document, type Node } from "@kalamo/core";
import type { ServerMessage, TxMessage } from "@kalamo/sync";
import { expect, it } from "vitest";
import { anchorKey } from "./direct.ts";
import {
  afterProbe,
  copyInput,
  type Effect,
  joinNotices,
  type Preview,
  preview,
  previewEdit,
  previewOp,
  receive,
  type SentPreview,
  type ViewState,
} from "./receive.ts";
import { message, stateAfter, viewState } from "./testing.ts";

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

const tx = (doc: Document, extra: Partial<TxMessage>) =>
  message("tx", { rev: doc.rev + 1, ...extra });

const drag = (nodeIds: string[]) => ({ nodeIds, dx: 5, dy: 0 });
const sentDrag = (nodeIds: string[], commandId: string) => ({ ...drag(nodeIds), commandId });

/** One sent edit's preview, drawn until its answers (#285). */
const sentPreviews = (p: Partial<SentPreview>) => [{ edit: null, drag: null, ...p }];

it("keeps command ids off unsent previews and on sent ones (#306)", () => {
  const sent: SentPreview = { edit: { inputs: [], commandIds: ["c1"] }, drag: sentDrag([], "c2") };
  // @ts-expect-error A sent preview never goes back on a live slot or a held edit.
  const live: Preview = sent;
  // @ts-expect-error An unsent preview has no command ids its answers settle it by.
  const unsent: SentPreview = { edit: { inputs: [] }, drag: drag([]) };
  expect([live, unsent]).toHaveLength(2);
});

it("keeps the drag preview until the tx answering its command arrives", () => {
  const { doc, a } = fixture();
  const state = viewState({
    doc,
    selection: [a.id],
    sentPreviews: sentPreviews({ drag: sentDrag([a.id], "c1") }),
  });
  const other = { ...state, ...stateAfter(state, tx(doc, { actor: "agent-a" })) };
  expect(other.sentPreviews).toBe(state.sentPreviews);
  expect(stateAfter(state, tx(doc, { actor: "user", commandId: "c1" }))).toMatchObject({
    sentPreviews: [],
  });
});

it("snaps back and shows a notice when its command is rejected", () => {
  const { doc, a } = fixture();
  const state = viewState({
    doc,
    selection: [a.id],
    sentPreviews: sentPreviews({ drag: sentDrag([a.id], "c1") }),
  });
  const error = { code: "NODE_GONE" as const, message: "gone", hint: "", nodeIds: [a.id] };
  const next = stateAfter(state, message("rejected", { id: "c1", error }));
  expect(next).toMatchObject({ sentPreviews: [], notice: expect.stringContaining("deleted") });
});

it("shows a LAST_LAYER rejection's message and keeps the Selection (ADR-0073)", () => {
  const { doc, a } = fixture();
  const state = viewState({ doc, selection: [a.id, a.parentId as string] });
  const text = "A Document keeps at least one top-level Layer.";
  const nodeIds = [a.parentId as string];
  const error = { code: "LAST_LAYER" as const, message: text, hint: "", nodeIds };
  const next = { ...state, ...stateAfter(state, message("rejected", { error })) };
  expect(next.notice).toBe(text);
  expect(next.selection).toEqual(state.selection);
  expect(next.doc).toBe(doc);
});

it("drops deleted Nodes from the Selection", () => {
  const { doc, a, b } = fixture();
  const state = viewState({ doc, selection: [a.id, b.id] });
  expect(stateAfter(state, tx(doc, { deletedIds: [a.id] }))).toMatchObject({
    selection: [b.id],
  });
});

it("asks to reconnect on a missed rev, and drops an unanswered drag on a new Document", () => {
  const { doc, a } = fixture();
  const actorNames = new Map([["agent-a", "A"]]);
  const state = viewState({
    doc,
    selection: [a.id],
    sentPreviews: sentPreviews({ drag: sentDrag([a.id], "c1") }),
    actorNames,
  });
  expect(receive(state, tx(doc, { rev: doc.rev + 2 }), "d", 0)).toEqual({
    state: {},
    effects: [{ type: "reconnect" }],
  });
  const msg = message("document", { rev: 9, nodes: [a] });
  expect(stateAfter(state, msg)).toMatchObject({ sentPreviews: [], selection: [a.id] });
});

it.each([
  message("presence", { cursor: { x: 1, y: 2 } }),
  message("joined"),
  message("left"),
  message("staged"),
])("changes only the Peers on $type, or the Working Areas on staged (ADR-0090)", (msg) => {
  const { doc, a } = fixture();
  const actorNames = new Map([
    ["user_bob", "Bob"],
    ["agent-a", "A"],
  ]);
  const state = viewState({ doc, selection: [a.id], drag: drag([a.id]), actorNames });
  const next = stateAfter(state, msg);
  expect(Object.keys(next)).toEqual(msg.type === "staged" ? ["areas"] : ["peers"]);
});

it("asks to resend presence only on a document or joined, and to reconnect on none (ADR-0090)", () => {
  const { doc } = fixture();
  const state = viewState({ doc });
  const msgs = [
    message("document"),
    message("joined"),
    message("presence"),
    message("left"),
    message("staged"),
    tx(doc, {}),
    message("rejected"),
  ];
  const asking = (type: Effect["type"]) =>
    msgs.filter((m) => receive(state, m, "d", 0).effects.some((e) => e.type === type));
  expect(asking("resend-presence").map((m) => m.type)).toEqual(["document", "joined"]);
  expect(asking("reconnect")).toEqual([]);
});

const fetches = (s: ViewState, msg: ServerMessage) =>
  receive(s, msg, "d", 0).effects.filter((e) => e.type === "fetch-names");

it.each(["presence", "joined", "tx", "staged"] as const)(
  "fetches the names for a %s from an unseen Actor, once (ADR-0090)",
  (type) => {
    const { doc } = fixture();
    const msg =
      type === "tx" ? tx(doc, { actor: "user_bob" }) : message(type, { actor: "user_bob" });
    const state = viewState({ doc });
    const first = receive(state, msg, "d", 0);
    expect(first.effects).toContainEqual({ type: "fetch-names", actors: ["user_bob"] });
    expect(first.state.asked).toEqual(new Set(["user_bob"]));
    expect(fetches({ ...state, ...first.state }, msg)).toEqual([]);
    const known = viewState({ doc, actorNames: new Map([["user_bob", "Bob"]]) });
    expect(fetches(known, msg)).toEqual([]);
  },
);

it("fetches every Peer's name on each Document, and starts the asked Actors over", () => {
  const state = viewState({
    asked: new Set(["user_old"]),
    actorNames: new Map([["user_al", "Al"]]),
  });
  const msg = message("document", { peers: [{ peer: "p1", actor: "user_al" }] });
  const { state: next, effects } = receive(state, msg, "d", 0);
  expect(effects).toEqual([
    { type: "resend-presence" },
    { type: "fetch-names", actors: ["user_al"] },
  ]);
  expect(next.asked).toEqual(new Set(["user_al"]));
  expect(next.peers).toEqual(new Map([["p1", { actor: "user_al", cursor: null, selection: [] }]]));
  // With no Peers too: the Actor rows label the tx and staged that follow.
  expect(fetches(state, message("document"))).toEqual([{ type: "fetch-names", actors: [] }]);
  expect(fetches(state, message("left"))).toEqual([]);
  expect(fetches(state, message("rejected"))).toEqual([]);
});

it("moves an Actor's Working Area on tx and staged, at the time given (ADR-0090)", () => {
  const { doc } = fixture();
  const state = viewState({ doc });
  const bounds = { x: 1, y: 2, width: 3, height: 4 };
  const staged = stateAfter(state, message("staged", { bounds, intent: "draw" }), 5);
  expect(staged.areas).toEqual(new Map([["agent-a", { bounds, intent: "draw", at: 5 }]]));
  const done = stateAfter({ ...state, ...staged }, tx(doc, {}), 9);
  expect(done.areas).toEqual(new Map([["agent-a", { bounds, intent: "draw", at: 9 }]]));
  expect(stateAfter(state, message("presence"))).not.toHaveProperty("areas");
});

it("goes live with the Document's Role, and takes a viewer off a tool that edits (ADR-0047)", () => {
  const pen = viewState({ tool: "pen" });
  expect(stateAfter(pen, message("document", { role: "viewer" }))).toMatchObject({
    live: true,
    role: "viewer",
    tool: "selection",
  });
  const zoom = viewState({ tool: "zoom" });
  expect(stateAfter(zoom, message("document", { role: "viewer" }))).not.toHaveProperty("tool");
  const editor = stateAfter(pen, message("document", { role: "editor" }));
  expect(editor).toMatchObject({ live: true, role: "editor" });
  expect(editor).not.toHaveProperty("tool");
  expect(stateAfter(pen, message("presence"))).not.toHaveProperty("live");
});

it("previews a drag as core moves it, skipping Nodes deleted meanwhile", () => {
  const { doc, a, b } = fixture();
  const shown = preview(doc, drag([a.id, "gone"]));
  expect(shown.nodes.get(a.id)?.transform).toEqual([1, 0, 0, 1, 5, 0]);
  expect(shown.nodes.get(b.id)).toBe(b);
  expect(doc.nodes.get(a.id)).toBe(a);
});

it("tells the person when an undo skipped Nodes deleted meanwhile", () => {
  const { doc, a } = fixture();
  const state = viewState({ doc });
  expect(stateAfter(state, tx(doc, { skippedIds: [a.id] }))).toMatchObject({
    notice: expect.stringContaining("Skipped 1"),
  });
  expect(stateAfter(state, tx(doc, {}))).not.toHaveProperty("notice");
});

// #291: one Transaction that ends a Pen continuation and skipped Nodes says both.
it("keeps the Pen's notice beside the Skipped one from the same Transaction", () => {
  const { doc, a, b } = fixture();
  const pen = {
    anchors: [],
    from: { nodeId: a.id, subpath: 0, atStart: false, kept: 0 },
    closed: false,
  };
  const after = stateAfter(
    viewState({ doc, pen }),
    tx(doc, { actor: "agent", updated: [a], skippedIds: [b.id] }),
  );
  expect(after.pen).toBeNull();
  // Drawn work's first.
  expect(after.notice).toMatch(/^Someone else .*Pen .*not applied.* Skipped 1 /);
});

it("joins one message's notices in order, each once", () => {
  expect(joinNotices(["A.", null, "B.", false, "A.", undefined])).toBe("A. B.");
  expect(joinNotices([null, undefined])).toBe("");
});

it("selects the Group a selected Node was just moved into, as Make Clipping Mask leaves it", () => {
  const { doc, a, b } = fixture();
  const state = viewState({ doc, selection: [a.id, b.id] });
  const group = { ...a, id: "g", type: "group" } as unknown as Node;
  const moved = [a, b].map((n) => ({ ...n, parentId: "g" }));
  const made = { created: [group], updated: moved };
  expect(stateAfter(state, tx(doc, { ...made, commandId: "m1" }))).toMatchObject({
    selection: ["g"],
  });
  expect(stateAfter(state, tx(doc, made))).toMatchObject({ selection: [a.id, b.id] });
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
  const state = viewState({
    doc,
    selection: [a.id],
    pen,
    pending: [pending("c1"), pending("c2", false)],
  });
  const other = stateAfter(state, tx(doc, { actor: "agent-a" }));
  expect(other).not.toHaveProperty("pending");
  expect(other?.selection).toEqual([a.id]);
  const path = { ...a, id: "p" };
  const answer = (commandId: string) =>
    stateAfter(state, tx(doc, { actor: "user", commandId, created: [path] }));
  // The path being drawn is not the one answered.
  expect(answer("c1")).not.toHaveProperty("pen");
  expect(answer("c1")).toMatchObject({ pending: [pending("c2", false)], selection: ["p"] });
  expect(answer("c2")).toMatchObject({ pending: [pending("c1")], selection: [] });
  const rejected = stateAfter(state, message("rejected", { id: "c1" }));
  expect(rejected).toEqual({ pending: [pending("c2", false)], notice: "no" });
});

it("keeps a path the Pen is still drawing across a reconnect, and drops every create in flight", () => {
  const { doc, a } = fixture();
  const state = viewState({ doc, selection: [a.id], pen });
  const msg = message("document", { rev: 9, nodes: [a] });
  expect(stateAfter(state, msg)).not.toHaveProperty("pen");
  expect(stateAfter(state, msg)).not.toHaveProperty("pending");
  const sent = { ...state, pending: [pending("c1"), pending("c2")] };
  expect(stateAfter(sent, msg)).toMatchObject({ pending: [], selection: [a.id], isolated: null });
});

const move = (nodeId: string, index = 0) => ({
  nodeId,
  ops: [{ op: "move_anchor" as const, index, to: [5, 5] as [number, number] }],
});

it("keeps a Direct Selection drag's preview until every path_edit is answered", () => {
  const { doc, a, b } = fixture();
  const edit = { inputs: [move(a.id), move(b.id)], commandIds: ["c1", "c2"] };
  const state = viewState({ doc, selection: [a.id], sentPreviews: sentPreviews({ edit }) });
  expect(stateAfter(state, tx(doc, { actor: "agent-a" }))).not.toHaveProperty("sentPreviews");
  const first = { ...state, ...stateAfter(state, tx(doc, { commandId: "c1" })) };
  const left = sentPreviews({ edit: { inputs: [move(b.id)], commandIds: ["c2"] } });
  expect(first.sentPreviews).toEqual(left);
  expect(stateAfter(first, tx(first.doc ?? doc, { commandId: "c2" }))).toMatchObject({
    sentPreviews: [],
  });
  // A rejection drops only that path's part of the preview.
  expect(stateAfter(state, message("rejected", { id: "c1" }))).toMatchObject({
    sentPreviews: left,
  });
  // One command for both paths, as the Attributes panel's path_reverse, settles both at once.
  const one = {
    ...state,
    sentPreviews: sentPreviews({ edit: { ...edit, commandIds: ["c1", "c1"] } }),
  };
  expect(stateAfter(one, tx(doc, { commandId: "c1" }))).toMatchObject({ sentPreviews: [] });
  // A reconnect loses the answers, so the preview goes.
  const msg = message("document", { rev: 9, nodes: [a, b] });
  expect(stateAfter(state, msg)).toMatchObject({ sentPreviews: [] });
  // The preview converts the rect as core will, and leaves the Document alone.
  expect(previewEdit(doc, edit).nodes.get(a.id)).toMatchObject({ id: a.id, type: "path" });
  expect(doc.nodes.get(a.id)).toBe(a);
});

it("drops selected Anchors of a Node someone else changed, and keeps ours still in range", () => {
  const { doc, a, b } = fixture();
  const anchors = [anchorKey(a.id, 0, 3), anchorKey(b.id, 0, 1)];
  const state = viewState({ doc, selection: [a.id, b.id], anchors });
  const other = stateAfter(state, tx(doc, { updated: [a] }));
  expect(other?.anchors).toEqual([anchorKey(b.id, 0, 1)]);
  // Our own path_edit left a with three Anchors: its Anchor 3 is gone, b's stays.
  const triangle = { ...a, type: "path", d: "M 0 0 L 10 0 L 0 10 Z", fillRule: "nonzero" } as Node;
  const edit = { inputs: [move(a.id)], commandIds: ["c1"] };
  const ownEdit = { sentPreviews: sentPreviews({ edit }) };
  const own = stateAfter(
    { ...state, ...ownEdit },
    tx(doc, { commandId: "c1", updated: [triangle] }),
  );
  expect(own?.anchors).toEqual([anchorKey(b.id, 0, 1)]);
  const kept = stateAfter(
    { ...state, anchors: [anchorKey(a.id, 0, 2)], ...ownEdit },
    tx(doc, { commandId: "c1", updated: [triangle] }),
  );
  expect(kept?.anchors).toEqual([anchorKey(a.id, 0, 2)]);
  expect(stateAfter(state, tx(doc, { deletedIds: [b.id] }))?.anchors).toEqual([
    anchorKey(a.id, 0, 3),
  ]);
  // Selected segments follow the same rule: the rect's closing segment 3 is past the triangle's.
  const segments = [anchorKey(a.id, 0, 3), anchorKey(b.id, 0, 3)];
  const cut = { ...state, anchors: [], segments };
  expect(stateAfter(cut, tx(doc, { updated: [a] }))?.segments).toEqual([anchorKey(b.id, 0, 3)]);
  const ours = { ...cut, segments: [...segments, anchorKey(a.id, 0, 2)], ...ownEdit };
  expect(stateAfter(ours, tx(doc, { commandId: "c1", updated: [triangle] }))?.segments).toEqual([
    anchorKey(b.id, 0, 3),
    anchorKey(a.id, 0, 2),
  ]);
});

it("keeps a Simplify preview until the answer to its path_op, and previews it with core", () => {
  const { doc, a } = fixture();
  const input = { nodeIds: [a.id], op: "simplify" as const };
  const opPreview = { input, showOriginal: false, commandId: null };
  const open = viewState({ doc, selection: [a.id], opPreview });
  // Not yet sent: nothing answers it, a reconnect included.
  expect(stateAfter(open, tx(doc, { commandId: "c1" }))).not.toHaveProperty("simplify");
  const msg = message("document", { rev: 9, nodes: [a] });
  expect(stateAfter(open, msg)).not.toHaveProperty("simplify");
  const sent = { ...open, opPreview: { ...opPreview, commandId: "c1" } };
  expect(stateAfter(sent, tx(doc, { actor: "agent-a" }))).not.toHaveProperty("simplify");
  expect(stateAfter(sent, tx(doc, { commandId: "c1" }))).toMatchObject({ opPreview: null });
  expect(stateAfter(sent, message("rejected", { id: "c1" }))).toMatchObject({
    opPreview: null,
  });
  // A Gradient panel or tool preview lasts until its own answer too (ADR-0081).
  const painted = { ...open, paintPreview: { updates: [], commandId: "c2" } };
  expect(stateAfter(painted, tx(doc, { commandId: "c1" }))).not.toHaveProperty("paintPreview");
  expect(stateAfter(painted, tx(doc, { commandId: "c2" }))).toMatchObject({ paintPreview: null });
  expect(stateAfter(painted, message("rejected", { id: "c2" }))).toMatchObject({
    paintPreview: null,
  });
  expect(stateAfter(sent, msg)).toMatchObject({ opPreview: null });
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
  expect(copyInput(doc, drag([b.id, a.id]))).toEqual({
    nodeIds: [b.id, a.id],
    offset: { x: 5, y: 0 },
    targetParentId: layer,
    after: b.id,
  });
  const shown = preview(doc, { ...drag([a.id, b.id]), copy: true });
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
  expect(copyInput(doc, drag([g.id, x.id]))).toMatchObject({
    targetParentId: layer,
    after: g.id,
  });
  expect(preview(doc, { ...drag([g.id, x.id]), copy: true }).nodes.size).toBe(doc.nodes.size + 2);
  // A Layer with art from another Layer: each copy above its own original, the Layer's at the top level.
  const [other] = createNodes(doc, [{ type: "layer" }]).nodes as [Node];
  const input = copyInput(doc, drag([other.id, a.id]));
  expect(input).toEqual({ nodeIds: [other.id, a.id], offset: { x: 5, y: 0 } });
  const shown = preview(doc, { ...drag([other.id, a.id]), copy: true });
  const layers = [...shown.nodes.values()].filter((n) => n.parentId === null);
  layers.sort((p, q) => (p.index < q.index ? -1 : 1));
  expect(layers.map((n) => n.type)).toEqual(["layer", "layer", "layer"]);
  expect(layers.map((n) => n.id).slice(0, 2)).toEqual([layer, other.id]);
  expect([...shown.nodes.values()].filter((n) => n.parentId === layer)).toHaveLength(4);
});

it("selects an Alt-drag's copies once its own answer creates them, and only then", () => {
  const { doc, a } = fixture();
  const state = viewState({
    doc,
    selection: [a.id],
    sentPreviews: sentPreviews({ drag: { ...sentDrag([a.id], "c1"), copy: true } }),
  });
  const group = { ...a, id: "g", type: "group", index: "b0" } as unknown as Node;
  const inside = { ...a, id: "x", parentId: "g" } as Node;
  const created = [group, inside];
  const agent = stateAfter(state, tx(doc, { created, commandId: "other" }));
  expect(agent).toMatchObject({ selection: [a.id] });
  expect(stateAfter(state, tx(doc, { actor: "user", created, commandId: "c1" }))).toMatchObject({
    sentPreviews: [],
    selection: ["g"],
  });
  const moved = { ...state, sentPreviews: sentPreviews({ drag: sentDrag([a.id], "c1") }) };
  expect(stateAfter(moved, tx(doc, { actor: "user", created, commandId: "c1" }))).toMatchObject({
    selection: [a.id],
  });
});

it("selects a copied Layer as its row's click does: its objects, and its row (ADR-0076)", () => {
  const { doc, a, b } = fixture();
  const state = viewState({
    doc,
    selection: [a.id],
    pending: [{ commandId: "c1", nodes: [], select: true }],
    layerRows: ["old"],
  });
  const layer = { ...a, id: "L", type: "layer", parentId: null, name: "A copy" } as unknown as Node;
  const art = { ...a, id: "x", parentId: "L" } as Node;
  const locked = { ...a, id: "y", parentId: "L", locked: true } as Node;
  const copy = { ...b, id: "z" } as Node;
  const created = [layer, art, locked, copy];
  expect(stateAfter(state, tx(doc, { actor: "user", created, commandId: "c1" }))).toMatchObject({
    selection: ["x", "z"],
    layerRows: ["L"],
  });
});

it("keeps an unchanged Selection the same array, so the Layer rows stay; a changed one is new", () => {
  const { doc, a, b } = fixture();
  const state = viewState({ doc, selection: [a.id] });
  const other = stateAfter(state, tx(doc, { updated: [b] }));
  expect(other?.selection).toBe(state.selection);
  expect(other).not.toHaveProperty("layerRows");
  const gone = stateAfter(state, tx(doc, { deletedIds: [a.id] }));
  expect(gone?.selection).toEqual([]);
});

it("selects none of a copied Layer's objects when an ancestor hides or locks it, as its row", () => {
  const { doc, a } = fixture();
  const [made] = createNodes(doc, [{ type: "layer" }]).nodes as [Node];
  const hidden = { ...made, visible: false } as Node;
  doc.nodes.set(hidden.id, hidden);
  const state = viewState({
    doc,
    selection: [a.id],
    pending: [{ commandId: "c1", nodes: [], select: true }],
  });
  // A nested Layer's copy in the hidden Layer, as Duplicate or an Alt-drag onto it makes.
  const layer = { ...a, id: "L", type: "layer", parentId: hidden.id } as unknown as Node;
  const art = { ...a, id: "x", parentId: "L" } as Node;
  expect(
    stateAfter(state, tx(doc, { actor: "user", created: [layer, art], commandId: "c1" })),
  ).toMatchObject({ selection: [], layerRows: ["L"] });
});

it("selects an own Shape Mode's result path; an Agent's same tx leaves the Selection empty", () => {
  const { doc, a, b } = fixture();
  const state = viewState({
    doc,
    selection: [a.id, b.id],
    pending: [{ commandId: "c1", nodes: [], select: true }],
  });
  const path = { ...a, id: "p", type: "path" } as unknown as Node;
  const shape = { created: [path], deletedIds: [a.id, b.id] };
  expect(stateAfter(state, tx(doc, { ...shape, actor: "user", commandId: "c1" }))).toMatchObject({
    selection: ["p"],
    pending: [],
  });
  expect(stateAfter(state, tx(doc, shape))).toMatchObject({ selection: [] });
});

it("keeps keys after the person's own command that leaves a Node's geometry, and clears them after its reshape or another tab's (#288)", () => {
  const { doc, a, b } = fixture();
  const anchors = [anchorKey(a.id, 0, 1), anchorKey(b.id, 0, 1)];
  const segments = [anchorKey(a.id, 0, 2)];
  const state = viewState({
    doc,
    selection: [a.id, b.id],
    anchors,
    segments,
    sent: new Set(["c9"]),
  });
  const after = (n: Node, commandId?: string) =>
    stateAfter(state, tx(doc, { ...(commandId && { commandId }), updated: [n] }));
  // Paint, fill rule, visibility, lock, stacking or parent: the same Anchors, so they stay.
  const unchanged: Node[] = [
    { ...a, opacity: 0.5 },
    { ...a, fillRule: "evenodd" } as Node,
    { ...a, visible: false },
    { ...a, locked: true },
    { ...a, transform: [1, 0, 0, 1, 5, 5] },
  ];
  for (const n of unchanged) {
    expect(after(n, "c9"), JSON.stringify(n)).toMatchObject({ anchors, segments });
    // The same Transaction from a command this tab never sent, another tab's, is another Actor's.
    expect(after(n, "c8")).toMatchObject({ anchors: [anchorKey(b.id, 0, 1)], segments: [] });
    expect(after(n)).toMatchObject({ anchors: [anchorKey(b.id, 0, 1)], segments: [] });
  }
  // A reshape the browser did not work out, such as an Undo's, clears a's keys though in range.
  const reshaped = { ...a, width: 20 } as Node;
  expect(after(reshaped, "c9")).toMatchObject({ anchors: [anchorKey(b.id, 0, 1)], segments: [] });
  const path = { ...a, type: "path", d: "M 0 0 L 10 0 L 10 10 L 0 10 Z", fillRule: "nonzero" };
  expect(after(path as Node, "c9")).toMatchObject({ anchors: [anchorKey(b.id, 0, 1)] });
  // Deleted, they go.
  expect(stateAfter(state, tx(doc, { commandId: "c9", deletedIds: [a.id] }))?.anchors).toEqual([
    anchorKey(b.id, 0, 1),
  ]);
});

it("records a command until its tx or rejection answers it, and forgets every one on a Document (#288)", () => {
  const { doc, a } = fixture();
  const anchors = [anchorKey(a.id, 0, 1)];
  const state = viewState({ doc, selection: [a.id], anchors, sent: new Set(["c1", "c2"]) });
  const answered = stateAfter(state, tx(doc, { commandId: "c1", updated: [a] }));
  expect(answered?.sent).toEqual(new Set(["c2"]));
  // A rejection forgets its id and changes no key.
  const rejected = stateAfter(state, message("rejected", { id: "c2" }));
  expect(rejected?.sent).toEqual(new Set(["c1"]));
  expect(rejected?.anchors).toBeUndefined();
  expect(stateAfter(state, message("document", { rev: 3 }))?.sent).toEqual(new Set());
  // Another Actor's tx leaves the record as it is.
  expect(stateAfter(state, tx(doc, { commandId: "x", updated: [a] }))?.sent).toBeUndefined();
});
