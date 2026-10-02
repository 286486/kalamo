import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { imageId, LEGACY_NAME, MIGRATIONS, readImage } from "@kalamo/core";
import type { ServerMessage } from "@kalamo/sync";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../../../fixtures/documents/inkscape.kalamo.json?raw";
import {
  BLUE_1x1_PNG,
  GREY_5x4_GIF,
  RED_2x2_PNG,
  RGB_3x2_PNG,
  WEBP_4x3_RGBA,
  WEBP_ALPHA_4x3,
  WEBP_ALPHA_4x3_RGBA,
  WEBP_ANIMATED,
  WEBP_LOSSLESS_4x3,
  WEBP_OVER_CAP,
  WEBP_TRUNCATED,
} from "../../../fixtures/images.ts";
import { counted, fullKalamoFile, MiB } from "./bodies.ts";
import { call, errorOf } from "./rpc.ts";
import { servedPng } from "./served.ts";

const open: WebSocket[] = [];

afterEach(() => {
  for (const ws of open.splice(0)) ws.close();
});

const upgrade = (docId: string) =>
  exports.default.fetch(`http://kalamo/api/docs/${docId}/ws`, {
    headers: { upgrade: "websocket" },
  });

/** Opens a browser socket and collects every message it receives. */
async function subscribe(docId: string) {
  const res = await upgrade(docId);
  const ws = res.webSocket;
  if (!ws) throw new Error(`no WebSocket: ${res.status}`);
  const messages: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  ws.addEventListener("message", (e) => {
    messages.push(JSON.parse(e.data as string));
    for (const w of waiters.splice(0)) w();
  });
  ws.accept();
  open.push(ws);
  /** Resolves once `n` messages have arrived. */
  const received = async (n: number) => {
    while (messages.length < n) await new Promise<void>((r) => waiters.push(r));
    return messages;
  };
  return { ws, messages, received };
}

const newDoc = async () =>
  (await call("kalamo_doc_create", { name: "Doc", artboards: [{ width: 200, height: 100 }] }))
    .structuredContent;

const rect = (parentId: string) => ({
  type: "rect",
  parentId,
  x: 10,
  y: 10,
  width: 50,
  height: 30,
});

it("answers 404 before the upgrade for an unknown docId", async () => {
  const res = await upgrade("01NOPE");
  expect(res.status).toBe(404);
  expect(res.webSocket).toBeNull();
});

it("sends the Document on connect, then a tx after node_create commits", async () => {
  const { docId, defaultLayerId, artboards } = await newDoc();
  const { received } = await subscribe(docId);

  const [first] = await received(1);
  expect(first).toMatchObject({ type: "document", rev: 1, name: "Doc", artboards });
  expect(first?.type === "document" && first.nodes.map((n) => n.id)).toEqual([defaultLayerId]);

  const receipt = (
    await call("kalamo_node_create", { docId, nodes: [rect(defaultLayerId)], intent: "A box" })
  ).structuredContent;
  const [, tx] = await received(2);
  expect(tx).toMatchObject({
    type: "tx",
    rev: 2,
    txId: receipt.txId,
    actor: "agent-a",
    intent: "A box",
    updated: [],
    deletedIds: [],
    bounds: receipt.bounds,
  });
  expect(receipt.bounds).toEqual({ x: 10, y: 10, width: 50, height: 30 });
  expect(tx?.type === "tx" && tx.created).toMatchObject([
    { id: receipt.createdIds[0], type: "rect", width: 50 },
  ]);
});

it("counts open sockets in doc_get_info, and drops one the browser closes", async () => {
  const { docId } = await newDoc();
  const { ws, received } = await subscribe(docId);
  await received(1);
  const browsers = async () =>
    (await call("kalamo_doc_get_info", { docId })).structuredContent.browsers;
  expect(await browsers()).toBe(1);

  const closed = new Promise((r) => ws.addEventListener("close", r));
  ws.close();
  await closed;
  await vi.waitFor(async () => expect(await browsers()).toBe(0), { timeout: 1000 });
});

it("broadcasts a staged write's area, not its Nodes, then the Transaction once at tx_commit (ADR-0090)", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const { messages, received } = await subscribe(docId);
  await received(1);
  const { txId } = (await call("kalamo_tx_begin", { docId })).structuredContent;
  const staged = (
    await call("kalamo_node_create", { docId, txId, nodes: [rect(defaultLayerId)], intent: "Box" })
  ).structuredContent;
  const [, area] = await received(2);
  expect(area).toEqual({
    type: "staged",
    txId,
    actor: "agent-a",
    intent: "Box",
    bounds: { x: 10, y: 10, width: 50, height: 30 },
  });

  const commit = (await call("kalamo_tx_commit", { docId, txId })).structuredContent;
  const [, , tx] = await received(3);
  expect(tx).toMatchObject({ type: "tx", rev: 2, txId, updated: [], deletedIds: [] });
  expect(tx?.type === "tx" && tx.created.map((n) => n.id)).toEqual(staged.createdIds);
  expect(tx?.type === "tx" && tx.bounds).toEqual(commit.bounds);
  expect(commit.bounds).toEqual({ x: 10, y: 10, width: 50, height: 30 });
  expect(messages).toHaveLength(3);
});

it("broadcasts nothing more for a Transaction rolled back", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const { received } = await subscribe(docId);
  await received(1);
  const { txId } = (await call("kalamo_tx_begin", { docId })).structuredContent;
  await call("kalamo_node_create", { docId, txId, nodes: [rect(defaultLayerId)] });
  await received(2);
  await call("kalamo_tx_rollback", { docId, txId });
  const { txId: later } = (
    await call("kalamo_node_create", { docId, nodes: [rect(defaultLayerId)] })
  ).structuredContent;
  const [, , next] = await received(3);
  expect(next).toMatchObject({ type: "tx", txId: later });
});

it("lists Documents newest first at GET /api/docs", async () => {
  const a = await call("kalamo_doc_create", {
    name: "First",
    artboards: [{ width: 10, height: 10 }],
  });
  const b = await call("kalamo_doc_create", {
    name: "Second",
    artboards: [{ width: 10, height: 10 }],
  });
  const res = await exports.default.fetch("http://kalamo/api/docs");
  expect(res.status).toBe(200);
  const { documents } = (await res.json()) as { documents: { docId: string; name: string }[] };
  expect(documents.slice(0, 2)).toMatchObject([
    { docId: b.structuredContent.docId, name: "Second", createdAt: expect.any(String) },
    { docId: a.structuredContent.docId, name: "First", createdAt: expect.any(String) },
  ]);
});

/** A browser gesture as ADR-0010 sends it. */
const command = (id: string, command: unknown) => JSON.stringify({ type: "command", id, command });

it("commits a transform command as one Transaction of the User Actor, seen by doc_changes", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const { createdIds, rev } = (
    await call("kalamo_node_create", { docId, nodes: [rect(defaultLayerId)] })
  ).structuredContent;
  const [id] = createdIds;
  const { ws, received } = await subscribe(docId);
  await received(1);

  ws.send(
    command("c1", { type: "transform", input: { nodeIds: [id], translate: { x: 5, y: 7 } } }),
  );
  const [, tx] = await received(2);
  expect(tx).toMatchObject({
    type: "tx",
    rev: rev + 1,
    actor: "user",
    commandId: "c1",
    intent: null,
    created: [],
    deletedIds: [],
  });
  expect(tx?.type === "tx" && tx.updated).toMatchObject([{ id, transform: [1, 0, 0, 1, 5, 7] }]);

  const { changes } = (await call("kalamo_doc_changes", { docId, sinceRev: rev }))
    .structuredContent;
  expect(changes).toMatchObject([
    { rev: rev + 1, actor: "user", summary: "Transform 1 Node", updatedIds: [id] },
  ]);
  expect(changes).toHaveLength(1);
  const { nodes } = (await call("kalamo_node_get", { docId, nodeIds: [id] })).structuredContent;
  expect(nodes[0].geometricBounds).toMatchObject({ x: 15, y: 17 });
});

