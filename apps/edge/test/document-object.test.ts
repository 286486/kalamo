import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  columnChart,
  type DuplicateInput,
  GEOMETRY_OPS,
  linesBox,
  PATH_OP_TEXT,
  type PathOpInput,
  parseDocument,
  type Rect,
  resolveImages,
} from "@kalamo/core";
import { afterEach, expect, it, vi } from "vitest";

const stub = (docId: string) => env.DOCUMENT.get(env.DOCUMENT.idFromName(docId));

const ok = <T extends object>(result: T): Exclude<T, { error: unknown }> => {
  if ("error" in result) throw new Error(JSON.stringify(result.error));
  return result as Exclude<T, { error: unknown }>;
};

const artboards = [{ width: 200, height: 100 }];

it("keeps Nodes and the Transaction log across a DO restart, with each write's Actor", async () => {
  const created = ok(
    await stub("d1").create({ docId: "d1", name: "Doc", artboards, actor: "agent-a" }),
  );
  expect(created).toMatchObject({ docId: "d1", rev: 1 });

  const receipt = await stub("d1").createNodes(
    [
      {
        type: "rect",
        parentId: created.defaultLayerId,
        clientKey: "r",
        x: 10,
        y: 10,
        width: 50,
        height: 30,
      },
    ],
    "agent-b",
  );
  if ("error" in receipt) throw new Error(receipt.error.message);
  expect(receipt).toMatchObject({
    rev: 2,
    updatedIds: [],
    deletedIds: [],
    bounds: { x: 10, y: 10, width: 50, height: 30 },
    warnings: [],
  });
  expect(receipt.createdIds).toHaveLength(1);
  expect(receipt.keyMap).toEqual({ r: receipt.createdIds[0] });

  await evictDurableObject(stub("d1"));

  expect(await stub("d1").info()).toMatchObject({ docId: "d1", name: "Doc", rev: 2 });
  expect(await stub("d1").outline({ depth: 2 }, "agent-a")).toMatchObject({
    rev: 2,
    nodes: [
      { id: created.defaultLayerId, children: [{ id: receipt.createdIds[0], type: "rect" }] },
    ],
  });
  expect(await stub("d1").changes(0)).toMatchObject({
    rev: 2,
    changes: [
      { rev: 1, actor: "agent-a" },
      { rev: 2, actor: "agent-b", createdIds: receipt.createdIds },
    ],
  });
});

it("leaves rev unchanged when a write fails", async () => {
  const created = ok(
    await stub("d2").create({ docId: "d2", name: "Doc", artboards, actor: "agent-a" }),
  );
  const rect = { type: "rect" as const, x: 0, y: 0, width: 1, height: 1 };
  expect(
    await stub("d2").createNodes(
      [
        { ...rect, parentId: created.defaultLayerId },
        { ...rect, parentId: "nope" },
      ],
      "agent-a",
    ),
  ).toMatchObject({ error: { code: "NODE_NOT_FOUND", path: "nodes[1].parentId" } });
  expect(await stub("d2").info()).toMatchObject({ rev: 1 });
  expect(await stub("d2").outline({ depth: 2 }, "agent-a")).toMatchObject({
    nodes: [{ childCount: 0 }],
  });
});

it("reports DOC_NOT_FOUND for a Document that was never created", async () => {
  expect(await stub("missing").info()).toMatchObject({ error: { code: "DOC_NOT_FOUND" } });
  expect(await stub("missing").outline({ depth: 2 }, "agent-a")).toMatchObject({
    error: { code: "DOC_NOT_FOUND" },
  });
});

it("logs update, transform and delete with their ids and intent, across a restart", async () => {
  const created = ok(
    await stub("d3").create({
      docId: "d3",
      name: "Doc",
      artboards,
      actor: "agent-a",
      intent: "start a poster",
    }),
  );
  const rect = { type: "rect" as const, x: 0, y: 0, width: 10, height: 10 };
  const made = ok(
    await stub("d3").createNodes([{ ...rect, parentId: created.defaultLayerId }], "agent-a", {
      intent: "draw a box",
    }),
  );
  const [id = ""] = made.createdIds;
  const updated = ok(
    await stub("d3").updateNodes([{ nodeId: id, patch: { name: "Box" } }], "agent-b", {
      intent: "make it red",
    }),
  );
  expect(updated).toMatchObject({ rev: 3, updatedIds: [id], createdIds: [], deletedIds: [] });
  expect(updated).not.toHaveProperty("failed");
  ok(await stub("d3").transformNodes({ nodeIds: [id], translate: { x: 5 } }, "agent-b"));
  // A failing write leaves rev alone; a partial one bumps it once and logs only what applied.
  expect(
    await stub("d3").updateNodes([{ nodeId: "nope", patch: { name: "x" } }], "agent-b"),
  ).toMatchObject({ error: { code: "NODE_NOT_FOUND" } });
  const partial = ok(
    await stub("d3").updateNodes(
      [
        { nodeId: id, patch: { opacity: 0.5 } },
        { nodeId: "nope", patch: {} },
      ],
      "agent-b",
      { partial: true },
    ),
  );
  expect(partial).toMatchObject({ rev: 5, updatedIds: [id], failed: [{ index: 1 }] });
  ok(await stub("d3").deleteNodes([id], "agent-b"));

  await evictDurableObject(stub("d3"));

  expect(await stub("d3").outline({ depth: 2 }, "agent-a")).toMatchObject({
    rev: 6,
    nodes: [{ childCount: 0 }],
  });
  expect(ok(await stub("d3").changes(0)).changes).toEqual([
    expect.objectContaining({ rev: 1, intent: "start a poster" }),
    expect.objectContaining({ rev: 2, createdIds: [id], intent: "draw a box" }),
    expect.objectContaining({ rev: 3, actor: "agent-b", updatedIds: [id], intent: "make it red" }),
    expect.objectContaining({ rev: 4, updatedIds: [id], intent: null }),
    expect.objectContaining({ rev: 5, updatedIds: [id] }),
    expect.objectContaining({ rev: 6, deletedIds: [id], createdIds: [], updatedIds: [] }),
  ]);
});

it("rejects a write whose ifRev is stale with REV_CONFLICT, changing nothing", async () => {
  const created = ok(
    await stub("d4").create({ docId: "d4", name: "Doc", artboards, actor: "agent-a" }),
  );
  const rect = { type: "rect" as const, x: 0, y: 0, width: 10, height: 10 };
  const [id = ""] = ok(
    await stub("d4").createNodes([{ ...rect, parentId: created.defaultLayerId }], "agent-a"),
  ).createdIds;
  expect(
    await stub("d4").updateNodes([{ nodeId: id, patch: { name: "x" } }], "agent-b", { ifRev: 1 }),
  ).toMatchObject({
    error: {
      code: "REV_CONFLICT",
      rev: 2,
      nodeIds: [id],
      path: "ifRev",
      hint: expect.stringContaining("kalamo_doc_changes"),
    },
  });
  expect(await stub("d4").info()).toMatchObject({ rev: 2 });
  expect(await stub("d4").get([id], "full", "agent-a")).toMatchObject({ nodes: [{ name: "" }] });
  expect(
    await stub("d4").updateNodes([{ nodeId: id, patch: { name: "x" } }], "agent-b", { ifRev: 2 }),
  ).toMatchObject({ rev: 3 });
  expect(await stub("d4").changes(0, 1)).toMatchObject({ rev: 3, changes: [{ rev: 1 }] });
  expect(await stub("d4").changes(1)).toMatchObject({
    rev: 3,
    changes: [{ rev: 2 }, { rev: 3, actor: "agent-b" }],
  });
});

const rect = { type: "rect" as const, x: 0, y: 0, width: 10, height: 10 };

/** A Document with one committed rect, at rev 2. */
async function withRect(docId: string) {
  const { defaultLayerId } = ok(
    await stub(docId).create({ docId, name: "Doc", artboards, actor: "agent-a" }),
  );
  const [rectId = ""] = ok(
    await stub(docId).createNodes([{ ...rect, parentId: defaultLayerId }], "agent-a"),
  ).createdIds;
  return { s: stub(docId), defaultLayerId, rectId };
}

it("reports where a redone delete took the Node from", async () => {
  const { s, rectId } = await withRect("u6");
  const at = { x: 0, y: 0, width: 10, height: 10 };
  ok(await s.deleteNodes([rectId], "agent-a"));
  expect(ok(await s.undo("user"))).toMatchObject({ createdIds: [rectId], bounds: at });
  expect(ok(await s.redo("user"))).toMatchObject({ deletedIds: [rectId], bounds: at });
});

it("commits with bounds covering what it created and where it deleted", async () => {
  const { s, defaultLayerId, rectId } = await withRect("t6");
  const { txId } = ok(await s.begin("agent-a"));
  const [a = ""] = ok(
    await s.createNodes([{ ...rect, x: 30, parentId: defaultLayerId }], "agent-a", { txId }),
  ).createdIds;
  expect(ok(await s.deleteNodes([rectId], "agent-a", { txId }))).toMatchObject({
    rev: 2,
    deletedIds: [rectId],
    bounds: { x: 0, y: 0, width: 10, height: 10 },
  });
  expect(ok(await s.commitTx(txId, "agent-a"))).toMatchObject({
    rev: 3,
    createdIds: [a],
    deletedIds: [rectId],
    bounds: { x: 0, y: 0, width: 40, height: 10 },
  });
});

