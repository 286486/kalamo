import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
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
      hint: expect.stringContaining("zibel_doc_changes"),
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
  const { txId } = ok(await s.begin("agent-a"));
  ok(await s.createNodes([{ ...rect, parentId: defaultLayerId }], "agent-a", { txId }));
  ok(await s.updateNodes([{ nodeId: rectId, patch: { name: "x" } }], "agent-a", { txId }));
  ok(await s.deleteNodes([rectId], "agent-a", { txId }));
  expect(ok(await s.rollback(txId, "agent-a"))).toEqual({ txId, rev: 2 });
  expect(ok(await s.outline({ depth: 3 }, "agent-a"))).toEqual(before);
  expect(await s.info()).toMatchObject({ rev: 2 });
  expect(
    await s.createNodes([{ ...rect, parentId: defaultLayerId }], "agent-a", { txId }),
  ).toMatchObject({ error: { code: "TX_EXPIRED", hint: expect.stringContaining("rolled back") } });
  expect(await s.rollback(txId, "agent-a")).toMatchObject({ error: { code: "TX_EXPIRED" } });
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
  const { svg } = ok(await stub("ids").raster("agent-a", { scale: 1, overlays: ["ids"] }));
  expect(receipt.createdIds).toHaveLength(3);
  for (const id of receipt.createdIds) expect(svg).toContain(`>${id}</text>`);
  expect(svg).not.toContain(`>${parentId}</text>`);
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