it("commits a delete command and broadcasts the deleted ids", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const [id] = (await call("kalamo_node_create", { docId, nodes: [rect(defaultLayerId)] }))
    .structuredContent.createdIds;
  const { ws, received } = await subscribe(docId);
  await received(1);

  ws.send(command("c2", { type: "delete", nodeIds: [id] }));
  const [, tx] = await received(2);
  expect(tx).toMatchObject({ type: "tx", actor: "user", commandId: "c2", deletedIds: [id] });
});

it("commits an update command that hides a Node as one Transaction of the User Actor", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const { createdIds, rev } = (
    await call("kalamo_node_create", { docId, nodes: [rect(defaultLayerId)] })
  ).structuredContent;
  const [id] = createdIds;
  const { ws, received } = await subscribe(docId);
  await received(1);

  ws.send(command("c4", { type: "update", nodeId: id, patch: { visible: false } }));
  const [, tx] = await received(2);
  expect(tx).toMatchObject({ type: "tx", actor: "user", commandId: "c4" });
  expect(tx?.type === "tx" && tx.updated).toMatchObject([{ id, visible: false, locked: false }]);
  const { nodes } = (await call("kalamo_node_get", { docId, nodeIds: [id] })).structuredContent;
  expect(nodes[0]).toMatchObject({ visible: false });
  const { changes } = (await call("kalamo_doc_changes", { docId, sinceRev: rev }))
    .structuredContent;
  expect(changes).toMatchObject([{ actor: "user", summary: "Update 1 Node", updatedIds: [id] }]);
});

it("commits an appearance command for every browser, and closes on one the Appearance schema refuses (ADR-0081)", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const { createdIds, rev } = (
    await call("kalamo_node_create", { docId, nodes: [rect(defaultLayerId), rect(defaultLayerId)] })
  ).structuredContent;
  const stops = [
    { offset: 0, color: "#000000", midpoint: 0.3 },
    { offset: 1, color: "#FFFFFF" },
  ];
  const fills = [{ type: "gradient", gradient: { type: "linear", stops } }];
  const other = await subscribe(docId);
  await other.received(1);
  const { ws, received } = await subscribe(docId);
  await received(1);
  const updates = createdIds.map((nodeId: string) => ({ nodeId, appearance: { fills } }));
  ws.send(command("c9", { type: "appearance", updates }));
  // The other browser gets the same Transaction, after hearing this one joined.
  const [, , tx] = await other.received(3);
  expect(tx).toMatchObject({ type: "tx", actor: "user", commandId: "c9", rev: rev + 1 });
  expect(tx?.type === "tx" && tx.updated.map((n) => n.id)).toEqual(createdIds);
  expect(
    tx?.type === "tx" && tx.updated.map((n) => ("appearance" in n ? n.appearance?.fills : [])),
  ).toMatchObject([[{ gradient: { stops } }], [{ gradient: { stops } }]]);
  // A midpoint on the stop that sorts last is malformed: the socket closes and nothing commits.
  const late = [
    { ...stops[1], offset: 0 },
    { ...stops[0], offset: 1 },
  ];
  const closed = new Promise<CloseEvent>((r) => ws.addEventListener("close", r));
  ws.send(
    command("c10", {
      type: "appearance",
      updates: [
        {
          nodeId: createdIds[0],
          appearance: { fills: [{ type: "gradient", gradient: { type: "linear", stops: late } }] },
        },
      ],
    }),
  );
  expect((await closed).code).toBe(1007);
  const { changes } = (await call("kalamo_doc_changes", { docId, sinceRev: rev }))
    .structuredContent;
  expect(changes).toHaveLength(1);
});

it("closes the socket with 1007 on an update patch other than visible or locked", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const [id] = (await call("kalamo_node_create", { docId, nodes: [rect(defaultLayerId)] }))
    .structuredContent.createdIds;
  for (const patch of [{}, { name: "x" }]) {
    const { ws, received } = await subscribe(docId);
    await received(1);
    const closed = new Promise<CloseEvent>((r) => ws.addEventListener("close", r));
    ws.send(command("c5", { type: "update", nodeId: id, patch }));
    expect((await closed).code).toBe(1007);
  }
});

it("rejects a move of a Node deleted meanwhile with NODE_GONE, and commits nothing", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const [id, kept] = (
    await call("kalamo_node_create", { docId, nodes: [rect(defaultLayerId), rect(defaultLayerId)] })
  ).structuredContent.createdIds;
  const { ws, received } = await subscribe(docId);
  await received(1);
  const { rev } = (await call("kalamo_node_delete", { docId, nodeIds: [id] })).structuredContent;
  await received(2);

  ws.send(
    command("c3", { type: "transform", input: { nodeIds: [kept, id], translate: { x: 1 } } }),
  );
  const [, , rejected] = await received(3);
  expect(rejected).toMatchObject({
    type: "rejected",
    id: "c3",
    error: { code: "NODE_GONE", nodeIds: [id] },
  });
  expect((await call("kalamo_doc_get_info", { docId })).structuredContent.rev).toBe(rev);
});

it("makes a Clipping Mask from a mask_make command and releases it with mask_release", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const [art, clip] = (
    await call("kalamo_node_create", { docId, nodes: [rect(defaultLayerId), rect(defaultLayerId)] })
  ).structuredContent.createdIds;
  const { ws, received } = await subscribe(docId);
  await received(1);

  ws.send(command("m1", { type: "mask_make", input: { clipNodeId: clip, contentIds: [art] } }));
  const [, made] = await received(2);
  expect(made).toMatchObject({ type: "tx", actor: "user", commandId: "m1" });
  const group = made?.type === "tx" ? made.created[0] : undefined;
  expect(group).toMatchObject({ type: "group", parentId: defaultLayerId });
  expect(made?.type === "tx" && made.updated).toContainEqual(
    expect.objectContaining({ id: clip, parentId: group?.id, clipping: true }),
  );

  ws.send(command("m2", { type: "mask_release", nodeIds: [group?.id] }));
  const [, , released] = await received(3);
  expect(released).toMatchObject({ type: "tx", actor: "user", commandId: "m2" });
  expect(released?.type === "tx" && released.updated[0]).toMatchObject({ id: clip });
  expect(released?.type === "tx" && released.updated[0]).not.toHaveProperty("clipping");
});

it("commits a create command as the User Actor, which doc_changes shows", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const { ws, received } = await subscribe(docId);
  const [doc] = await received(1);
  const path = { type: "path", parentId: defaultLayerId, d: "M 0 0 L 10 0 L 5 5 Z" };
  ws.send(command("n1", { type: "create", nodes: [path] }));
  const [, created] = await received(2);
  expect(created).toMatchObject({ type: "tx", actor: "user", commandId: "n1" });
  const id = created?.type === "tx" && created.created[0]?.id;
  expect(created?.type === "tx" && created.created[0]).toMatchObject(path);
  const { changes } = (
    await call("kalamo_doc_changes", { docId, sinceRev: doc?.type === "document" ? doc.rev : 0 })
  ).structuredContent;
  expect(changes).toMatchObject([{ actor: "user", createdIds: [id] }]);
});