it("reports where a deleted Group's contents were", async () => {
  const { s, defaultLayerId } = await withRect("u7");
  const [group = ""] = ok(
    await s.createNodes(
      [
        {
          type: "group",
          parentId: defaultLayerId,
          children: [{ type: "line", x1: 20, y1: 0, x2: 70, y2: 5 }],
        },
      ],
      "agent-a",
    ),
  ).createdIds;
  expect(ok(await s.deleteNodes([group], "agent-a"))).toMatchObject({
    bounds: { x: 20, y: 0, width: 50, height: 5 },
  });
});

const layerChildren = async (s: ReturnType<typeof stub>, txId?: string) => {
  const { nodes } = ok(await s.outline({ depth: 2 }, "agent-a", txId));
  return (nodes[0]?.children ?? []).map((c) => c.id);
};

it("keeps a Transaction's edits in an overlay until commit, across a restart", async () => {
  const { s, defaultLayerId, rectId } = await withRect("t1");
  const { txId, rev } = ok(await s.begin("agent-a", "Draw a face"));
  expect(rev).toBe(2);
  const made = ok(
    await s.createNodes(
      [
        { ...rect, parentId: defaultLayerId },
        { ...rect, parentId: defaultLayerId },
      ],
      "agent-a",
      { txId },
    ),
  );
  expect(made).toMatchObject({ txId, rev: 2 });
  const [a = "", b = ""] = made.createdIds;
  ok(await s.updateNodes([{ nodeId: a, patch: { name: "eye" } }], "agent-a", { txId }));
  ok(await s.deleteNodes([b], "agent-a", { txId }));
  expect(await layerChildren(s, txId)).toEqual([rectId, a]);
  expect(await layerChildren(s)).toEqual([rectId]);
  expect(await s.get([rectId, a], "concise", "agent-a")).toMatchObject({
    error: { code: "NODE_NOT_FOUND", path: "nodeIds[1]" },
  });
  expect(await s.info()).toMatchObject({ rev: 2 });

  await evictDurableObject(s);

  expect(ok(await s.commitTx(txId, "agent-a", { intent: "face" }))).toMatchObject({
    txId,
    rev: 3,
    createdIds: [a],
    updatedIds: [],
    deletedIds: [],
    bounds: { x: 0, y: 0, width: 10, height: 10 },
  });
  expect(await layerChildren(s)).toEqual([rectId, a]);
  expect(ok(await s.get([a], "concise", "agent-a")).nodes).toMatchObject([{ name: "eye" }]);
  expect(ok(await s.changes(2))).toMatchObject({
    rev: 3,
    changes: [{ rev: 3, txId, actor: "agent-a", summary: "Draw a face", intent: "face" }],
  });
  expect(await s.commitTx(txId, "agent-a")).toMatchObject({
    error: { code: "TX_EXPIRED", hint: expect.stringContaining("committed at rev 3") },
  });
});

it("rolls back to the Document as it was before tx_begin", async () => {
  const { s, defaultLayerId, rectId } = await withRect("t2");
  const before = ok(await s.outline({ depth: 3 }, "agent-a"));
  const log = ok(await s.changes(0));
  const { txId } = ok(await s.begin("agent-a"));
  ok(await s.createNodes([{ ...rect, parentId: defaultLayerId }], "agent-a", { txId }));
  ok(await s.updateNodes([{ nodeId: rectId, patch: { name: "x" } }], "agent-a", { txId }));
  ok(await s.deleteNodes([rectId], "agent-a", { txId }));
  expect(ok(await s.rollback(txId, "agent-a"))).toEqual({ txId, rev: 2 });
  expect(ok(await s.outline({ depth: 3 }, "agent-a"))).toEqual(before);
  expect(await s.info()).toMatchObject({ rev: 2 });
  expect(ok(await s.changes(0))).toEqual(log);
  expect(await s.get([rectId], "full", "agent-a", txId)).toMatchObject({
    error: { code: "TX_EXPIRED", hint: expect.stringContaining("rolled back") },
  });
  expect(
    await s.createNodes([{ ...rect, parentId: defaultLayerId }], "agent-a", { txId }),
  ).toMatchObject({ error: { code: "TX_EXPIRED", hint: expect.stringContaining("rolled back") } });
  expect(await s.rollback(txId, "agent-a")).toMatchObject({ error: { code: "TX_EXPIRED" } });
});

it("exports a Transaction's edits as .kalamo.json only under its txId", async () => {
  const { s, defaultLayerId } = await withRect("tx-file");
  const ids = async (txId?: string) =>
    JSON.parse(ok(await s.file("agent-a", txId)).text).nodes.map((n: { id: string }) => n.id);
  const committed = await ids();
  const { txId } = ok(await s.begin("agent-a"));
  const [staged] = ok(
    await s.createNodes([{ ...rect, parentId: defaultLayerId }], "agent-a", { txId }),
  ).createdIds;
  expect(await ids(txId)).toEqual([...committed, staged].sort());
  expect(await ids()).toEqual(committed);
  expect(await s.file("agent-b", txId)).toMatchObject({ error: { code: "TX_NOT_FOUND" } });
});

it("opens a file as rev 1 keeping its ids, outlined to depth 1, logged as Open with its intent", async () => {
  const { s, defaultLayerId, rectId } = await withRect("open-from");
  const file = parseDocument(ok(await s.file("agent-a")).text);
  const opened = ok(
    await stub("open-to").open({ docId: "open-to", ...file, actor: "agent-b", intent: "reopen" }),
  );
  expect(opened).toEqual({
    docId: "open-to",
    name: "Doc",
    artboards: file.artboards,
    rev: 1,
    nodes: [expect.objectContaining({ id: defaultLayerId, type: "layer", childCount: 1 })],
  });
  expect(opened.nodes[0]).not.toHaveProperty("children");
  expect(ok(await stub("open-to").get([rectId], "full", "agent-b")).nodes).toMatchObject([
    { id: rectId, type: "rect" },
  ]);
  expect(ok(await stub("open-to").changes(0)).changes).toEqual([
    expect.objectContaining({
      rev: 1,
      actor: "agent-b",
      summary: 'Open Document "Doc"',
      intent: "reopen",
      createdIds: expect.arrayContaining([defaultLayerId, rectId]),
    }),
  ]);
});

it("merges per property at commit, and fails with NODE_GONE when an edited Node was deleted", async () => {
  const { s, rectId } = await withRect("t3");
  const { txId } = ok(await s.begin("agent-a"));
  ok(await s.updateNodes([{ nodeId: rectId, patch: { opacity: 0.5 } }], "agent-a", { txId }));
  ok(await s.updateNodes([{ nodeId: rectId, patch: { name: "z" } }], "agent-b"));
  expect(ok(await s.commitTx(txId, "agent-a"))).toMatchObject({ rev: 4, updatedIds: [rectId] });
  expect(ok(await s.get([rectId], "full", "agent-a")).nodes).toMatchObject([
    { name: "z", opacity: 0.5 },
  ]);

  const tx2 = ok(await s.begin("agent-a")).txId;
  ok(await s.updateNodes([{ nodeId: rectId, patch: { opacity: 1 } }], "agent-a", { txId: tx2 }));
  expect(await s.commitTx(tx2, "agent-a", { ifRev: 3 })).toMatchObject({
    error: { code: "REV_CONFLICT", rev: 4 },
  });
  ok(await s.deleteNodes([rectId], "agent-b"));
  expect(await s.commitTx(tx2, "agent-a")).toMatchObject({
    error: { code: "NODE_GONE", nodeIds: [rectId], hint: expect.any(String) },
  });
  expect(await s.info()).toMatchObject({ rev: 5 });
  // The Transaction stays open.
  expect(ok(await s.get([rectId], "full", "agent-a", tx2)).nodes).toMatchObject([{ opacity: 1 }]);
  ok(await s.rollback(tx2, "agent-a"));
});

it("hides a Transaction from other Actors and from unknown ids", async () => {
  const { s, defaultLayerId } = await withRect("t4");
  const { txId } = ok(await s.begin("agent-a"));
  const create = (actor: string, id: string) =>
    s.createNodes([{ ...rect, parentId: defaultLayerId }], actor, { txId: id });
  expect(await create("agent-b", txId)).toMatchObject({
    error: { code: "TX_NOT_FOUND", path: "txId" },
  });
  expect(await s.outline({ depth: 2 }, "agent-b", txId)).toMatchObject({
    error: { code: "TX_NOT_FOUND" },
  });
  expect(await s.commitTx(txId, "agent-b")).toMatchObject({ error: { code: "TX_NOT_FOUND" } });
  expect(await create("agent-a", "01NOPE")).toMatchObject({ error: { code: "TX_NOT_FOUND" } });
  expect(await create("agent-a", txId)).toMatchObject({ txId });
});

it("validates inside a Transaction only for the Actor that holds it, at the committed rev", async () => {
  const { s, defaultLayerId, rectId } = await withRect("v1");
  const { txId } = ok(await s.begin("agent-a"));
  const [groupId] = ok(
    await s.createNodes([{ type: "group", parentId: defaultLayerId, children: [] }], "agent-a", {
      txId,
    }),
  ).createdIds;
  ok(await s.transformNodes({ nodeIds: [rectId], translate: { x: 500 } }, "agent-a", { txId }));
  expect(ok(await s.validate({}, "agent-a", txId))).toMatchObject({
    rev: 2,
    issues: [
      { rule: "outside_artboards", nodeId: rectId },
      { rule: "empty_group", nodeId: groupId },
    ],
  });
  expect(ok(await s.validate({ rules: ["empty_group"] }, "agent-a", txId)).issues).toHaveLength(1);
  expect(ok(await s.validate({}, "agent-a"))).toEqual({ rev: 2, issues: [] });
  expect(await s.validate({}, "agent-b", txId)).toMatchObject({ error: { code: "TX_NOT_FOUND" } });
});

afterEach(() => vi.useRealTimers());

it("expires a Transaction idle for 5 minutes through the alarm", async () => {
  const { s, defaultLayerId, rectId } = await withRect("t5");
  vi.useFakeTimers({ toFake: ["Date"] });
  const t0 = Date.now();
  const a = ok(await s.begin("agent-a")).txId;
  const b = ok(await s.begin("agent-a")).txId;
  const c = ok(await s.begin("agent-a")).txId;
  ok(await s.createNodes([{ ...rect, parentId: defaultLayerId }], "agent-a", { txId: a }));
  vi.setSystemTime(t0 + 4 * 60_000);
  ok(await s.outline({ depth: 2 }, "agent-a", b));
  vi.setSystemTime(t0 + 5 * 60_000 + 1000);
  // Past its deadline a Transaction is expired even before the alarm runs.
  expect(await s.outline({ depth: 2 }, "agent-a", c)).toMatchObject({
    error: { code: "TX_EXPIRED" },
  });
  expect(await runDurableObjectAlarm(s)).toBe(true);
  const ended = (id: string) =>
    runInDurableObject(
      s,
      (_, state) =>
        state.storage.sql
          .exec<{ ended: string | null }>("SELECT ended FROM tx WHERE id = ?", id)
          .one().ended,
    );
  expect(await ended(a)).toBe("expired");
  expect(await ended(b)).toBeNull();
  expect(
    await s.createNodes([{ ...rect, parentId: defaultLayerId }], "agent-a", { txId: a }),
  ).toMatchObject({
    error: { code: "TX_EXPIRED", path: "txId", hint: expect.stringContaining("idle") },
  });
  expect(await layerChildren(s)).toEqual([rectId]);
  ok(await s.createNodes([{ ...rect, parentId: defaultLayerId }], "agent-a", { txId: b }));
  vi.setSystemTime(t0 + 11 * 60_000);
  expect(await runDurableObjectAlarm(s)).toBe(true);
  expect(await s.rollback(b, "agent-a")).toMatchObject({ error: { code: "TX_EXPIRED" } });
  expect(await runDurableObjectAlarm(s)).toBe(false);
});

/** The rect's left edge as `user` reads it, or null once it is gone. */
async function xOf(s: ReturnType<typeof stub>, id: string) {
  const got = await s.get([id], "concise", "user");
  return "error" in got ? null : (got.nodes[0]?.geometricBounds?.x ?? null);
}

it("has nothing to undo or redo on a new Document: its creation is not undoable", async () => {
  ok(await stub("u1").create({ docId: "u1", name: "Doc", artboards, actor: "agent-a" }));
  expect(await stub("u1").undo("user")).toMatchObject({ error: { code: "NOTHING_TO_UNDO" } });
  expect(await stub("u1").redo("user")).toMatchObject({ error: { code: "NOTHING_TO_REDO" } });
  expect(await stub("u1").info()).toMatchObject({ rev: 1 });
});

it("undoes and redoes as new Transactions, back to the Document's creation", async () => {
  const { s: doc, rectId: id } = await withRect("u2");
  const x = () => xOf(doc, id);
  ok(await stub("u2").transformNodes({ nodeIds: [id], translate: { x: 5 } }, "agent-a"));
  expect(await x()).toBe(5);

  expect(ok(await stub("u2").undo("user"))).toMatchObject({ rev: 4, updatedIds: [id] });
  expect(await x()).toBe(0);
  expect(ok(await stub("u2").redo("user"))).toMatchObject({ rev: 5 });
  expect(await x()).toBe(5);
  expect(await stub("u2").redo("user")).toMatchObject({ error: { code: "NOTHING_TO_REDO" } });

  ok(await stub("u2").undo("user"));
  // Undoing the create reports where the Node was.
  expect(ok(await stub("u2").undo("user"))).toMatchObject({
    deletedIds: [id],
    bounds: { x: 0, y: 0, width: 10, height: 10 },
  });
  expect(await x()).toBeNull();
  expect(await stub("u2").undo("user")).toMatchObject({ error: { code: "NOTHING_TO_UNDO" } });

  const { changes } = ok(await stub("u2").changes(2));
  expect(changes.map((c) => [c.actor, c.summary])).toEqual([
    ["agent-a", "Transform 1 Node"],
    ["user", 'Undo "Transform 1 Node"'],
    ["user", 'Redo "Transform 1 Node"'],
    ["user", 'Undo "Transform 1 Node"'],
    ["user", 'Undo "Create 1 Node"'],
  ]);
});

it("redoes in the reverse order of the undos", async () => {
  const { s: doc, rectId: id } = await withRect("u4");
  const x = () => xOf(doc, id);
  for (const dx of [5, 7])
    ok(await doc.transformNodes({ nodeIds: [id], translate: { x: dx } }, "agent-a"));
  const steps: (number | null)[] = [];
  for (const step of ["undo", "undo", "redo", "redo"] as const) {
    ok(await doc[step]("user"));
    steps.push(await x());
  }
  expect(steps).toEqual([5, 0, 5, 12]);
});

it("keeps the latest 200 Transactions on the undo stack", async () => {
  const { s: doc, rectId: id } = await withRect("u3");
  const x = () => xOf(doc, id);
  for (let i = 0; i < 201; i++) {
    ok(await stub("u3").transformNodes({ nodeIds: [id], translate: { x: 1 } }, "agent-a"));
  }
  // The create and the first move fell off the stack, and their deltas with them.
  const oldest = await runInDurableObject(doc, (_, state) =>
    state.storage.sql.exec<{ rev: number }>("SELECT MIN(rev) AS rev FROM tx_delta").one(),
  );
  expect(oldest.rev).toBe(4);
  for (let i = 0; i < 200; i++) ok(await stub("u3").undo("user"));
  expect(await stub("u3").undo("user")).toMatchObject({ error: { code: "NOTHING_TO_UNDO" } });
  // The create and the first move fell off the stack.
  expect(await x()).toBe(1);
  // 402 round trips take over 4 s of the default 5 s when the whole suite runs in parallel.
}, 30_000);

it("drops a rev's delta when it leaves both the undo and redo stacks", async () => {
  const { s: doc, rectId: id } = await withRect("dl");
  const move = () => doc.transformNodes({ nodeIds: [id], translate: { x: 1 } }, "agent-a");
  const revs = () =>
    runInDurableObject(doc, (_, state) =>
      state.storage.sql
        .exec<{ rev: number }>("SELECT DISTINCT rev FROM tx_delta ORDER BY rev")
        .toArray()
        .map((r) => r.rev),
    );
  ok(await move());
  ok(await doc.undo("user"));
  // The undone move left the undo stack; its undo is on the redo stack.
  expect(await revs()).toEqual([2, 4]);
  ok(await move());
  // The redo stack is cleared.
  expect(await revs()).toEqual([2, 5]);
});

it("commits to a Document whose tx_log has the retired at column", async () => {
  const { s: doc, rectId: id } = await withRect("at");
  await runInDurableObject(doc, (_, state) => {
    state.storage.sql.exec("ALTER TABLE tx_log ADD COLUMN at INTEGER");
  });
  ok(await doc.transformNodes({ nodeIds: [id], translate: { x: 1 } }, "agent-a"));
  expect(ok(await doc.undo("user"))).toMatchObject({ updatedIds: [id] });
});

it("writes each Node id into the SVG it hands the Worker to rasterise, with the ids overlay", async () => {
  const { defaultLayerId: parentId } = ok(
    await stub("ids").create({ docId: "ids", name: "Doc", artboards, actor: "agent-a" }),
  );
  const receipt = ok(
    await stub("ids").createNodes(
      [
        { type: "rect", parentId, x: 10, y: 10, width: 20, height: 20 },
        { type: "group", parentId, children: [{ type: "line", x1: 0, y1: 0, x2: 5, y2: 5 }] },
      ],
      "agent-a",
    ),
  );
  const { svg } = ok(await stub("ids").raster("agent-a", { scale: 1, overlays: ["ids"] }, true));
  expect(receipt.createdIds).toHaveLength(3);
  for (const id of receipt.createdIds) expect(svg).toContain(`>${id}</text>`);
  expect(svg).not.toContain(`>${parentId}</text>`);
});

it("rasterises Template Layers only when the caller asks, as render does and PNG export does not (ADR-0099)", async () => {
  const s = stub("tpl");
  ok(await s.create({ docId: "tpl", name: "Doc", artboards, actor: "agent-a" }));
  const [layerId] = ok(await s.createNodes([{ type: "layer", template: true }], "agent-a"))
    .createdIds as [string];
  const [inside] = ok(
    await s.createNodes(
      [{ type: "rect", parentId: layerId, x: 10, y: 10, width: 20, height: 20 }],
      "agent-a",
    ),
  ).createdIds as [string];
  const drawn = ok(await s.raster("agent-a", { scale: 1 }, true)).svg;
  expect(drawn).toContain(`z-${layerId}`);
  expect(drawn).toContain(`z-${inside}`);
  const left = ok(await s.raster("agent-a", { scale: 1 }, false)).svg;
  expect(left).not.toContain(`z-${layerId}`);
  expect(left).not.toContain(`z-${inside}`);
});