it("rejects a create into a Layer deleted meanwhile with NODE_GONE", async () => {
  const { docId } = await newDoc();
  const [layer] = (await call("kalamo_node_create", { docId, nodes: [{ type: "layer" }] }))
    .structuredContent.createdIds;
  const { ws, received } = await subscribe(docId);
  await received(1);
  await call("kalamo_node_delete", { docId, nodeIds: [layer] });
  await received(2);
  ws.send(command("n1", { type: "create", nodes: [rect(layer)] }));
  const [, , rejected] = await received(3);
  expect(rejected).toMatchObject({ type: "rejected", id: "n1", error: { code: "NODE_GONE" } });
});

it("commits a path_edit command as the User Actor", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const [id] = (
    await call("kalamo_node_create", {
      docId,
      nodes: [{ type: "path", parentId: defaultLayerId, d: "M 0 0 L 10 0" }],
    })
  ).structuredContent.createdIds;
  const { ws, received } = await subscribe(docId);
  await received(1);
  ws.send(
    command("p1", {
      type: "path_edit",
      input: { nodeId: id, ops: [{ op: "move_anchor", index: 1, to: [20, 5] }] },
    }),
  );
  const [, edited] = await received(2);
  expect(edited).toMatchObject({ type: "tx", actor: "user", commandId: "p1" });
  expect(edited?.type === "tx" && edited.updated[0]).toMatchObject({ id, d: "M 0 0 L 20 5" });
});

it("commits a path_join command as one Transaction that leaves one path", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const [a, b] = (
    await call("kalamo_node_create", {
      docId,
      nodes: [
        { type: "path", parentId: defaultLayerId, d: "M 0 0 L 10 0" },
        { type: "path", parentId: defaultLayerId, d: "M 30 0 L 40 0" },
      ],
    })
  ).structuredContent.createdIds;
  const { ws, received } = await subscribe(docId);
  await received(1);
  ws.send(
    command("j1", {
      type: "path_join",
      edit: { nodeId: a, ops: [{ op: "set_d", d: "M 0 0 L 10 0 L 20 5 L 30 0" }] },
      join: {
        nodeIds: [a, b],
        op: "join",
        anchors: [
          { nodeId: a, subpath: 0, index: 3 },
          { nodeId: b, subpath: 0, index: 0 },
        ],
      },
    }),
  );
  const [, joined] = await received(2);
  expect(joined).toMatchObject({ type: "tx", actor: "user", commandId: "j1", deletedIds: [a] });
  expect(joined?.type === "tx" && joined.updated).toMatchObject([
    { id: b, d: "M 0 0 L 10 0 L 20 5 L 30 0 L 40 0" },
  ]);
});

it("converts a rect with a path_op command, and undo brings the rect back without d", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const [id] = (await call("kalamo_node_create", { docId, nodes: [rect(defaultLayerId)] }))
    .structuredContent.createdIds;
  const { ws, received } = await subscribe(docId);
  await received(1);
  ws.send(command("c1", { type: "path_op", input: { nodeIds: [id], op: "convert_to_path" } }));
  const [, converted] = await received(2);
  expect(converted).toMatchObject({ type: "tx", actor: "user", commandId: "c1" });
  expect(converted?.type === "tx" && converted.updated[0]).toMatchObject({ id, type: "path" });
  ws.send(command("u1", { type: "undo" }));
  const [, , undone] = await received(3);
  const back = undone?.type === "tx" && undone.updated[0];
  expect(back).toMatchObject({ id, ...rect(defaultLayerId) });
  expect(back).not.toHaveProperty("d");
  expect(back).not.toHaveProperty("fillRule");
});

it("outlines a Stroke with a path_op command, and one undo takes the Group away", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const [id] = (await call("kalamo_node_create", { docId, nodes: [rect(defaultLayerId)] }))
    .structuredContent.createdIds;
  const { ws, received } = await subscribe(docId);
  await received(1);
  ws.send(command("o1", { type: "path_op", input: { nodeIds: [id], op: "outline_stroke" } }));
  const [, outlined] = await received(2);
  expect(outlined).toMatchObject({ type: "tx", actor: "user", commandId: "o1" });
  const tx = outlined?.type === "tx" ? outlined : undefined;
  const [group, stroke] = tx?.created ?? [];
  expect(group).toMatchObject({ type: "group", parentId: defaultLayerId });
  expect(stroke).toMatchObject({ type: "path", parentId: group?.id });
  expect(tx?.updated).toMatchObject([{ id, type: "path", parentId: group?.id }]);
  ws.send(command("u1", { type: "undo" }));
  const [, , undone] = await received(3);
  expect(undone?.type === "tx" && [...undone.deletedIds].sort()).toEqual(
    [group?.id, stroke?.id].sort(),
  );
  expect(undone?.type === "tx" && undone.updated[0]).toMatchObject({ id, ...rect(defaultLayerId) });
});

it("rejects a mask_make naming a Node deleted meanwhile with NODE_GONE", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const [art, clip] = (
    await call("kalamo_node_create", { docId, nodes: [rect(defaultLayerId), rect(defaultLayerId)] })
  ).structuredContent.createdIds;
  const { ws, received } = await subscribe(docId);
  await received(1);
  await call("kalamo_node_delete", { docId, nodeIds: [art] });
  await received(2);

  ws.send(command("m3", { type: "mask_make", input: { clipNodeId: clip, contentIds: [art] } }));
  const [, , rejected] = await received(3);
  expect(rejected).toMatchObject({ type: "rejected", id: "m3", error: { code: "NODE_GONE" } });
});

it("moves Nodes from a reparent command as the User Actor, and rejects one naming a deleted anchor or breaking a tree rule (ADR-0075)", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const [a, b, group] = (
    await call("kalamo_node_create", {
      docId,
      nodes: [
        rect(defaultLayerId),
        rect(defaultLayerId),
        { type: "group", parentId: defaultLayerId },
      ],
    })
  ).structuredContent.createdIds;
  const { ws, received } = await subscribe(docId);
  await received(1);

  const moves = [
    { nodeId: b, parentId: group },
    { nodeId: a, parentId: group, before: b },
  ];
  ws.send(command("r1", { type: "reparent", moves }));
  const [, moved] = await received(2);
  expect(moved).toMatchObject({ type: "tx", actor: "user", commandId: "r1" });
  // b on top of the Group, a directly below it.
  const { nodes } = (await call("kalamo_node_get", { docId, nodeIds: [a, b], detail: "full" }))
    .structuredContent;
  expect(nodes.map((n: { parentId: string }) => n.parentId)).toEqual([group, group]);
  expect(nodes[0].index < nodes[1].index).toBe(true);

  await call("kalamo_node_delete", { docId, nodeIds: [b] });
  await received(3);
  ws.send(command("r2", { type: "reparent", moves: [{ nodeId: a, parentId: group, after: b }] }));
  const [, , , gone] = await received(4);
  expect(gone).toMatchObject({
    type: "rejected",
    id: "r2",
    error: { code: "NODE_GONE", nodeIds: [b] },
  });

  ws.send(
    command("r3", { type: "reparent", moves: [{ nodeId: defaultLayerId, parentId: group }] }),
  );
  const [, , , , refused] = await received(5);
  expect(refused).toMatchObject({ type: "rejected", id: "r3", error: { code: "INVALID_PARENT" } });
});