it("queries Nodes as a Transaction sees them, and reports DOC_NOT_FOUND", async () => {
  const { s, defaultLayerId, rectId } = await withRect("q1");
  const { txId } = ok(await s.begin("agent-a"));
  const staged = ok(
    await s.createNodes([{ ...rect, parentId: defaultLayerId }], "agent-a", { txId }),
  ).createdIds;
  const ids = async (txId?: string) =>
    ok(await s.query({ types: ["rect"] }, "agent-a", txId)).nodes.map((n) => n.id);
  expect(await ids()).toEqual([rectId]);
  expect((await ids(txId)).sort()).toEqual([rectId, ...staged].sort());
  expect(await stub("missing").query({}, "agent-a")).toMatchObject({
    error: { code: "DOC_NOT_FOUND" },
  });
});

it("puts a path_edit's warnings, d and Anchors on its receipt", async () => {
  const { s, rectId } = await withRect("pathedit1");
  expect(ok(await s.pathEdit({ nodeId: rectId, ops: [{ op: "open" }] }, "agent-a"))).toMatchObject({
    updatedIds: [rectId],
    d: expect.stringMatching(/^M 0 0 /),
    subpaths: [{ closed: false }],
    warnings: [{ code: "CONVERTED_TO_PATH", nodeId: rectId }],
  });
});

it("runs a path_op as one Transaction with its PATH_OP_TEXT summary, loading PathKit for offset and divide_below", async () => {
  const s = stub("pathop1");
  const { defaultLayerId } = ok(
    await s.create({ docId: "pathop1", name: "Doc", artboards, actor: "agent-a" }),
  );
  const fills = [{ color: "#FF0000" }];
  const [square = "", circle = ""] = ok(
    await s.createNodes(
      [
        { ...rect, parentId: defaultLayerId, appearance: { fills } },
        { type: "ellipse", parentId: defaultLayerId, x: 2, y: 2, width: 4, height: 4 },
      ],
      "agent-a",
    ),
  ).createdIds;
  const op = (input: PathOpInput) => s.pathOp(input, "agent-a");
  expect(ok(await op({ nodeIds: [square], op: "offset", distance: 1 }))).toMatchObject({
    rev: 3,
    createdIds: [expect.any(String)],
    bounds: { x: -1, y: -1, width: 12, height: 12 },
  });
  expect(ok(await op({ nodeIds: [circle], op: "divide_below" }))).toMatchObject({
    rev: 4,
    deletedIds: [circle],
  });
  ok(await op({ nodeIds: [square], op: "reverse" }));
  expect(ok(await s.changes(2)).changes.map((c) => c.summary)).toEqual([
    "Offset Path",
    "Divide Objects Below",
    "Reverse Path Direction",
  ]);
});

it("loads PathKit for a path_op in GEOMETRY_OPS and for no other", async () => {
  const s = stub("pathop-geometry");
  ok(await s.create({ docId: "pathop-geometry", name: "Doc", artboards, actor: "agent-a" }));
  const ops = Object.keys(PATH_OP_TEXT) as PathOpInput["op"][];
  const loaded = await runInDurableObject(s, async (instance) => {
    const geometry = vi.spyOn(
      instance as unknown as { geometry: () => Promise<unknown> },
      "geometry",
    );
    const out: PathOpInput["op"][] = [];
    for (const op of ops) {
      geometry.mockClear();
      await instance.pathOp({ nodeIds: ["nope"], op }, "agent-a");
      if (geometry.mock.calls.length > 0) out.push(op);
    }
    return out;
  });
  expect(loaded).toEqual([...GEOMETRY_OPS].sort((a, b) => ops.indexOf(a) - ops.indexOf(b)));
  expect(loaded).not.toContain("make_compound_path");
  expect(loaded).not.toContain("reverse");
});

it("runs a Shape Mode on PathKit as one Transaction that one undo takes back, ids and all", async () => {
  const { s, defaultLayerId, rectId } = await withRect("unite1");
  const [otherId = ""] = ok(
    await s.createNodes([{ ...rect, parentId: defaultLayerId, x: 5 }], "agent-a"),
  ).createdIds;
  const united = ok(await s.pathOp({ nodeIds: [rectId, otherId], op: "unite" }, "agent-a"));
  const [unitedId = ""] = united.createdIds;
  expect(united).toMatchObject({
    rev: 4,
    deletedIds: expect.arrayContaining([rectId, otherId]),
    bounds: { x: 0, y: 0, width: 15, height: 10 },
  });
  expect(await layerChildren(s)).toEqual([unitedId]);
  expect(ok(await s.changes(3)).changes.map((c) => c.summary)).toEqual(["Unite"]);
  expect(ok(await s.undo("agent-a"))).toMatchObject({ rev: 5, deletedIds: [unitedId] });
  expect(await layerChildren(s)).toEqual([rectId, otherId]);
  expect(await s.pathOp({ nodeIds: [rectId, "nope"], op: "intersect" }, "agent-a")).toMatchObject({
    error: { code: "NODE_NOT_FOUND", path: "nodeIds[1]" },
  });
  expect(ok(await s.info())).toMatchObject({ rev: 5 });
});

it("makes and releases a Compound Path as one Transaction each, that one undo takes back", async () => {
  const { s, defaultLayerId, rectId } = await withRect("compound1");
  const [innerId = ""] = ok(
    await s.createNodes(
      [{ ...rect, parentId: defaultLayerId, x: 2, y: 2, width: 4, height: 4 }],
      "agent-a",
    ),
  ).createdIds;
  const made = ok(
    await s.pathOp({ nodeIds: [rectId, innerId], op: "make_compound_path" }, "agent-a"),
  );
  const [ringId = ""] = made.createdIds;
  expect(made).toMatchObject({ rev: 4, deletedIds: expect.arrayContaining([rectId, innerId]) });
  expect(await layerChildren(s)).toEqual([ringId]);
  const released = ok(
    await s.pathOp({ nodeIds: [ringId], op: "release_compound_path" }, "agent-a"),
  );
  expect(released).toMatchObject({ rev: 5, deletedIds: [ringId] });
  expect(await layerChildren(s)).toEqual(released.createdIds);
  expect(ok(await s.changes(3)).changes.map((c) => c.summary)).toEqual([
    "Make Compound Path",
    "Release Compound Path",
  ]);
  ok(await s.undo("agent-a"));
  expect(await layerChildren(s)).toEqual([ringId]);
  ok(await s.undo("agent-a"));
  expect(await layerChildren(s)).toEqual([rectId, innerId]);
  expect(
    await s.pathOp({ nodeIds: [rectId], op: "release_compound_path" }, "agent-a"),
  ).toMatchObject({ error: { code: "INVALID_PATH", path: "nodeIds[0]" } });
  expect(ok(await s.info())).toMatchObject({ rev: 7 });
});

it("creates a Column Graph as one Transaction that one undo takes back whole", async () => {
  const { s, defaultLayerId, rectId } = await withRect("chart1");
  const { node } = columnChart({
    parentId: defaultLayerId,
    data: { rows: [{ q: "Q1", a: 1, b: 2 }] },
    encoding: { x: "q", y: ["a", "b"] },
    frame: { x: 0, y: 0, width: 200, height: 100 },
  });
  const made = ok(await s.createNodes([node], "agent-a"));
  expect(made.rev).toBe(3);
  expect(await layerChildren(s)).toEqual([rectId, made.createdIds[0]]);
  const undone = ok(await s.undo("agent-a"));
  expect(undone.rev).toBe(4);
  expect(undone.deletedIds.toSorted()).toEqual(made.createdIds.toSorted());
  expect(await layerChildren(s)).toEqual([rectId]);
});

it("makes and releases a Clipping Mask as one Transaction each, undone and redone like any other", async () => {
  const { s, defaultLayerId, rectId } = await withRect("m1");
  const [clipId = ""] = ok(
    await s.createNodes(
      [{ type: "ellipse", parentId: defaultLayerId, x: 2, y: 2, width: 4, height: 4 }],
      "agent-a",
    ),
  ).createdIds;
  const made = ok(await s.makeMask({ clipNodeId: clipId, contentIds: [rectId] }, "agent-a"));
  const [groupId = ""] = made.createdIds;
  expect(made).toMatchObject({ rev: 4, updatedIds: [rectId, clipId], deletedIds: [] });
  expect(made.bounds).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  const get = async (id: string) => ok(await s.get([id], "full", "agent-a")).nodes[0];
  expect(await get(clipId)).toMatchObject({ parentId: groupId, clipping: true });
  expect(await layerChildren(s)).toEqual([groupId]);

  // The Layers panel's eye on the Clipping Path.
  expect(
    await s.updateNodes([{ nodeId: clipId, patch: { visible: false } }], "user"),
  ).toMatchObject({ error: { code: "INVALID_PATCH" } });

  expect(ok(await s.undo("user"))).toMatchObject({ deletedIds: [groupId] });
  expect(await layerChildren(s)).toEqual([rectId, clipId]);
  const restored = await get(clipId);
  expect(restored).toMatchObject({ parentId: defaultLayerId, appearance: { fills: [{}] } });
  expect(restored && "clipping" in restored).toBe(false);
  ok(await s.redo("user"));
  expect(await get(clipId)).toMatchObject({ parentId: groupId, clipping: true });

  expect(ok(await s.releaseMask([groupId], "agent-a"))).toMatchObject({ updatedIds: [clipId] });
  const released = await get(clipId);
  expect(released && "clipping" in released).toBe(false);
  expect(released).toMatchObject({ parentId: groupId });
});