it("copies Nodes from a duplicate command as the User Actor, and rejects one naming a deleted Node (ADR-0076)", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const [a, b] = (
    await call("kalamo_node_create", { docId, nodes: [rect(defaultLayerId), rect(defaultLayerId)] })
  ).structuredContent.createdIds;
  const { ws, received } = await subscribe(docId);
  await received(1);
  const input = {
    nodeIds: [b, a],
    offset: { x: 5, y: 0 },
    targetParentId: defaultLayerId,
    after: b,
  };
  ws.send(command("d1", { type: "duplicate", input }));
  const [, copied] = await received(2);
  expect(copied).toMatchObject({ type: "tx", actor: "user", commandId: "d1", updated: [] });
  const created = (copied as { created: { id: string; parentId: string }[] }).created;
  expect(created).toHaveLength(2);
  const { nodes } = (await call("kalamo_doc_outline", { docId, depth: 2 })).structuredContent;
  expect(nodes[0].children.map((n: { id: string }) => n.id)).toEqual([
    a,
    b,
    ...created.map((n) => n.id),
  ]);

  await call("kalamo_node_delete", { docId, nodeIds: [b] });
  await received(3);
  ws.send(command("d2", { type: "duplicate", input: { ...input, nodeIds: [a] } }));
  const [, , , gone] = await received(4);
  expect(gone).toMatchObject({
    type: "rejected",
    id: "d2",
    error: { code: "NODE_GONE", nodeIds: [b] },
  });
});

it("rejects a reparent command whose moved Node or parent was deleted meanwhile with NODE_GONE", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const [a, b, group] = (
    await call("kalamo_node_create", {
      docId,
      nodes: [
        rect(defaultLayerId),
        rect(defaultLayerId),
        { type: "group", parentId: defaultLayerId },
      ],
    })
  ).structuredContent.createdIds;
  await call("kalamo_node_delete", { docId, nodeIds: [a, group] });
  const { ws, received } = await subscribe(docId);
  await received(1);
  ws.send(command("r1", { type: "reparent", moves: [{ nodeId: a, parentId: defaultLayerId }] }));
  ws.send(command("r2", { type: "reparent", moves: [{ nodeId: b, parentId: group }] }));
  const [, moved, parent] = await received(3);
  expect(moved).toMatchObject({ id: "r1", error: { code: "NODE_GONE", nodeIds: [a] } });
  expect(parent).toMatchObject({ id: "r2", error: { code: "NODE_GONE", nodeIds: [group] } });
});

it("rejects a delete command naming the last top-level Layer with LAST_LAYER, changing nothing (ADR-0073)", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const [id] = (await call("kalamo_node_create", { docId, nodes: [rect(defaultLayerId)] }))
    .structuredContent.createdIds;
  const { rev } = (await call("kalamo_doc_get_info", { docId })).structuredContent;
  const { ws, received } = await subscribe(docId);
  await received(1);
  ws.send(command("d1", { type: "delete", nodeIds: [id, defaultLayerId] }));
  const [, rejected] = await received(2);
  expect(rejected).toMatchObject({
    type: "rejected",
    id: "d1",
    error: { code: "LAST_LAYER", nodeIds: [defaultLayerId] },
  });
  const { nodes } = (await call("kalamo_node_get", { docId, nodeIds: [id] })).structuredContent;
  expect(nodes).toHaveLength(1);
  expect((await call("kalamo_doc_get_info", { docId })).structuredContent.rev).toBe(rev);
  // The next write's tx is the next message and takes the next rev: the rejection broadcast none.
  await call("kalamo_node_create", { docId, nodes: [rect(defaultLayerId)] });
  const messages = await received(3);
  expect(messages).toHaveLength(3);
  expect(messages[2]).toMatchObject({ type: "tx", rev: rev + 1 });
  const text = (await call("kalamo_export", { docId, format: "kalamo_json" })).content[0].text;
  expect(errorOf(await call("kalamo_doc_open", { content: text }))).toBeNull();
});

it("skips an undo that would remove the last top-level Layer, in the broadcast and doc_changes (ADR-0073)", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const { createdIds, rev } = (
    await call("kalamo_node_create", { docId, nodes: [{ type: "layer" }] })
  ).structuredContent;
  const [layer] = createdIds;
  // A delete of the first Layer that is not on the undo stack, as another Actor's would be with
  // per-Actor undo (ADR-0011); a linear stack cannot reach this yet.
  await runInDurableObject(env.DOCUMENT.get(env.DOCUMENT.idFromName(docId)), (_, state) => {
    state.storage.sql.exec("DELETE FROM nodes WHERE id = ?", defaultLayerId);
  });
  const { ws, received } = await subscribe(docId);
  await received(1);
  ws.send(command("u1", { type: "undo" }));
  const [, undo] = await received(2);
  expect(undo).toMatchObject({ type: "tx", deletedIds: [], skippedIds: [layer] });
  const { changes } = (await call("kalamo_doc_changes", { docId, sinceRev: rev }))
    .structuredContent;
  expect(changes[0].summary).toContain(`skipped, deleted or moved since: ${layer}`);
  const text = (await call("kalamo_export", { docId, format: "kalamo_json" })).content[0].text;
  expect(errorOf(await call("kalamo_doc_open", { content: text }))).toBeNull();
});

it("closes the socket with 1007 on a message that is not a command", async () => {
  const { docId } = await newDoc();
  for (const data of ["nope", JSON.stringify({ type: "command" })]) {
    const { ws, received } = await subscribe(docId);
    await received(1);
    const closed = new Promise<CloseEvent>((r) => ws.addEventListener("close", r));
    ws.send(data);
    expect((await closed).code).toBe(1007);
  }
});