it("makes a Layer a Clipping Mask in one Transaction, creating nothing, its paint back on undo (ADR-0053)", async () => {
  const { s, defaultLayerId, rectId } = await withRect("m4");
  const [clipId = ""] = ok(
    await s.createNodes(
      [{ type: "ellipse", parentId: defaultLayerId, x: 2, y: 2, width: 4, height: 4 }],
      "agent-a",
    ),
  ).createdIds;
  const get = async (id: string) => ok(await s.get([id], "full", "agent-a")).nodes[0];
  const painted = await get(clipId);
  const made = ok(await s.makeMask({ layerId: defaultLayerId }, "agent-a"));
  expect(made).toMatchObject({ createdIds: [], updatedIds: [clipId], deletedIds: [] });
  expect(await layerChildren(s)).toEqual([rectId, clipId]);
  expect(await get(clipId)).toMatchObject({
    clipping: true,
    appearance: { fills: [], strokes: [] },
  });
  expect((await get(defaultLayerId))?.geometricBounds).toEqual({ x: 2, y: 2, width: 4, height: 4 });

  ok(await s.undo("user"));
  expect(await get(clipId)).toEqual(painted);
  ok(await s.redo("user"));
  expect(await get(clipId)).toMatchObject({ clipping: true });
  ok(await s.releaseMask([defaultLayerId], "agent-a"));
  expect(await get(clipId)).not.toHaveProperty("clipping");
});

it("brings a text Clipping Path's Range Fills back on undo of Make (ADR-0052)", async () => {
  const { s, defaultLayerId, rectId } = await withRect("m3");
  const ranges = [{ start: 0, end: 1, fill: "#FF0000", rotation: 5 }];
  const [textId = ""] = ok(
    await s.createNodes(
      [{ type: "text", parentId: defaultLayerId, x: 0, y: 10, content: "Hi", ranges }],
      "agent-a",
    ),
  ).createdIds;
  ok(await s.makeMask({ clipNodeId: textId, contentIds: [rectId] }, "agent-a"));
  const get = async () => ok(await s.get([textId], "full", "agent-a")).nodes[0];
  expect(await get()).toMatchObject({
    clipping: true,
    ranges: [{ start: 0, end: 1, rotation: 5 }],
  });
  expect(JSON.stringify(await get())).not.toContain("#FF0000");
  ok(await s.undo("user"));
  expect(await get()).toMatchObject({ ranges });
});

it("stages a Clipping Mask in a Transaction until commit", async () => {
  const { s, defaultLayerId, rectId } = await withRect("m2");
  const [clipId = ""] = ok(
    await s.createNodes([{ ...rect, parentId: defaultLayerId }], "agent-a"),
  ).createdIds;
  const { txId } = ok(await s.begin("agent-a"));
  ok(await s.makeMask({ clipNodeId: clipId, contentIds: [rectId] }, "agent-a", { txId }));
  expect(await layerChildren(s)).toEqual([rectId, clipId]);
  expect(await layerChildren(s, txId)).toHaveLength(1);
  ok(await s.commitTx(txId, "agent-a"));
  expect(await layerChildren(s)).toHaveLength(1);
});

it("warns MISSING_GLYPHS in the receipt of a browser create or update Command", async () => {
  const s = stub("glyphs");
  const { defaultLayerId } = ok(
    await s.create({ docId: "glyphs", name: "Doc", artboards, actor: "user" }),
  );
  // A browser Command reaches edit() through the socket; call it directly to read its receipt.
  const edit = (command: object, commandId: string) =>
    runInDurableObject(s, (instance) =>
      (instance as unknown as { edit: (...a: unknown[]) => unknown }).edit(
        command,
        "user",
        commandId,
      ),
    ) as Promise<{ createdIds: string[]; warnings: unknown[] }>;
  const text = { type: "text", parentId: defaultLayerId, x: 10, y: 50, content: "Hi" };
  const created = await edit({ type: "create", nodes: [{ ...text, content: "ก" }] }, "c1");
  const [id] = created.createdIds;
  expect(created.warnings).toEqual([
    expect.objectContaining({ code: "MISSING_GLYPHS", nodeId: id }),
  ]);
  const updated = await edit({ type: "update", nodeId: id, patch: { content: "ขค" } }, "c2");
  expect(updated.warnings).toEqual([
    expect.objectContaining({
      code: "MISSING_GLYPHS",
      nodeId: id,
      message: expect.stringContaining("ข, ค;"),
    }),
  ]);
});

/** A Document with 13 committed 10 × 10 rects in a row, 20 pt apart, at rev 2. */
async function withLetters(docId: string) {
  const s = stub(docId);
  const { defaultLayerId } = ok(await s.create({ docId, name: "Doc", artboards, actor: "a" }));
  const letters = Array.from({ length: 13 }, (_, i) => ({
    ...rect,
    x: i * 20,
    parentId: defaultLayerId,
  }));
  const { createdIds: ids } = ok(await s.createNodes(letters, "agent-a"));
  const transforms = ids.map((id, i) => ({ nodeIds: [id], rotate: i % 2 ? 6 : -7 }));
  const current = async () =>
    ok(await s.get(ids, "full", "user")).nodes.map((n) => (n as { transform: number[] }).transform);
  return { s, ids, transforms, current };
}

it("applies 13 transforms as one Transaction and one undo step (ADR-0070)", async () => {
  const { s, ids, transforms, current } = await withLetters("batch1");
  const receipt = ok(await s.transformNodes({ transforms }, "agent-a", { intent: "tilt" }));
  expect(receipt).toMatchObject({ rev: 3, updatedIds: ids });
  expect(receipt).not.toHaveProperty("failed");
  // Each letter turned about its own centre, so the row's bounds only grow a little.
  expect(receipt.bounds?.x).toBeCloseTo(-0.6, 1);
  expect(receipt.bounds?.width).toBeCloseTo(251.1, 1);
  const turned = await current();
  expect(turned[0]).not.toEqual(turned[1]);
  expect(ok(await s.changes(2)).changes).toMatchObject([
    { rev: 3, txId: receipt.txId, summary: "Transform 13 Nodes", intent: "tilt", updatedIds: ids },
  ]);
  const undone = ok(await s.undo("user"));
  expect(undone.rev).toBe(4);
  expect(undone.updatedIds.toSorted()).toEqual(ids.toSorted());
  expect(await current()).toEqual(ids.map(() => [1, 0, 0, 1, 0, 0]));
});

it("refuses a batch with an unknown id changing nothing, or skips that entry with partial", async () => {
  const { s, ids, transforms } = await withLetters("batch2");
  const bad = transforms.with(1, { nodeIds: ["nope"], rotate: 6 });
  expect(await s.transformNodes({ transforms: bad }, "agent-a")).toMatchObject({
    error: { code: "NODE_NOT_FOUND", path: "transforms[1].nodeIds[0]" },
  });
  expect(await s.info()).toMatchObject({ rev: 2 });
  const receipt = ok(await s.transformNodes({ transforms: bad }, "agent-a", { partial: true }));
  expect(receipt).toMatchObject({
    rev: 3,
    updatedIds: ids.filter((_, i) => i !== 1),
    failed: [{ index: 1, code: "NODE_NOT_FOUND", path: "transforms[1].nodeIds[0]" }],
  });
});

it("stages a batch in an open Transaction, and guards it whole with ifRev", async () => {
  const { s, ids, transforms, current } = await withLetters("batch3");
  expect(await s.transformNodes({ transforms }, "agent-a", { ifRev: 1 })).toMatchObject({
    error: { code: "REV_CONFLICT" },
  });
  expect(await current()).toEqual(ids.map(() => [1, 0, 0, 1, 0, 0]));
  const { txId } = ok(await s.begin("agent-a", "Tilt"));
  expect(ok(await s.transformNodes({ transforms }, "agent-a", { txId, ifRev: 2 }))).toMatchObject({
    txId,
    rev: 2,
    updatedIds: ids,
  });
  expect(await current()).toEqual(ids.map(() => [1, 0, 0, 1, 0, 0]));
  expect(ok(await s.commitTx(txId, "agent-a"))).toMatchObject({ rev: 3, updatedIds: ids });
  expect((await current())[0]).not.toEqual([1, 0, 0, 1, 0, 0]);
});