describe("presence (ADR-0090)", () => {
  const presence = (cursor: unknown, selection?: unknown) =>
    JSON.stringify({ type: "presence", cursor, selection });
  const closeOf = (ws: WebSocket) =>
    new Promise<CloseEvent>((r) => ws.addEventListener("close", r));

  it("relays a presence to the other sockets with its Peer and Actor, storing nothing", async () => {
    const { docId } = await newDoc();
    const a = await subscribe(docId);
    await a.received(1);
    const b = await subscribe(docId);
    const [doc] = await b.received(1);
    const [, joined] = await a.received(2);
    if (doc?.type !== "document" || joined?.type !== "joined") throw new Error("no peers");
    expect(doc.peers).toEqual([{ peer: expect.any(String), actor: "user" }]);
    const peerA = doc.peers[0]?.peer;
    expect(joined).toEqual({ type: "joined", peer: expect.any(String), actor: "user" });
    expect(joined.peer).not.toBe(peerA);

    a.ws.send(presence({ x: 1.5, y: -2 }, ["n1"]));
    expect((await b.received(2))[1]).toEqual({
      type: "presence",
      peer: peerA,
      actor: "user",
      cursor: { x: 1.5, y: -2 },
      selection: ["n1"],
    });
    // A gets B's presence next, not an echo of its own.
    b.ws.send(presence(null));
    expect((await a.received(3))[2]).toEqual({
      type: "presence",
      peer: joined.peer,
      actor: "user",
      cursor: null,
    });
    expect((await call("kalamo_doc_get_info", { docId })).structuredContent.rev).toBe(1);
  });

  it("lists the open sockets to a third, tells them it joined, and that it left", async () => {
    const { docId } = await newDoc();
    const a = await subscribe(docId);
    await a.received(1);
    const b = await subscribe(docId);
    await b.received(1);
    const [, joinedB] = await a.received(2);
    const c = await subscribe(docId);
    const [doc] = await c.received(1);
    const [, joinedC] = await b.received(2);
    expect((await a.received(3))[2]).toEqual(joinedC);
    if (doc?.type !== "document" || joinedB?.type !== "joined" || joinedC?.type !== "joined") {
      throw new Error("no peers");
    }
    expect(doc.peers).toHaveLength(2);
    expect(doc.peers).toContainEqual({ peer: joinedB.peer, actor: "user" });

    c.ws.close();
    const left = { type: "left", peer: joinedC.peer };
    expect((await a.received(4))[3]).toEqual(left);
    expect((await b.received(3))[2]).toEqual(left);
  });

  it("closes with 1007 on a presence with 1 001 ids or a non-finite cursor, sending left", async () => {
    const { docId } = await newDoc();
    const a = await subscribe(docId);
    await a.received(1);
    const bad = [
      presence(
        { x: 0, y: 0 },
        Array.from({ length: 1001 }, (_, i) => `n${i}`),
      ),
      presence({ x: 0, y: 0 }, ["x".repeat(65)]),
      '{"type":"presence","cursor":{"x":1e999,"y":0}}',
      presence({ x: 0 }),
    ];
    for (const [i, data] of bad.entries()) {
      const b = await subscribe(docId);
      await b.received(1);
      const joined = (await a.received(2 + 2 * i))[1 + 2 * i];
      const closed = closeOf(b.ws);
      b.ws.send(data);
      expect((await closed).code).toBe(1007);
      expect((await a.received(3 + 2 * i))[2 + 2 * i]).toEqual({
        type: "left",
        peer: joined?.type === "joined" && joined.peer,
      });
    }
    expect(a.messages).toHaveLength(1 + 2 * bad.length);
  });

  it("closes with 1012 a socket attached before it had a Peer, so the browser reconnects", async () => {
    const { docId } = await newDoc();
    const { ws, received } = await subscribe(docId);
    await received(1);
    await runInDurableObject(env.DOCUMENT.get(env.DOCUMENT.idFromName(docId)), (_, state) => {
      for (const s of state.getWebSockets()) {
        s.serializeAttachment({ actor: "user", userId: "local", role: "owner" });
      }
    });
    const closed = closeOf(ws);
    ws.send(presence(null));
    expect((await closed).code).toBe(1012);
  });
});

it("undoes an Agent's three-call Transaction with one undo command, and redoes it", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const { txId } = (await call("kalamo_tx_begin", { docId })).structuredContent;
  const [id] = (await call("kalamo_node_create", { docId, txId, nodes: [rect(defaultLayerId)] }))
    .structuredContent.createdIds;
  await call("kalamo_node_update", {
    docId,
    txId,
    updates: [{ nodeId: id, patch: { name: "Box" } }],
  });
  await call("kalamo_node_transform", { docId, txId, nodeIds: [id], translate: { x: 20 } });
  const { rev } = (await call("kalamo_tx_commit", { docId, txId })).structuredContent;
  const { ws, received } = await subscribe(docId);
  await received(1);

  ws.send(command("u1", { type: "undo" }));
  const [, undo] = await received(2);
  expect(undo).toMatchObject({
    type: "tx",
    rev: rev + 1,
    actor: "user",
    commandId: "u1",
    deletedIds: [id],
  });
  expect(undo).not.toHaveProperty("skippedIds");
  expect(errorOf(await call("kalamo_node_get", { docId, nodeIds: [id] }))).toMatchObject({
    code: "NODE_NOT_FOUND",
  });

  ws.send(command("r1", { type: "redo" }));
  const [, , redo] = await received(3);
  expect(redo).toMatchObject({
    type: "tx",
    actor: "user",
    commandId: "r1",
    created: [{ id, name: "Box" }],
  });
  const { nodes } = (await call("kalamo_node_get", { docId, nodeIds: [id] })).structuredContent;
  expect(nodes[0].geometricBounds).toMatchObject({ x: 30, y: 10 });

  const { changes } = (await call("kalamo_doc_changes", { docId, sinceRev: rev }))
    .structuredContent;
  expect(changes.map((c: { actor: string; summary: string }) => [c.actor, c.summary])).toEqual([
    ["user", 'Undo "Commit 1 Node"'],
    ["user", 'Redo "Commit 1 Node"'],
  ]);
});

it("undoes a later delete first: the Node comes back with its id, then its update is undone", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const [id] = (await call("kalamo_node_create", { docId, nodes: [rect(defaultLayerId)] }))
    .structuredContent.createdIds;
  await call("kalamo_node_update", { docId, updates: [{ nodeId: id, patch: { name: "Box" } }] });
  await call("kalamo_node_delete", { docId, nodeIds: [id] });
  const { ws, received } = await subscribe(docId);
  await received(1);

  ws.send(command("u1", { type: "undo" }));
  const [, first] = await received(2);
  expect(first).toMatchObject({ created: [{ id, name: "Box" }] });
  ws.send(command("u2", { type: "undo" }));
  const [, , second] = await received(3);
  expect(second).toMatchObject({ updated: [{ id, name: "" }] });
  expect(second).not.toHaveProperty("skippedIds");
});

it("rejects undo and redo with nothing on the stack, changing nothing", async () => {
  const { docId } = await newDoc();
  const { ws, received } = await subscribe(docId);
  await received(1);
  ws.send(command("u1", { type: "undo" }));
  ws.send(command("r1", { type: "redo" }));
  const [, undo, redo] = await received(3);
  expect(undo).toMatchObject({ type: "rejected", id: "u1", error: { code: "NOTHING_TO_UNDO" } });
  expect(redo).toMatchObject({ type: "rejected", id: "r1", error: { code: "NOTHING_TO_REDO" } });
  expect((await call("kalamo_doc_get_info", { docId })).structuredContent.rev).toBe(1);
});

it("clears the redo stack when a new Transaction commits", async () => {
  const { docId, defaultLayerId } = await newDoc();
  await call("kalamo_node_create", { docId, nodes: [rect(defaultLayerId)] });
  const { ws, received } = await subscribe(docId);
  await received(1);
  ws.send(command("u1", { type: "undo" }));
  await received(2);
  await call("kalamo_node_create", { docId, nodes: [rect(defaultLayerId)] });
  await received(3);
  ws.send(command("r1", { type: "redo" }));
  const [, , , redo] = await received(4);
  expect(redo).toMatchObject({ type: "rejected", error: { code: "NOTHING_TO_REDO" } });
});

it("opens a file POSTed to /api/docs as the user, named after the file", async () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="5" height="5"/></svg>';
  const res = await exports.default.fetch("http://kalamo/api/docs?name=Drawing.svg", {
    method: "POST",
    body: svg,
  });
  expect(res.status).toBe(200);
  const { docId, warnings } = (await res.json()) as { docId: string; warnings: unknown[] };
  expect(warnings).toEqual([]);
  const listed = (await (await exports.default.fetch("http://kalamo/api/docs")).json()) as {
    documents: { docId: string; name: string }[];
  };
  expect(listed.documents[0]).toMatchObject({ docId, name: "Drawing" });
  const { changes } = (await call("kalamo_doc_changes", { docId, sinceRev: 0 })).structuredContent;
  expect(changes[0]).toMatchObject({ actor: "user" });

  const bad = await exports.default.fetch("http://kalamo/api/docs?name=x.svg", {
    method: "POST",
    body: "nope",
  });
  expect(bad.status).toBe(400);
  expect(await bad.json()).toMatchObject({ code: "INVALID_DOCUMENT", hint: expect.any(String) });
});