/** Layer A holds rects r0, r1, r2; Layer B holds an empty Group G; committed at rev 3. */
async function withTwoLayers(docId: string) {
  const s = stub(docId);
  const { defaultLayerId: a } = ok(await s.create({ docId, name: "Doc", artboards, actor: "a" }));
  const rects = [0, 1, 2].map((i) => ({ ...rect, x: i * 20, parentId: a }));
  const { createdIds: ids } = ok(
    await s.createNodes([...rects, { type: "layer", name: "B", clientKey: "B" }], "agent-a"),
  );
  const b = ids[3] as string;
  const {
    createdIds: [g],
  } = ok(await s.createNodes([{ type: "group", parentId: b }], "agent-a"));
  /** Each rect's parent and its position among the parent's children, from the outline. */
  const places = async () => {
    const at = new Map<string, [string | null, number]>();
    type Row = { id: string; children?: Row[] };
    const walk = (rows: Row[], parentId: string | null) =>
      rows.forEach((r, i) => {
        at.set(r.id, [parentId, i]);
        walk(r.children ?? [], r.id);
      });
    walk(ok(await s.outline({ depth: 4 }, "user")).nodes as Row[], null);
    return ids.slice(0, 3).map((id) => at.get(id));
  };
  return { s, a, b, g: g as string, ids: ids.slice(0, 3), places };
}

it("applies three moves as one Transaction and one undo step (ADR-0071)", async () => {
  const { s, a, b, g, ids, places } = await withTwoLayers("reparent1");
  const before = await places();
  const moves = [
    { nodeId: ids[0] as string, parentId: g },
    { nodeId: ids[1] as string, parentId: b, index: 0 },
    { nodeId: ids[2] as string, parentId: a, index: 0 },
  ];
  const receipt = ok(await s.reparentNodes(moves, "agent-a", { intent: "sort" }));
  expect(receipt).toMatchObject({
    rev: 4,
    updatedIds: ids,
    bounds: { x: 0, y: 0, width: 50, height: 10 },
  });
  expect(ok(await s.changes(3)).changes).toMatchObject([
    { rev: 4, txId: receipt.txId, summary: "Reparent 3 Nodes", intent: "sort", updatedIds: ids },
  ]);
  expect(await places()).toEqual([
    [g, 0],
    [b, 0],
    [a, 0],
  ]);
  const undone = ok(await s.undo("user"));
  expect(undone.rev).toBe(5);
  expect(await places()).toEqual(before);
});

it("refuses a batch with one bad move changing nothing, or skips that move with partial", async () => {
  const { s, g, ids, places } = await withTwoLayers("reparent2");
  const before = await places();
  const moves = [
    { nodeId: ids[0] as string, parentId: g },
    { nodeId: ids[1] as string, parentId: null },
    { nodeId: ids[2] as string, parentId: g, before: ids[0] as string },
  ];
  expect(await s.reparentNodes(moves, "agent-a")).toMatchObject({
    error: { code: "INVALID_PARENT", path: "moves[1].parentId" },
  });
  expect(await s.info()).toMatchObject({ rev: 3 });
  expect(await places()).toEqual(before);
  const receipt = ok(await s.reparentNodes(moves, "agent-a", { partial: true }));
  expect(receipt).toMatchObject({
    rev: 4,
    updatedIds: [ids[0], ids[2]],
    failed: [{ index: 1, code: "INVALID_PARENT", path: "moves[1].parentId" }],
  });
  const kids = ok(await s.outline({ depth: 3 }, "agent-a")).nodes[1]?.children?.[0]?.children;
  expect(kids?.map((n) => n.id)).toEqual([ids[2], ids[0]]);
});

it("stages moves in an open Transaction, and guards them with ifRev", async () => {
  const { s, g, ids, places } = await withTwoLayers("reparent3");
  const before = await places();
  const moves = [{ nodeId: ids[0] as string, parentId: g }];
  expect(await s.reparentNodes(moves, "agent-a", { ifRev: 2 })).toMatchObject({
    error: { code: "REV_CONFLICT" },
  });
  const { txId } = ok(await s.begin("agent-a", "Sort"));
  expect(ok(await s.reparentNodes(moves, "agent-a", { txId, ifRev: 3 }))).toMatchObject({
    txId,
    rev: 3,
    updatedIds: [ids[0]],
  });
  expect(await places()).toEqual(before);
  expect(ok(await s.commitTx(txId, "agent-a"))).toMatchObject({ rev: 4, updatedIds: [ids[0]] });
  expect((await places())[0]?.[0]).toBe(g);
});

/** Layer L holds Groups g1 and g2; the Document is at rev 2. */
async function withGroups(docId: string) {
  const s = stub(docId);
  const { defaultLayerId: l } = ok(await s.create({ docId, name: "Doc", artboards, actor: "a" }));
  const [g1 = "", g2 = ""] = ok(
    await s.createNodes(
      [
        { type: "group", parentId: l },
        { type: "group", parentId: l },
      ],
      "agent-a",
    ),
  ).createdIds;
  return { s, l, g1, g2 };
}

/** Exports `s` as `.kalamo.json` and opens the text as a new Document, as doc_open does. */
async function reopens(s: ReturnType<typeof stub>, docId: string) {
  const { text } = ok(await s.file("user"));
  const file = await resolveImages(parseDocument(text));
  ok(await stub(docId).open({ docId, ...file, actor: "agent-a" }));
  expect(ok(await stub(docId).file("user")).text).toBe(text);
}

it("refuses a commit whose move makes a cycle with one committed meanwhile, keeping the Transaction open (ADR-0072)", async () => {
  const { s, g1, g2 } = await withGroups("tree1");
  const { txId } = ok(await s.begin("agent-a"));
  ok(await s.reparentNodes([{ nodeId: g1, parentId: g2 }], "agent-a", { txId }));
  ok(await s.reparentNodes([{ nodeId: g2, parentId: g1 }], "agent-b"));
  // The Transaction's view is a cycle now, so its writes fail the same way instead of walking it.
  expect(await s.deleteNodes([g1], "agent-a", { txId })).toMatchObject({
    error: { code: "TREE_CONFLICT", nodeIds: [g1] },
  });
  expect(await s.commitTx(txId, "agent-a")).toMatchObject({
    error: {
      code: "TREE_CONFLICT",
      nodeIds: [g1],
      hint: expect.stringContaining("kalamo_tx_rollback"),
    },
  });
  expect(await s.info()).toMatchObject({ rev: 3 });
  ok(await s.rollback(txId, "agent-a"));
  await reopens(s, "tree1-copy");
});

it("commits two Transactions' creates on top of one Layer in commit order (ADR-0072)", async () => {
  const { s, l, g1, g2 } = await withGroups("tree2");
  const a = ok(await s.begin("agent-a")).txId;
  const b = ok(await s.begin("agent-b")).txId;
  const [x] = ok(
    await s.createNodes([{ ...rect, parentId: l }], "agent-a", { txId: a }),
  ).createdIds;
  const [y] = ok(
    await s.createNodes([{ ...rect, parentId: l }], "agent-b", { txId: b }),
  ).createdIds;
  ok(await s.commitTx(b, "agent-b"));
  ok(await s.commitTx(a, "agent-a"));
  expect(await layerChildren(s)).toEqual([g1, g2, y, x]);
  ok(await s.reparentNodes([{ nodeId: g1, parentId: l, before: x as string }], "agent-a"));
  expect(await layerChildren(s)).toEqual([g2, y, g1, x]);
  await reopens(s, "tree2-copy");
});

it("refuses a staged delete of the last top-level Layer, and a commit that meets a delete made meanwhile (ADR-0073)", async () => {
  const s = stub("last-layer");
  const { defaultLayerId: l1 } = ok(
    await s.create({ docId: "last-layer", name: "Doc", artboards, actor: "a" }),
  );
  const [l2 = ""] = ok(await s.createNodes([{ type: "layer" }], "agent-a")).createdIds;
  const { txId } = ok(await s.begin("agent-a"));
  ok(await s.deleteNodes([l1], "agent-a", { txId }));
  expect(await s.deleteNodes([l2], "agent-a", { txId })).toMatchObject({
    error: { code: "LAST_LAYER", nodeIds: [l2] },
  });
  ok(await s.deleteNodes([l2], "agent-b"));
  const { rev } = ok(await s.info());
  expect(await s.commitTx(txId, "agent-a")).toMatchObject({
    error: {
      code: "TREE_CONFLICT",
      nodeIds: [l1],
      message: expect.stringContaining(`${l1}: No top-level Layer would remain.`),
      hint: expect.stringContaining("kalamo_tx_rollback"),
    },
  });
  expect(await s.info()).toMatchObject({ rev });
  ok(await s.rollback(txId, "agent-a"));
  const { nodes } = ok(await s.outline({ depth: 1 }, "agent-a"));
  expect(nodes.map((n) => n.id)).toEqual([l1]);
  await reopens(s, "last-layer-copy");
});

it("skips an undone move that would now make a cycle, and names it in doc_changes (ADR-0072)", async () => {
  const { s, l, g1, g2 } = await withGroups("tree3");
  ok(await s.reparentNodes([{ nodeId: g1, parentId: g2 }], "agent-a"));
  ok(await s.reparentNodes([{ nodeId: g1, parentId: l }], "agent-a"));
  // A move of g2 into g1 that is not on the undo stack, as another Actor's would be with per-Actor
  // undo (ADR-0011); a linear stack cannot reach this yet.
  await runInDurableObject(s, (_, state) => {
    const { json } = state.storage.sql
      .exec<{ json: string }>("SELECT json FROM nodes WHERE id = ?", g2)
      .one();
    const moved = { ...JSON.parse(json), parentId: g1 };
    state.storage.sql.exec("UPDATE nodes SET json = ? WHERE id = ?", JSON.stringify(moved), g2);
  });
  expect(ok(await s.undo("user"))).toMatchObject({ rev: 5, updatedIds: [] });
  expect(ok(await s.changes(4)).changes).toMatchObject([
    {
      rev: 5,
      actor: "user",
      summary: expect.stringContaining(`skipped, deleted or moved since: ${g1}`),
    },
  ]);
  await reopens(s, "tree3-copy");
});