describe("Open of a bitmap POSTed to /api/docs as its bytes", () => {
  const post = (name: string, body: BodyInit) =>
    exports.default.fetch(`http://kalamo/api/docs?name=${encodeURIComponent(name)}`, {
      method: "POST",
      body,
    });
  const bytesOf = (url: string) => Uint8Array.fromBase64(url.split(",")[1] ?? "");

  it.each([
    ["photo.png", RGB_3x2_PNG, "photo", 3, 2],
    ["anim.GIF", GREY_5x4_GIF, "anim", 5, 4],
  ])("opens %s as a Document of its pixel size", async (name, url, docName, width, height) => {
    const res = await post(name, bytesOf(url));
    expect(res.status).toBe(200);
    const { docId, warnings } = (await res.json()) as { docId: string; warnings: unknown[] };
    expect(warnings).toEqual([]);
    const file = JSON.parse(
      (await call("kalamo_export", { docId, format: "kalamo_json" })).content[0].text,
    );
    const frame = { x: 0, y: 0, width, height };
    expect(file).toMatchObject({ name: docName, artboards: [{ name: "Artboard 1", frame }] });
    type Stored = { id: string; type: string };
    expect(file.nodes).toHaveLength(2);
    const layer = file.nodes.find((n: Stored) => n.type === "layer");
    const image = file.nodes.find((n: Stored) => n.type === "image");
    expect(layer).toMatchObject({ type: "layer", name: "Layer 1", parentId: null });
    expect(image).toMatchObject({
      type: "image",
      parentId: layer.id,
      name: "",
      src: await imageId(bytesOf(url)),
      ...frame,
      preserveAspectRatio: "none",
    });
    const { changes } = (await call("kalamo_doc_changes", { docId, sinceRev: 0 }))
      .structuredContent;
    expect(changes).toMatchObject([{ rev: 1, actor: "user" }]);
  });

  it("opens x.webp as a Document named x holding the WebP's pixels as a PNG (ADR-0100)", async () => {
    const res = await post("x.webp", bytesOf(WEBP_LOSSLESS_4x3));
    expect(res.status).toBe(200);
    const { docId } = (await res.json()) as { docId: string };
    const listed = (await (await exports.default.fetch("http://kalamo/api/docs")).json()) as {
      documents: { docId: string; name: string }[];
    };
    expect(listed.documents.find((d) => d.docId === docId)?.name).toBe("x");
    const file = JSON.parse(
      (await call("kalamo_export", { docId, format: "kalamo_json" })).content[0].text,
    );
    expect(file.artboards[0].frame).toEqual({ x: 0, y: 0, width: 4, height: 3 });
    const image = file.nodes.find((n: { type: string }) => n.type === "image");
    expect(file.images[image.src]).toMatch(/^data:image\/png;base64,/);
    expect(await servedPng(docId, image.src)).toEqual(WEBP_4x3_RGBA);
  });

  it("refuses a WebP Kalamo cannot convert and a body over 5 MB as Place does, creating no Document", async () => {
    const listed = async () =>
      (
        (await (await exports.default.fetch("http://kalamo/api/docs")).json()) as {
          documents: unknown[];
        }
      ).documents.length;
    const before = await listed();
    for (const [url, code, message] of [
      [WEBP_ANIMATED, "INVALID_IMAGE", "animated"],
      [WEBP_OVER_CAP, "LIMIT_EXCEEDED", "4096 × 2049"],
      [WEBP_TRUNCATED, "INVALID_IMAGE", "damaged"],
    ] as const) {
      const webp = await post("a.webp", bytesOf(url));
      expect(webp.status).toBe(400);
      expect(await webp.json()).toMatchObject({
        code,
        message: expect.stringContaining(message),
        path: "content",
      });
    }
    const big = new Uint8Array(5 * MiB + 1);
    big.set(bytesOf(RED_2x2_PNG));
    const large = await post("big.png", big);
    expect(large.status).toBe(400);
    expect(await large.json()).toMatchObject({
      code: "LIMIT_EXCEEDED",
      message: expect.stringContaining("5 MB"),
      path: "content",
    });
    expect(await listed()).toBe(before);
  });

  it("still reads an SVG that is not UTF-8 as text", async () => {
    const latin1 = Uint8Array.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><title>Caf\xe9</title></svg>',
      (c) => c.charCodeAt(0),
    );
    const res = await post("cafe.svg", latin1);
    expect(res.status).toBe(200);
  });
});

it("opens a saved file by content, named .kalamo.json or as the former name saved it (ADR-0069)", async () => {
  expect(JSON.parse(fixture).version).toBe(1);
  expect(MIGRATIONS).toEqual([]);
  const opened = async (name: string) => {
    const res = await exports.default.fetch(`http://kalamo/api/docs?name=${name}`, {
      method: "POST",
      body: fixture,
    });
    expect(res.status, name).toBe(200);
    const { docId } = (await res.json()) as { docId: string };
    return (await call("kalamo_export", { docId, format: "kalamo_json" })).content[0]
      .text as string;
  };
  const text = await opened("Saved.kalamo.json");
  const ids = (file: string) => new Set(JSON.parse(file).nodes.map((n: { id: string }) => n.id));
  expect(ids(text)).toEqual(ids(fixture));
  expect(await opened(`Saved.${LEGACY_NAME}.json`)).toBe(text);
});

it("places an SVG POSTed to /api/docs/:docId/place at the given centre, as the user", async () => {
  const { docId, defaultLayerId } = await newDoc();
  const { received } = await subscribe(docId);
  const post = (query: string, body: string) =>
    exports.default.fetch(`http://kalamo/api/docs/${docId}/place?${query}`, {
      method: "POST",
      body,
    });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="10"/></svg>';

  const res = await post(`parentId=${defaultLayerId}&x=50&y=40&name=Logo.svg`, svg);
  expect(res.status).toBe(200);
  const receipt = (await res.json()) as { createdIds: string[]; bounds: object; nodes: unknown[] };
  expect(receipt.bounds).toEqual({ x: 40, y: 35, width: 20, height: 10 });
  expect(receipt.nodes).toHaveLength(1);
  const [, tx] = await received(2);
  expect(tx).toMatchObject({ type: "tx", actor: "user" });
  const { created } = tx as { created: object[] };
  expect(created).toHaveLength(3);
  expect(created[0]).toMatchObject({
    id: receipt.createdIds[0],
    type: "group",
    name: "Logo",
    parentId: defaultLayerId,
  });

  // An unreadable centre falls back to the Artboard's (200 × 100 here).
  const loose = await post(`parentId=${defaultLayerId}&x=abc&y=1`, svg);
  expect(loose.status).toBe(200);
  expect(((await loose.json()) as { bounds: object }).bounds).toEqual({
    x: 90,
    y: 45,
    width: 20,
    height: 10,
  });

  const refused = await post("x=0&y=0", svg);
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ code: "NODE_NOT_FOUND" });
});

describe("images through the Worker", () => {
  /** A Document with one Image of the red PNG, made over MCP. */
  async function withImage() {
    const { docId, defaultLayerId } = await newDoc();
    const image = { type: "image", parentId: defaultLayerId, src: RED_2x2_PNG, x: 100, y: 0 };
    const [id] = (await call("kalamo_node_create", { docId, nodes: [image] })).structuredContent
      .createdIds as string[];
    const src = await imageId(readImage(RED_2x2_PNG, "src").bytes);
    return { docId, defaultLayerId, id, src };
  }
  const get = (path: string) => exports.default.fetch(`http://kalamo${path}`);

  it("serves an Image's file by its id, cached for good, and 404 for any other", async () => {
    const { docId, src } = await withImage();
    const res = await get(`/api/docs/${docId}/images/${src}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(readImage(RED_2x2_PNG, "src").bytes);
    for (const other of ["b".repeat(64), "nope"]) {
      const missing = await get(`/api/docs/${docId}/images/${other}`);
      expect(missing.status).toBe(404);
      await missing.body?.cancel();
    }
  });

  it("opens an Image's .kalamo.json export with its file, and refuses a file under another id", async () => {
    const { docId, src } = await withImage();
    const json = (await call("kalamo_export", { docId, format: "kalamo_json" })).content[0].text;
    const opened = (await call("kalamo_doc_open", { content: json })).structuredContent;
    const served = await get(`/api/docs/${opened.docId}/images/${src}`);
    expect(served.status).toBe(200);
    await served.body?.cancel();

    const wrong = json.replaceAll(src, "c".repeat(64));
    expect(errorOf(await call("kalamo_doc_open", { content: wrong }))).toMatchObject({
      code: "INVALID_DOCUMENT",
      path: `images.${"c".repeat(64)}`,
    });
  });

  it("stores a file the designer relinked in the editor when Open brings the SVG back", async () => {
    const { docId, id } = await withImage();
    const svg = (await call("kalamo_export", { docId, format: "svg" })).content[0].text as string;
    const res = await exports.default.fetch("http://kalamo/api/docs", {
      method: "POST",
      body: svg.replace(RED_2x2_PNG, BLUE_1x1_PNG),
    });
    const opened = (await res.json()) as { docId: string };
    const blue = await imageId(readImage(BLUE_1x1_PNG, "src").bytes);
    const { nodes } = (
      await call("kalamo_node_get", { docId: opened.docId, nodeIds: [id], detail: "full" })
    ).structuredContent;
    expect(nodes[0]).toMatchObject({ src: blue });
    const served = await get(`/api/docs/${opened.docId}/images/${blue}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    await served.body?.cancel();
  });

  it("places a bitmap POSTed to /api/docs/:docId/place-image centred on the point, as the user", async () => {
    const { docId, defaultLayerId } = await newDoc();
    const { received } = await subscribe(docId);
    const post = (query: string, body: BodyInit) =>
      exports.default.fetch(`http://kalamo/api/docs/${docId}/place-image?${query}`, {
        method: "POST",
        body,
      });
    const png = readImage(RED_2x2_PNG, "src").bytes;
    const src = await imageId(png);

    const res = await post(`parentId=${defaultLayerId}&x=50&y=40`, png);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ bounds: { x: 49, y: 39, width: 2, height: 2 } });
    const [, tx] = await received(2);
    expect(tx).toMatchObject({ type: "tx", actor: "user", created: [{ type: "image", src }] });
    const served = await get(`/api/docs/${docId}/images/${src}`);
    expect(served.status).toBe(200);
    await served.body?.cancel();

    // An unreadable centre falls back to the Artboard's (200 × 100 here).
    const loose = await post(`parentId=${defaultLayerId}&x=abc&y=1`, png);
    expect(await loose.json()).toMatchObject({ bounds: { x: 99, y: 49, width: 2, height: 2 } });

    // A WebP is stored as a PNG of its pixels (ADR-0100).
    const webp = await post(
      `parentId=${defaultLayerId}&x=50&y=40`,
      Uint8Array.fromBase64(WEBP_ALPHA_4x3.split(",")[1] ?? ""),
    );
    expect(webp.status).toBe(200);
    const placed = (await webp.json()) as { createdIds: string[]; bounds: object };
    expect(placed.bounds).toEqual({ x: 48, y: 38.5, width: 4, height: 3 });
    const { nodes } = (
      await call("kalamo_node_get", { docId, nodeIds: placed.createdIds, detail: "full" })
    ).structuredContent;
    expect(nodes[0]).toMatchObject({ width: 4, height: 3 });
    expect(await servedPng(docId, nodes[0].src)).toEqual(WEBP_ALPHA_4x3_RGBA);

    const refusals: [BodyInit, string, object][] = [
      [
        Uint8Array.fromBase64(WEBP_ANIMATED.split(",")[1] ?? ""),
        `parentId=${defaultLayerId}`,
        {
          code: "INVALID_IMAGE",
          hint: expect.stringContaining("one frame as PNG or GIF"),
          path: "file",
        },
      ],
      [
        new Uint8Array(5 * 1024 * 1024 + 1),
        `parentId=${defaultLayerId}`,
        { code: "LIMIT_EXCEEDED" },
      ],
      [png, "", { code: "NODE_NOT_FOUND" }],
    ];
    for (const [body, query, error] of refusals) {
      const refused = await post(query, body);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject(error);
    }
  });

  it("stores nothing for a bitmap whose Place is refused, so its file answers 404 (#66)", async () => {
    const { docId } = await newDoc();
    const blue = readImage(BLUE_1x1_PNG, "src").bytes;
    const refused = await exports.default.fetch(
      `http://kalamo/api/docs/${docId}/place-image?parentId=nope`,
      { method: "POST", body: blue },
    );
    expect(await refused.json()).toMatchObject({ code: "NODE_NOT_FOUND" });
    const missing = await get(`/api/docs/${docId}/images/${await imageId(blue)}`);
    expect(missing.status).toBe(404);
    await missing.body?.cancel();
  });

  describe("Relink from a file POSTed to /api/docs/:docId/relink-image (ADR-0042)", () => {
    const relink = (docId: string, query: string, body: BodyInit) =>
      exports.default.fetch(`http://kalamo/api/docs/${docId}/relink-image?${query}`, {
        method: "POST",
        body,
      });
    const blue = readImage(BLUE_1x1_PNG, "src").bytes;
    const nodeOf = async (docId: string, id: string) =>
      (await call("kalamo_node_get", { docId, nodeIds: [id], detail: "full" })).structuredContent
        .nodes[0];
    const stub = (docId: string) => env.DOCUMENT.get(env.DOCUMENT.idFromName(docId));
    const revOf = async (docId: string) => {
      const info = await stub(docId).info();
      return "error" in info ? undefined : info.rev;
    };
    const create = async (docId: string, nodes: object[]) => {
      const result = await call("kalamo_node_create", { docId, nodes });
      expect(errorOf(result)).toBeNull();
      return result.structuredContent.createdIds as string[];
    };
    const set = async (docId: string, nodeId: string, patch: object) =>
      expect(
        errorOf(await call("kalamo_node_update", { docId, updates: [{ nodeId, patch }] })),
      ).toBeNull();

    it("fills a missing link and renames it after the file, as the user in one undo step", async () => {
      const { docId, defaultLayerId } = await newDoc();
      const [id = ""] = await create(docId, [
        {
          type: "image",
          parentId: defaultLayerId,
          file: "gone.png",
          x: 5,
          y: 5,
          width: 40,
          height: 20,
        },
      ]);
      await call("kalamo_node_transform", { docId, nodeIds: [id], rotate: 30 });
      const before = await nodeOf(docId, id);
      const { received } = await subscribe(docId);

      const res = await relink(docId, `nodeId=${id}&name=found.png`, blue);
      expect(res.status).toBe(200);
      const src = await imageId(blue);
      expect(await nodeOf(docId, id)).toEqual({ ...before, src, file: "found.png" });
      const [, tx] = await received(2);
      expect(tx).toMatchObject({ type: "tx", actor: "user", updated: [{ id, src }] });
      const served = await get(`/api/docs/${docId}/images/${src}`);
      expect(served.status).toBe(200);
      await served.body?.cancel();

      await stub(docId).undo("user");
      expect(await nodeOf(docId, id)).toEqual(before);
    });

    it("replaces an embedded Image's pixels and leaves it embedded; a hidden one too", async () => {
      const { docId, defaultLayerId } = await newDoc();
      const [id = ""] = await create(docId, [
        { type: "image", parentId: defaultLayerId, src: RED_2x2_PNG, x: 0, y: 0 },
      ]);
      await set(docId, id, { visible: false });
      const res = await relink(docId, `nodeId=${id}&name=blue.png`, blue);
      expect(res.status).toBe(200);
      const node = await nodeOf(docId, id);
      expect(node).toMatchObject({ src: await imageId(blue), width: 2, height: 2 });
      expect(node).not.toHaveProperty("file");
    });

    it("relinks to a WebP, stored as a PNG of its pixels (ADR-0100)", async () => {
      const { docId, defaultLayerId } = await newDoc();
      const [id = ""] = await create(docId, [
        { type: "image", parentId: defaultLayerId, src: RED_2x2_PNG, x: 0, y: 0 },
      ]);
      const webp = Uint8Array.fromBase64(WEBP_LOSSLESS_4x3.split(",")[1] ?? "");
      const res = await relink(docId, `nodeId=${id}&name=photo.webp`, webp);
      expect(res.status).toBe(200);
      const node = (await nodeOf(docId, id)) as { src: string };
      expect(await servedPng(docId, node.src)).toEqual(WEBP_4x3_RGBA);
    });

    it("refuses what is not an Image, a locked Image or Layer, and files Place refuses", async () => {
      const { docId, defaultLayerId } = await newDoc();
      const [layer = ""] = await create(docId, [{ type: "layer", name: "Locked" }]);
      const [rectId = "", lockedId = "", inLocked = ""] = await create(docId, [
        rect(defaultLayerId),
        { type: "image", parentId: defaultLayerId, src: RED_2x2_PNG, x: 0, y: 0 },
        { type: "image", parentId: layer, src: RED_2x2_PNG, x: 0, y: 0 },
      ]);
      await set(docId, layer, { locked: true });
      await set(docId, lockedId, { locked: true });
      const [free = ""] = await create(docId, [
        { type: "image", parentId: defaultLayerId, src: RED_2x2_PNG, x: 0, y: 0 },
      ]);
      const rev = await revOf(docId);
      const locked = {
        code: "INVALID_IMAGE",
        message: "The Image or its Layer is locked.",
        hint: "Unlock it first.",
      };
      const refusals: [string, BodyInit, object][] = [
        [rectId, blue, { code: "INVALID_IMAGE", path: "nodeId" }],
        ["nope", blue, { code: "NODE_NOT_FOUND" }],
        [lockedId, blue, locked],
        [inLocked, blue, locked],
        [
          free,
          Uint8Array.fromBase64(WEBP_TRUNCATED.split(",")[1] ?? ""),
          { code: "INVALID_IMAGE", message: expect.stringContaining("damaged"), path: "file" },
        ],
        [free, new Uint8Array(5 * 1024 * 1024 + 1), { code: "LIMIT_EXCEEDED" }],
      ];
      for (const [nodeId, body, error] of refusals) {
        const refused = await relink(docId, `nodeId=${nodeId}&name=a.png`, body);
        expect(refused.status).toBe(400);
        expect(await refused.json()).toMatchObject(error);
      }
      expect(await revOf(docId)).toBe(rev);
    });
  });

  it("places an SVG holding an embedded PNG, and serves its file", async () => {
    const { docId, defaultLayerId } = await newDoc();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image width="4" height="4" xlink:href="${RED_2x2_PNG}"/></svg>`;
    const res = await exports.default.fetch(
      `http://kalamo/api/docs/${docId}/place?parentId=${defaultLayerId}`,
      { method: "POST", body: svg },
    );
    const receipt = (await res.json()) as { createdIds: string[] };
    const { nodes } = (
      await call("kalamo_node_get", { docId, nodeIds: receipt.createdIds, detail: "full" })
    ).structuredContent;
    const src = await imageId(readImage(RED_2x2_PNG, "src").bytes);
    // The file's Group, the Layer its loose content made (as a Group), then the Image.
    expect(nodes.map((n: { type: string }) => n.type)).toEqual(["group", "group", "image"]);
    expect(nodes[2]).toMatchObject({ src });
    const served = await get(`/api/docs/${docId}/images/${src}`);
    expect(served.status).toBe(200);
    await served.body?.cancel();
  });
});