it("restacks in two parents as one Transaction, one receipt and one undo step (ADR-0074)", async () => {
  const { s, a, b, ids, places } = await withTwoLayers("reorder1");
  const layers = async () => ok(await s.outline({ depth: 1 }, "user")).nodes.map((n) => n.id);
  const before = { places: await places(), layers: await layers() };
  expect(before.layers).toEqual([a, b]);
  const nodeIds = [ids[2] as string, b];
  const receipt = ok(await s.reorderNodes(nodeIds, "back", "agent-a", { intent: "tidy" }));
  expect(receipt).toMatchObject({ rev: 4, updatedIds: nodeIds });
  expect(ok(await s.changes(3)).changes).toMatchObject([
    { rev: 4, txId: receipt.txId, summary: "Send to Back", intent: "tidy", updatedIds: nodeIds },
  ]);
  expect(await places()).toEqual([
    [a, 1],
    [a, 2],
    [a, 0],
  ]);
  expect(await layers()).toEqual([b, a]);
  expect(ok(await s.undo("user")).rev).toBe(5);
  expect({ places: await places(), layers: await layers() }).toEqual(before);
});

it("duplicates as one Transaction, one receipt with the id map, and one undo step (ADR-0076)", async () => {
  const { s, a, b, g, ids } = await withTwoLayers("duplicate1");
  const [r0, r1] = ids as [string, string];
  const size = async () => ok(await s.info()).nodeCount;
  const before = await size();
  const receipt = ok(
    await s.duplicateNodes({ nodeIds: [r0, g], offset: { x: 5, y: 0 }, count: 2 }, "agent-a", {
      intent: "repeat",
    }),
  );
  expect(receipt).toMatchObject({ rev: 4, updatedIds: [], deletedIds: [] });
  expect(Object.keys(receipt.copies)).toEqual([r0, g]);
  const [c1, c2] = receipt.copies[r0] as [string, string];
  expect(receipt.createdIds).toEqual(
    expect.arrayContaining([c1, c2, ...(receipt.copies[g] ?? [])]),
  );
  expect(receipt.createdIds).toHaveLength(4);
  // The copies of the empty Group have no bounds; the rect's are at x 5 and 10.
  expect(receipt.bounds).toEqual({ x: 5, y: 0, width: 15, height: 10 });
  const [g1, g2] = receipt.copies[g] as [string, string];
  expect(receipt.geometricBounds).toEqual({
    [c1]: { x: 5, y: 0, width: 10, height: 10 },
    [c2]: { x: 10, y: 0, width: 10, height: 10 },
    [g1]: null,
    [g2]: null,
  });
  expect(ok(await s.changes(3)).changes).toMatchObject([
    { rev: 4, txId: receipt.txId, summary: "Duplicate 4 Nodes", intent: "repeat" },
  ]);
  type Row = { id: string; children?: Row[] };
  const outline = async () => ok(await s.outline({ depth: 3 }, "user")).nodes as Row[];
  const [layerA, layerB] = await outline();
  expect(layerA?.children?.map((n) => n.id)).toEqual([r0, c1, c2, r1, ids[2]]);
  expect(layerB?.id).toBe(b);
  expect(layerB?.children?.map((n) => n.id)).toEqual([g, ...(receipt.copies[g] ?? [])]);
  const { nodes } = ok(await s.get([c1, c2], "concise", "user"));
  expect(nodes.map((n) => n.geometricBounds?.x)).toEqual([5, 10]);
  expect(await size()).toBe(before + 4);
  expect(ok(await s.undo("user")).deletedIds.sort()).toEqual([...receipt.createdIds].sort());
  expect(await size()).toBe(before);
  expect(a).toBeTruthy();
});

it("gives a transformed original's copies their document-space bounds (#235)", async () => {
  const { s, ids } = await withTwoLayers("duplicate3");
  const [r0, r1] = ids as [string, string];
  ok(await s.transformNodes({ nodeIds: [r0], rotate: 30 }, "agent-a"));
  ok(await s.transformNodes({ nodeIds: [r1], translate: { x: 100, y: 7 } }, "agent-a"));
  const input = { nodeIds: [r0, r1], offset: { x: 0, y: 25 }, count: 2 };
  const receipt = ok(await s.duplicateNodes(input, "agent-a"));
  const at = async (id: string) =>
    ok(await s.get([id], "concise", "user")).nodes[0]?.geometricBounds;
  for (const id of [r0, r1]) {
    const from = (await at(id)) as Rect;
    for (const [i, c] of (receipt.copies[id] ?? []).entries()) {
      // The receipt's bounds are a node_get's, and the original's moved by k × offset.
      expect(receipt.geometricBounds[c]).toEqual(await at(c));
      const shifted = { ...from, y: from.y + 25 * (i + 1) };
      for (const [key, value] of Object.entries(shifted))
        expect(receipt.geometricBounds[c]?.[key as keyof Rect]).toBeCloseTo(value, 9);
    }
  }
  expect(receipt.geometricBounds[receipt.copies[r1]?.[0] as string]).toMatchObject({
    x: 120,
    y: 32,
  });
});

it("refuses a duplicate with its code and path, writing nothing (ADR-0076)", async () => {
  const { s, b, g, ids } = await withTwoLayers("duplicate2");
  const r0 = ids[0] as string;
  for (const [input, error] of [
    [{ nodeIds: [r0, "nope"] }, { code: "NODE_NOT_FOUND", path: "nodeIds[1]" }],
    [
      { nodeIds: [r0], targetParentId: "nope" },
      { code: "NODE_NOT_FOUND", path: "targetParentId" },
    ],
    [
      { nodeIds: [b], targetParentId: g },
      { code: "INVALID_PARENT", path: "targetParentId" },
    ],
    [
      { nodeIds: [b], targetParentId: b },
      { code: "INVALID_PARENT", path: "targetParentId" },
    ],
  ] satisfies [DuplicateInput, object][]) {
    expect(await s.duplicateNodes(input, "agent-a")).toMatchObject({ error });
  }
  expect(await s.info()).toMatchObject({ rev: 3 });
});

it("refuses an unknown id at nodeIds[i] changing nothing, and lists no Node that stays put", async () => {
  const { s, ids, places } = await withTwoLayers("reorder2");
  const before = await places();
  expect(await s.reorderNodes([ids[0] as string, "nope"], "front", "agent-a")).toMatchObject({
    error: { code: "NODE_NOT_FOUND", path: "nodeIds[1]" },
  });
  expect(await s.info()).toMatchObject({ rev: 3 });
  expect(await places()).toEqual(before);
  const receipt = ok(await s.reorderNodes([ids[2] as string], "forward", "agent-a"));
  // Committed, as a write that changes nothing is elsewhere (ADR-0074).
  expect(receipt).toMatchObject({ rev: 4, updatedIds: [], createdIds: [], deletedIds: [] });
  expect(await places()).toEqual(before);
});

it("aligns a text's receipt bounds, node_update moving them and null restoring left (ADR-0077)", async () => {
  const s = stub("align");
  const { defaultLayerId } = ok(
    await s.create({ docId: "align", name: "Doc", artboards, actor: "agent-a" }),
  );
  const text = { type: "text", parentId: defaultLayerId, x: 100, y: 50, content: "HHHH" } as const;
  const created = ok(await s.createNodes([{ ...text, alignment: "center" }], "agent-a"));
  const centred = created.bounds as { x: number; width: number };
  expect(centred.x + centred.width / 2).toBeCloseTo(100, 6);
  const [id = ""] = created.createdIds;
  const full = async () =>
    (ok(await s.get([id], "full", "agent-a")).nodes[0] ?? {}) as {
      alignment?: string;
      bounds: object;
    };
  expect(await full()).toMatchObject({ alignment: "center" });

  const left = ok(await s.createNodes([text], "agent-a"));
  const leftBounds = left.bounds as { x: number; width: number };
  expect(leftBounds.x).toBeCloseTo(100, 0);
  const [leftId = ""] = left.createdIds;
  expect(ok(await s.get([leftId], "full", "agent-a")).nodes[0]).not.toHaveProperty("alignment");

  ok(await s.updateNodes([{ nodeId: leftId, patch: { alignment: "right" } }], "agent-a"));
  const right = ok(await s.get([leftId], "full", "agent-a")).nodes[0] as unknown as {
    geometricBounds: { x: number; width: number };
  };
  expect(right.geometricBounds.x + right.geometricBounds.width).toBeCloseTo(100, 0);
  ok(await s.updateNodes([{ nodeId: leftId, patch: { alignment: null } }], "agent-a"));
  const restored = ok(await s.get([leftId], "full", "agent-a")).nodes[0] as unknown as {
    geometricBounds: object;
  };
  expect(restored).not.toHaveProperty("alignment");
  expect(restored.geometricBounds).toEqual(leftBounds);
});