describe("request bodies capped before they are read (ADR-0049)", () => {
  const post = (path: string, body: ReadableStream, length?: number) =>
    exports.default.fetch(`http://kalamo${path}`, {
      method: "POST",
      body,
      ...(length !== undefined && { headers: { "content-length": String(length) } }),
    });

  async function routes() {
    const { docId, defaultLayerId } = await newDoc();
    const [imageNode = ""] = (
      await call("kalamo_node_create", {
        docId,
        nodes: [{ type: "image", parentId: defaultLayerId, src: RED_2x2_PNG, x: 0, y: 0 }],
      })
    ).structuredContent.createdIds as string[];
    return [
      ["/api/docs", "content", 32 * MiB],
      [`/api/docs/${docId}/place?parentId=${defaultLayerId}`, "svg", 32 * MiB],
      [`/api/docs/${docId}/place-image?parentId=${defaultLayerId}`, "file", 5 * MiB],
      [`/api/docs/${docId}/relink-image?nodeId=${imageNode}`, "file", 5 * MiB],
    ] as const;
  }

  it("refuses a declared length over the cap without pulling the body", async () => {
    for (const [path, at, cap] of await routes()) {
      const { stream, pulls } = counted(cap / MiB + 1);
      const res = await post(path, stream, cap + 1);
      expect(res.status).toBe(400);
      const error = (await res.json()) as { message: string };
      expect(error).toMatchObject({ code: "LIMIT_EXCEEDED", path: at });
      expect(error.message).toContain(String(cap));
      expect(error.message).toContain(String(cap + 1));
      // The runtime pulls one chunk as it hands the request over, whether the Worker reads it or not.
      expect(pulls()).toBeLessThanOrEqual(1);
    }
  });

  it("refuses a body that streams past the cap, with no or an understated length, before its end", async () => {
    for (const [path, at, cap] of await routes()) {
      for (const length of [undefined, 10]) {
        const { stream, pulls } = counted(cap / MiB + 4);
        const res = await post(path, stream, length);
        expect(res.status).toBe(400);
        const error = (await res.json()) as { message: string };
        expect(error).toMatchObject({ code: "LIMIT_EXCEEDED", path: at });
        expect(error.message).toContain(String(cap));
        expect(pulls()).toBeLessThan(cap / MiB + 4);
      }
    }
  }, 30_000);

  it("reopens a .kalamo.json whose images fill the 20 MB Document cap", async () => {
    const { docId, defaultLayerId } = await newDoc();
    const text = await fullKalamoFile(docId, defaultLayerId);
    const res = await exports.default.fetch("http://kalamo/api/docs", {
      method: "POST",
      body: text,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ docId: expect.any(String) });
  }, 60_000);
});