it("gives each written Area Type's shown lines' bounds in the receipt, so a box can fit them (#230)", async () => {
  const s = stub("line-bounds");
  const { defaultLayerId: parentId } = ok(
    await s.create({ docId: "line-bounds", name: "Doc", artboards, actor: "agent-a" }),
  );
  const area = {
    type: "text",
    kind: "area",
    parentId,
    x: 10,
    y: 20,
    width: 15,
    height: 200,
  } as const;
  const created = ok(
    await s.createNodes(
      [
        { ...area, content: "Hi Hi", fontSize: 12 },
        { type: "rect", parentId, x: 0, y: 0, width: 5, height: 5 },
      ],
      "agent-a",
    ),
  );
  const [id = "", rectId = ""] = created.createdIds;
  const lines = linesBox({ ...area, content: "Hi Hi", fontSize: 12 });
  expect(created.lineBounds).toEqual({ [id]: lines });
  expect(created.lineBounds).not.toHaveProperty(rectId);
  // Two lines in a 200 pt frame end far above its bottom, which `bounds` reaches.
  expect((lines?.y ?? 0) + (lines?.height ?? 0)).toBeLessThan(60);
  expect(created.bounds).toMatchObject({ y: 0, height: 220 });

  const moved = ok(await s.transformNodes({ nodeIds: [id], translate: { x: 5 } }, "agent-a"));
  expect(moved.lineBounds).toEqual({ [id]: { ...lines, x: 15 } });
  const short = ok(await s.updateNodes([{ nodeId: id, patch: { height: 5 } }], "agent-a"));
  expect(short.lineBounds).toEqual({ [id]: null });
  const rect = ok(await s.updateNodes([{ nodeId: rectId, patch: { name: "Box" } }], "agent-a"));
  expect(rect).not.toHaveProperty("lineBounds");
});

it("flows Area Type in a closed Live Shape by frameNodeId, deleting it, and undo restores it (ADR-0078)", async () => {
  const s = stub("frame");
  const { defaultLayerId: parentId } = ok(
    await s.create({ docId: "frame", name: "Doc", artboards, actor: "agent-a" }),
  );
  const [ellipseId = ""] = ok(
    await s.createNodes(
      [
        {
          type: "ellipse",
          parentId,
          x: 10,
          y: 10,
          width: 60,
          height: 40,
          appearance: { fills: [{ color: "#FF0000" }] },
        },
      ],
      "agent-a",
    ),
  ).createdIds;
  const receipt = ok(
    await s.createNodes(
      [
        {
          type: "text",
          kind: "area",
          parentId,
          frameNodeId: ellipseId,
          content: "Words that flow in the ellipse and far more words than it can ever hold at all",
        },
      ],
      "agent-a",
    ),
  );
  expect(receipt.deletedIds).toEqual([ellipseId]);
  expect(receipt.createdIds).toHaveLength(1);
  expect(receipt.warnings).toEqual([expect.objectContaining({ code: "TEXT_OVERFLOW" })]);
  const [text] = ok(await s.get(receipt.createdIds, "full", "agent-a")).nodes as unknown as {
    kind: string;
    frame: string;
    geometricBounds: { x: number; width: number };
  }[];
  expect(text).toMatchObject({ kind: "area", frame: expect.stringMatching(/^M .* Z$/) });
  expect(text?.geometricBounds).toMatchObject({ x: 10, width: 60 });

  ok(await s.undo("agent-a"));
  const [back] = ok(await s.get([ellipseId], "full", "agent-a")).nodes as unknown as {
    appearance: { fills: { color: string }[] };
  }[];
  expect(back?.appearance.fills[0]?.color).toBe("#FF0000");
  expect("error" in (await s.get(receipt.createdIds, "concise", "agent-a"))).toBe(true);
});

it("undoes a Convert to Point Type, restoring the overflow it deleted (ADR-0079)", async () => {
  const s = stub("convert-undo");
  const { defaultLayerId } = ok(
    await s.create({ docId: "convert-undo", name: "Doc", artboards, actor: "a" }),
  );
  const text = {
    type: "text" as const,
    kind: "area" as const,
    parentId: defaultLayerId,
    x: 0,
    y: 0,
    width: 50,
    height: 30,
    content: "one two three four five six",
    ranges: [{ start: 16, end: 24, baselineShift: 2 }],
  };
  const [id] = ok(await s.createNodes([text], "user")).createdIds as [string];
  const full = async () => ok(await s.get([id], "full", "user")).nodes[0];
  const before = await full();
  const receipt = ok(await s.updateNodes([{ nodeId: id, patch: { kind: "point" } }], "user"));
  expect(receipt.warnings).toMatchObject([{ code: "TEXT_DISCARDED", nodeId: id }]);
  expect(await full()).toMatchObject({ kind: "point", content: "one two\nthree four " });
  expect(receipt.bounds).toEqual((await full())?.geometricBounds);
  ok(await s.undo("user"));
  expect(await full()).toEqual(before);
});

it("warns TEXT_OVERFLOW in each create and update receipt while an Area Type does not fit", async () => {
  const s = stub("overflow");
  const { defaultLayerId } = ok(
    await s.create({ docId: "overflow", name: "Doc", artboards, actor: "a" }),
  );
  const text = {
    type: "text" as const,
    kind: "area" as const,
    parentId: defaultLayerId,
    x: 10,
    y: 10,
    width: 100,
    height: 20,
    content: "one\ntwo\nthree",
  };
  const created = ok(await s.createNodes([text], "a"));
  const [id] = created.createdIds as [string];
  expect(created.warnings).toEqual([
    expect.objectContaining({ code: "TEXT_OVERFLOW", nodeId: id }),
  ]);
  const update = async (height: number) =>
    ok(await s.updateNodes([{ nodeId: id, patch: { height } }], "a")).warnings;
  expect(await update(80)).toEqual([]);
  expect(await update(30)).toEqual([
    expect.objectContaining({ code: "TEXT_OVERFLOW", nodeId: id }),
  ]);
});

it("undoes and redoes an Auto Size refit, restoring the height and flag (ADR-0092)", async () => {
  const s = stub("auto-size-undo");
  const { defaultLayerId } = ok(
    await s.create({ docId: "auto-size-undo", name: "Doc", artboards, actor: "a" }),
  );
  const text = {
    type: "text" as const,
    kind: "area" as const,
    parentId: defaultLayerId,
    x: 0,
    y: 0,
    width: 50,
    autoSize: true,
    content: "one",
  };
  const [id] = ok(await s.createNodes([text], "user")).createdIds as [string];
  const full = async () => ok(await s.get([id], "full", "user")).nodes[0];
  const before = await full();
  expect(before).toMatchObject({ autoSize: true, height: 14.4 });
  ok(await s.updateNodes([{ nodeId: id, patch: { content: "one\ntwo" } }], "user"));
  const grown = await full();
  expect(grown).toMatchObject({ autoSize: true, height: 28.8 });
  ok(await s.updateNodes([{ nodeId: id, patch: { height: 40 } }], "user"));
  expect(await full()).not.toHaveProperty("autoSize");
  ok(await s.undo("user"));
  expect(await full()).toEqual(grown);
  ok(await s.undo("user"));
  expect(await full()).toEqual(before);
  ok(await s.redo("user"));
  expect(await full()).toEqual(grown);
});

it("writes several Nodes' paints from the Gradient panel as one Transaction and one undo step (ADR-0081)", async () => {
  const s = stub("appearance");
  const { defaultLayerId } = ok(
    await s.create({ docId: "appearance", name: "Doc", artboards, actor: "user" }),
  );
  const { createdIds: ids } = ok(
    await s.createNodes(
      [0, 1].map((i) => ({ ...rect, x: i * 20, parentId: defaultLayerId })),
      "user",
    ),
  );
  const edit = (command: object, commandId: string) =>
    runInDurableObject(s, (instance) =>
      (instance as unknown as { edit: (...a: unknown[]) => unknown }).edit(
        command,
        "user",
        commandId,
      ),
    ) as Promise<{ rev: number; updatedIds: string[] } | { error: { code: string } }>;
  const stops = [
    { offset: 0, color: "#FFFFFF", midpoint: 0.3 },
    { offset: 1, color: "#000000" },
  ];
  const fills = [{ type: "gradient", gradient: { type: "linear", stops } }];
  const paints = async () =>
    ok(await s.get(ids, "full", "user")).nodes.map(
      (n) => (n as { appearance: { fills: unknown[] } }).appearance.fills,
    );
  const before = await paints();
  const updates = ids.map((nodeId) => ({ nodeId, appearance: { fills } }));
  expect(await edit({ type: "appearance", updates }, "c1")).toMatchObject({
    rev: 3,
    updatedIds: ids,
  });
  expect(
    (await paints()).map((f) => (f[0] as { gradient: { stops: unknown } }).gradient.stops),
  ).toEqual([stops, stops]);
  // Core refuses what the schema lets through, such as a colour name, and nothing changes.
  const red = [
    {
      type: "gradient",
      gradient: { type: "linear", stops: [stops[0], { offset: 1, color: "red" }] },
    },
  ];
  expect(
    await edit(
      { type: "appearance", updates: [{ nodeId: ids[0], appearance: { fills: red } }] },
      "c2",
    ),
  ).toMatchObject({ error: { code: "INVALID_COLOR" } });
  expect(await s.info()).toMatchObject({ rev: 3 });
  expect(ok(await s.undo("user"))).toMatchObject({ rev: 4 });
  expect(await paints()).toEqual(before);
});
