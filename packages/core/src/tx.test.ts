import { describe, expect, it } from "vitest";
import { createDocument, createNodes } from "./document.ts";
import { deleteNodes, reparentNodes, transformNodes, updateNodes } from "./edit.ts";
import { KalamoError } from "./errors.ts";
import { parseDocument, serializeDocument } from "./file.ts";
import { makeMask } from "./mask.ts";
import { convertToPath } from "./path-op.ts";
import { placeNodes } from "./place.ts";
import type { Document, Node, ShapeNode } from "./schema.ts";
import { commitTransaction, type DeltaRow, overlay, revert, type TxRow } from "./tx.ts";

const setup = () => {
  const { doc, defaultLayerId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100 }],
  });
  const [rect, group, child] = createNodes(doc, [
    { type: "rect", parentId: defaultLayerId, x: 0, y: 0, width: 10, height: 10, name: "a" },
    {
      type: "group",
      parentId: defaultLayerId,
      appearance: { strokes: [{ color: "#FF0000", width: 2 }] },
      children: [{ type: "ellipse", x: 0, y: 0, width: 5, height: 5 }],
    },
  ]).nodes as [ShapeNode, Node, ShapeNode];
  return { doc, defaultLayerId, rect, group, child };
};

const copy = (doc: Document): Document => ({ ...doc, nodes: new Map(doc.nodes) });

const nodeGone = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof KalamoError) return e.data;
    throw e;
  }
  throw new Error("expected a KalamoError");
};

describe("overlay", () => {
  it("lays working copies over the committed Document and leaves it untouched", () => {
    const { doc, rect, child } = setup();
    const renamed = { ...rect, name: "b" };
    const view = overlay(doc, [
      { id: rect.id, base: rect, working: renamed },
      { id: child.id, base: child, working: null },
    ]);
    expect(view.nodes.get(rect.id)).toEqual(renamed);
    expect(view.nodes.has(child.id)).toBe(false);
    expect(doc.nodes.get(rect.id)).toBe(rect);
    expect(doc.nodes.has(child.id)).toBe(true);
  });
});

describe("commitTransaction", () => {
  it("applies only the keys the Transaction changed onto the Node as committed now", () => {
    const { doc, rect } = setup();
    const appearance = { fills: [{ type: "solid" as const, color: "#FF0000FF" }], strokes: [] };
    const working = { ...rect, appearance };
    // A person renamed it after the Transaction touched it.
    doc.nodes.set(rect.id, { ...rect, name: "z" });
    const { updated } = commitTransaction(doc, [{ id: rect.id, base: rect, working }]);
    expect(doc.nodes.get(rect.id)).toMatchObject({ name: "z", appearance });
    expect(updated.map((n) => n.id)).toEqual([rect.id]);
  });

  it("compares values structurally, so reordered keys are not a change", () => {
    const { doc, rect } = setup();
    const { fills, strokes } = rect.appearance;
    const working = { ...rect, appearance: { strokes, fills }, name: "b" };
    const personal = { fills: [], strokes: [] };
    doc.nodes.set(rect.id, { ...rect, appearance: personal });
    commitTransaction(doc, [{ id: rect.id, base: rect, working }]);
    expect(doc.nodes.get(rect.id)).toMatchObject({ name: "b", appearance: personal });
  });

  it("removes a key the Transaction removed", () => {
    const { doc, rect } = setup();
    const base = { ...rect, radius: 4 } as Node;
    doc.nodes.set(rect.id, base);
    const { radius: _, ...working } = base as ShapeNode & { radius?: number };
    commitTransaction(doc, [{ id: rect.id, base, working: working as Node }]);
    expect(doc.nodes.get(rect.id)).not.toHaveProperty("radius");
  });

  it("classifies rows as created, updated or deleted and skips created-then-deleted", () => {
    const { doc, rect, child } = setup();
    const before = copy(doc);
    const fresh = { ...rect, id: "new" };
    const { created, updated, deletedIds } = commitTransaction(doc, [
      { id: "new", base: null, working: fresh },
      { id: "tmp", base: null, working: null },
      { id: rect.id, base: rect, working: { ...rect, name: "b" } },
      { id: child.id, base: child, working: null },
    ]);
    expect(created.map((n) => n.id)).toEqual(["new"]);
    expect(updated.map((n) => n.id)).toEqual([rect.id]);
    expect(deletedIds).toEqual([child.id]);
    expect(doc.nodes.has("new")).toBe(true);
    expect(doc.nodes.has("tmp")).toBe(false);
    expect(doc.nodes.has(child.id)).toBe(false);
    expect(doc.nodes.size).toBe(before.nodes.size);
  });

  it("deletes a deleted Node's descendants as committed at commit time", () => {
    const { doc, group, child } = setup();
    // Someone added a second child after the Transaction deleted the Group.
    const late = { ...child, id: "late" };
    doc.nodes.set(late.id, late);
    const { deletedIds } = commitTransaction(doc, [
      { id: group.id, base: group, working: null },
      { id: child.id, base: child, working: null },
    ]);
    expect(new Set(deletedIds)).toEqual(new Set([group.id, child.id, "late"]));
    expect(deletedIds).toHaveLength(3);
    expect(doc.nodes.has("late")).toBe(false);
  });

  it("treats a Node deleted both inside and outside as deleted, not gone", () => {
    const { doc, child } = setup();
    doc.nodes.delete(child.id);
    const { deletedIds } = commitTransaction(doc, [{ id: child.id, base: child, working: null }]);
    expect(deletedIds).toEqual([]);
  });

  it("fails with NODE_GONE and changes nothing when an edited Node was deleted outside", () => {
    const { doc, rect, child } = setup();
    doc.nodes.delete(rect.id);
    const before = copy(doc);
    const rows: TxRow[] = [
      { id: child.id, base: child, working: { ...child, name: "c" } },
      { id: rect.id, base: rect, working: { ...rect, name: "b" } },
    ];
    expect(nodeGone(() => commitTransaction(doc, rows))).toMatchObject({
      code: "NODE_GONE",
      nodeIds: [rect.id],
    });
    expect(doc.nodes).toEqual(before.nodes);
  });

  it("fails with NODE_GONE listing a created Node's parent that was deleted outside", () => {
    const { doc, group, child } = setup();
    doc.nodes.delete(group.id);
    doc.nodes.delete(child.id);
    const fresh = { ...child, id: "new", parentId: group.id };
    expect(
      nodeGone(() => commitTransaction(doc, [{ id: "new", base: null, working: fresh }])),
    ).toMatchObject({ code: "NODE_GONE", nodeIds: [group.id] });
    expect(doc.nodes.has("new")).toBe(false);
  });

  it("commits a created Node whose parent was created in the same Transaction", () => {
    const { doc, group, child } = setup();
    const g = { ...group, id: "g" };
    const c = { ...child, id: "c", parentId: "g" };
    const { created } = commitTransaction(doc, [
      { id: "g", base: null, working: g },
      { id: "c", base: null, working: c },
    ]);
    expect(created.map((n) => n.id)).toEqual(["g", "c"]);
  });
});

/** What a commit changed, one row per Node, as the Document DO records it. */
const diff = (before: Document, after: Document): DeltaRow[] =>
  [...new Set([...before.nodes.keys(), ...after.nodes.keys()])]
    .map((id) => ({ id, before: before.nodes.get(id) ?? null, after: after.nodes.get(id) ?? null }))
    .filter((r) => r.before !== r.after);

it("drops an overlay's edit to a Live Shape parameter once the shape was converted meanwhile", () => {
  const { doc, rect } = setup();
  const working = { ...rect, width: 20, name: "b" } as ShapeNode;
  convertToPath(doc, [rect.id]);
  commitTransaction(doc, [{ id: rect.id, base: rect, working }]);
  const node = doc.nodes.get(rect.id);
  expect(node).toMatchObject({ type: "path", name: "b" });
  expect(node).not.toHaveProperty("width");
});

it("lists a Node named twice once", () => {
  const { doc, rect } = setup();
  expect(convertToPath(doc, [rect.id, rect.id]).updated).toHaveLength(1);
});

describe("revert", () => {
  const edits: [string, (doc: Document, s: ReturnType<typeof setup>) => void][] = [
    [
      "a create with an inline child",
      (doc, { defaultLayerId }) =>
        createNodes(doc, [
          {
            type: "group",
            parentId: defaultLayerId,
            children: [{ type: "rect", x: 1, y: 1, width: 2, height: 2 }],
          },
        ]),
    ],
    ["an update", (doc, { rect }) => updateNodes(doc, [{ nodeId: rect.id, patch: { name: "b" } }])],
    [
      "a transform",
      (doc, { rect, group }) => transformNodes(doc, { nodeIds: [rect.id, group.id], rotate: 30 }),
    ],
    ["a Convert to Path", (doc, { rect }) => convertToPath(doc, [rect.id])],
    [
      "an update that sets a Layer's appearance and clears a Group's",
      (doc, { defaultLayerId, group }) =>
        updateNodes(doc, [
          { nodeId: defaultLayerId, patch: { appearance: { fills: [{ color: "#00FF00" }] } } },
          { nodeId: group.id, patch: { appearance: null } },
        ]),
    ],
    [
      "a scale of a Group with a Stroke",
      (doc, { group }) => transformNodes(doc, { nodeIds: [group.id], scale: 3 }),
    ],
    [
      "a gradient on a Group, then a turn that maps it",
      (doc, { group }) => {
        const stops = [
          { offset: 0, color: "#000000" },
          { offset: 1, color: "#FFFFFF" },
        ];
        updateNodes(doc, [
          {
            nodeId: group.id,
            patch: {
              appearance: { fills: [{ type: "gradient", gradient: { type: "radial", stops } }] },
            },
          },
        ]);
        transformNodes(doc, { nodeIds: [group.id], rotate: 30, scale: { x: 2, y: 1 } });
      },
    ],
    ["a delete of a Group", (doc, { group }) => deleteNodes(doc, [group.id])],
    [
      "a committed overlay that updates a child and deletes its Group",
      (doc, { rect, group, child }) =>
        commitTransaction(doc, [
          { id: rect.id, base: rect, working: { ...rect, visible: false } },
          { id: child.id, base: child, working: { ...child, name: "c" } },
          { id: group.id, base: group, working: null },
        ]),
    ],
  ];
  for (const [name, edit] of edits) {
    it(`restores the Document exactly after ${name}`, () => {
      const s = setup();
      const after = copy(s.doc);
      edit(after, s);
      const delta = diff(s.doc, after);
      expect(delta.length).toBeGreaterThan(0);
      const { skipped } = revert(after, delta);
      expect(skipped).toEqual([]);
      expect(after.nodes).toEqual(s.doc.nodes);
    });
  }

  it("recreates a child whose row comes before its Group's", () => {
    const { doc, group, child } = setup();
    const after = copy(doc);
    deleteNodes(after, [group.id]);
    const delta = diff(doc, after).sort((a) => (a.id === child.id ? -1 : 1));
    revert(after, delta);
    expect(after.nodes).toEqual(doc.nodes);
  });

  it("skips an update of a Node deleted since, and reverts the rest", () => {
    const { doc, rect, child } = setup();
    const after = copy(doc);
    updateNodes(after, [
      { nodeId: rect.id, patch: { name: "b" } },
      { nodeId: child.id, patch: { name: "c" } },
    ]);
    const delta = diff(doc, after);
    deleteNodes(after, [child.id]);
    const { skipped, updated } = revert(after, delta);
    expect(skipped).toEqual([child.id]);
    expect(updated.map((n) => n.id)).toEqual([rect.id]);
    expect(after.nodes.get(rect.id)).toEqual(rect);
    expect(after.nodes.has(child.id)).toBe(false);
  });

  it("skips recreating Nodes whose parent was deleted since, and their children", () => {
    const { doc, defaultLayerId, group, child } = setup();
    const [inner] = createNodes(doc, [{ type: "group", parentId: group.id }]).nodes as [Node];
    const [leaf] = createNodes(doc, [
      { type: "rect", parentId: inner.id, x: 0, y: 0, width: 1, height: 1 },
    ]).nodes as [Node];
    const after = copy(doc);
    deleteNodes(after, [inner.id]);
    const delta = diff(doc, after);
    deleteNodes(after, [group.id]);
    const before = copy(after);
    const { skipped } = revert(after, delta);
    expect(skipped.sort()).toEqual([inner.id, leaf.id].sort());
    expect(after.nodes).toEqual(before.nodes);
    expect([defaultLayerId, child.id].map((id) => after.nodes.has(id))).toEqual([true, false]);
  });
});

describe("tree rules at commit, undo and redo (ADR-0072)", () => {
  /** Layer L holds Groups G1 and G2 and, on top, rect R; Layer M is empty. */
  const tree = () => {
    const { doc, defaultLayerId: l } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 200, height: 100 }],
    });
    const [g1, g2, r, m] = createNodes(doc, [
      { type: "group", parentId: l },
      { type: "group", parentId: l },
      { type: "rect", parentId: l, x: 0, y: 0, width: 10, height: 10 },
      { type: "layer" },
    ]).nodes.map((n) => n.id) as [string, string, string, string];
    return { doc, l, g1, g2, r, m };
  };

  /** Runs `edit` on a Transaction's overlay of `doc`, adding what it changed to `rows` (ADR-0008). */
  const stage = (doc: Document, rows: TxRow[], edit: (view: Document) => unknown) => {
    const view = overlay(doc, rows);
    const before = new Map(view.nodes);
    edit(view);
    for (const id of new Set([...before.keys(), ...view.nodes.keys()])) {
      const working = view.nodes.get(id) ?? null;
      if (before.get(id) === working) continue;
      const row = rows.find((r) => r.id === id);
      if (row) row.working = working;
      else rows.push({ id, base: doc.nodes.get(id) ?? null, working });
    }
  };

  /** Runs a direct write and returns its delta, as the DO stores it for undo (ADR-0011). */
  const write = (doc: Document, edit: (doc: Document) => unknown): DeltaRow[] => {
    const before = copy(doc);
    edit(doc);
    return diff(before, doc);
  };

  /** Throws unless the Document passes file validation (ADR-0016) once exported. */
  const reopens = (doc: Document) => parseDocument(serializeDocument(doc));

  it("refuses a staged move that makes a cycle with a move committed meanwhile, changing nothing", () => {
    const { doc, g1, g2 } = tree();
    const rows: TxRow[] = [];
    stage(doc, rows, (v) => reparentNodes(v, [{ nodeId: g1, parentId: g2 }]));
    reparentNodes(doc, [{ nodeId: g2, parentId: g1 }]);
    const before = copy(doc);
    expect(nodeGone(() => commitTransaction(doc, rows))).toMatchObject({
      code: "TREE_CONFLICT",
      nodeIds: [g1],
      message: expect.stringContaining("cycle"),
      hint: expect.stringContaining("kalamo_tx_rollback"),
    });
    expect(doc.nodes).toEqual(before.nodes);
    reopens(doc);
  });

  it("refuses to show a staged Transaction a view that moves committed meanwhile made cyclic", () => {
    const { doc, g1, g2 } = tree();
    const rows: TxRow[] = [];
    stage(doc, rows, (v) => reparentNodes(v, [{ nodeId: g1, parentId: g2 }]));
    reparentNodes(doc, [{ nodeId: g2, parentId: g1 }]);
    expect(nodeGone(() => stage(doc, rows, (v) => deleteNodes(v, [g1])))).toMatchObject({
      code: "TREE_CONFLICT",
      nodeIds: [g1],
      hint: expect.stringContaining("kalamo_tx_rollback"),
    });
  });

  it("refuses with NODE_GONE a staged move into a Group deleted meanwhile", () => {
    const { doc, g1, r } = tree();
    const rows: TxRow[] = [];
    stage(doc, rows, (v) => reparentNodes(v, [{ nodeId: r, parentId: g1 }]));
    deleteNodes(doc, [g1]);
    expect(nodeGone(() => commitTransaction(doc, rows))).toMatchObject({
      code: "NODE_GONE",
      nodeIds: [g1],
    });
  });

  it("skips an undone move that would make a cycle with a later move", () => {
    const { doc, l, g1, g2 } = tree();
    reparentNodes(doc, [{ nodeId: g1, parentId: g2 }]);
    const out = write(doc, (d) => reparentNodes(d, [{ nodeId: g1, parentId: l }]));
    reparentNodes(doc, [{ nodeId: g2, parentId: g1 }]);
    const { skipped, updated } = revert(doc, out);
    expect(skipped).toEqual([g1]);
    expect(updated).toEqual([]);
    expect(doc.nodes.get(g1)?.parentId).toBe(l);
    reopens(doc);
  });

  it("refuses a staged move that closes a cycle through a Group it deletes, changing nothing", () => {
    const { doc, l, g1, g2 } = tree();
    const [d] = createNodes(doc, [{ type: "group", parentId: l }]).nodes as [Node];
    const rows: TxRow[] = [];
    stage(doc, rows, (v) => reparentNodes(v, [{ nodeId: g1, parentId: g2 }]));
    stage(doc, rows, (v) => deleteNodes(v, [d.id]));
    reparentNodes(doc, [{ nodeId: d.id, parentId: g1 }]);
    reparentNodes(doc, [{ nodeId: g2, parentId: d.id }]);
    const before = copy(doc);
    expect(nodeGone(() => commitTransaction(doc, rows))).toMatchObject({
      code: "TREE_CONFLICT",
      nodeIds: [g1],
      message: expect.stringContaining("cycle"),
    });
    expect(doc.nodes).toEqual(before.nodes);
    reopens(doc);
  });

  it("skips an undone move that closes a cycle through a Group the undo deletes", () => {
    const { doc, l, g1, g2 } = tree();
    reparentNodes(doc, [{ nodeId: g1, parentId: g2 }]);
    let d = "";
    const out = write(doc, (x) => {
      d = (createNodes(x, [{ type: "group", parentId: l }]).nodes[0] as Node).id;
      reparentNodes(x, [{ nodeId: g1, parentId: d }]);
    });
    reparentNodes(doc, [{ nodeId: g1, parentId: l }]);
    reparentNodes(doc, [{ nodeId: d, parentId: g1 }]);
    reparentNodes(doc, [{ nodeId: g2, parentId: d }]);
    const { skipped, deletedIds } = revert(doc, out);
    expect(skipped).toEqual([g1]);
    expect(deletedIds.sort()).toEqual([d, g2].sort());
    expect(doc.nodes.get(g1)?.parentId).toBe(l);
    reopens(doc);
  });

  it("refuses a row that puts a Layer in a Group, or a Group at the root", () => {
    const { doc, g1, g2, m } = tree();
    const layer = doc.nodes.get(m) as Node;
    const group = doc.nodes.get(g2) as Node;
    for (const [row, id] of [
      [{ id: m, base: layer, working: { ...layer, parentId: g1 } }, m],
      [{ id: g2, base: group, working: { ...group, parentId: null } }, g2],
    ] as const) {
      expect(nodeGone(() => commitTransaction(doc, [row]))).toMatchObject({
        code: "TREE_CONFLICT",
        nodeIds: [id],
      });
      expect(revert(doc, [{ id, before: row.working, after: row.base }]).skipped).toEqual([id]);
    }
    reopens(doc);
  });

  it("refuses a Clipping Path staged in a Layer that got another meanwhile", () => {
    const { doc, l, r } = tree();
    const rows: TxRow[] = [];
    stage(doc, rows, (v) => makeMask(v, { layerId: l }));
    const [top] = createNodes(doc, [
      { type: "ellipse", parentId: l, x: 0, y: 0, width: 5, height: 5 },
    ]).nodes as [Node];
    makeMask(doc, { layerId: l });
    expect(nodeGone(() => commitTransaction(doc, rows))).toMatchObject({
      code: "TREE_CONFLICT",
      nodeIds: [r],
      message: expect.stringContaining("already has a Clipping Path"),
    });
    expect(doc.nodes.get(top.id)).toMatchObject({ clipping: true });
    reopens(doc);
  });

  it("skips an undone move of a Clipping Path back into a Layer that got another meanwhile", () => {
    const { doc, l, r, m } = tree();
    createNodes(doc, [{ type: "ellipse", parentId: l, x: 0, y: 0, width: 5, height: 5 }]);
    reparentNodes(doc, [{ nodeId: r, parentId: l }]);
    makeMask(doc, { layerId: l });
    expect(doc.nodes.get(r)).toMatchObject({ clipping: true });
    const out = write(doc, (d) => reparentNodes(d, [{ nodeId: r, parentId: m }]));
    makeMask(doc, { layerId: l });
    expect(revert(doc, out).skipped).toEqual([r]);
    expect(doc.nodes.get(r)?.parentId).toBe(m);
    reopens(doc);
  });

  it("gives the later of two staged creates on top of one parent a key above the other's", () => {
    const { doc, l, g1, g2, r } = tree();
    const keys = new Map([g1, g2, r].map((id) => [id, doc.nodes.get(id)?.index]));
    const rect = { type: "rect" as const, parentId: l, x: 0, y: 0, width: 1, height: 1 };
    const a: TxRow[] = [];
    const b: TxRow[] = [];
    stage(doc, a, (v) => createNodes(v, [rect]));
    stage(doc, b, (v) => createNodes(v, [rect]));
    expect(a[0]?.working?.index).toBe(b[0]?.working?.index);
    const [x] = commitTransaction(doc, a).created as [Node];
    const [y] = commitTransaction(doc, b).created as [Node];
    const top = keys.get(r) as string;
    expect(x.index > top && y.index > x.index).toBe(true);
    expect(doc.nodes.get(y.id)).toBe(y);
    expect(new Map([g1, g2, r].map((id) => [id, doc.nodes.get(id)?.index]))).toEqual(keys);
    reopens(doc);
    // A move or create into the parent now finds a slot between any two siblings.
    reparentNodes(doc, [{ nodeId: r, parentId: l, before: y.id }]);
    createNodes(doc, [rect]);
    reopens(doc);
  });

  it("gives a Node an undo brings back a key above the one that took its slot meanwhile", () => {
    const { doc, l, r } = tree();
    const gone = write(doc, (d) => deleteNodes(d, [r]));
    const [z] = createNodes(doc, [{ type: "rect", parentId: l, x: 0, y: 0, width: 1, height: 1 }])
      .nodes as [Node];
    const index = (doc.nodes.get(r) ?? gone[0]?.before)?.index as string;
    expect(z.index).toBe(index);
    const { created, skipped } = revert(doc, gone);
    expect(skipped).toEqual([]);
    expect(doc.nodes.get(z.id)?.index).toBe(index);
    expect((created[0] as Node).index > index).toBe(true);
    reopens(doc);
  });

  it("keeps every committed Document valid through random staged and direct edits and undos", () => {
    let seed = 189;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)] as T;
    /** Any Node's id, or now and then one no Node has; core refuses what does not fit. */
    const any = (d: Document, keep = (_: Node) => true) => {
      const ids = [...d.nodes.values()].filter(keep).map((n) => n.id);
      return random() < 0.05 || ids.length === 0 ? "nope" : pick(ids);
    };
    /** Mostly a Layer or Group, so most edits land and meet each other. */
    const parent = (d: Document) =>
      any(d, (n) => random() < 0.1 || n.type === "layer" || n.type === "group");
    /** Mostly Groups, whose moves close cycles and meet other moves. */
    const move = (d: Document) => {
      const at = pick([{}, {}, { index: 0 }, { before: any(d) }]);
      const nodeId = any(d, (n) => random() < 0.2 || n.type === "group");
      return reparentNodes(d, [{ nodeId, parentId: random() < 0.05 ? null : parent(d), ...at }]);
    };
    const edits: ((d: Document) => unknown)[] = [
      (d) =>
        createNodes(d, [
          pick([
            { type: "rect", parentId: parent(d), x: 0, y: 0, width: 1, height: 1 },
            { type: "group", parentId: parent(d) },
          ] as const),
        ]),
      move,
      move,
      move,
      (d) => makeMask(d, { layerId: parent(d) }),
      (d) =>
        placeNodes(
          d,
          { name: "f", nodes: [...tree().doc.nodes.values()] },
          { parentId: parent(d) },
        ),
      // Mostly leaves, so a staged Transaction is seldom refused as NODE_GONE before its tree check.
      (d) =>
        deleteNodes(d, [
          any(d, (n) => n.type !== "layer" && (n.type !== "group" || random() < 0.2)),
        ]),
    ];
    /** How often each path ADR-0072 adds ran, so the test fails if the edits stop reaching one. */
    const seen = { refused: 0, skipped: 0, rekeyed: 0 };
    /** Nodes stored with another key than the row set; a row that left `index` alone merges none. */
    const rekeyed = (change: { created: Node[]; updated: Node[] }, rows: TxRow[]) =>
      [...change.created, ...change.updated].filter((n) => {
        const row = rows.find((r) => r.id === n.id);
        return row?.working?.index !== row?.base?.index && n.index !== row?.working?.index;
      }).length;
    for (let run = 0; run < 100; run++) {
      const { doc, g1 } = tree();
      // Nest a few Groups, so moves can close cycles several levels deep.
      createNodes(doc, [
        {
          type: "group",
          parentId: g1,
          children: [{ type: "group", children: [{ type: "group" }] }],
        },
      ]);
      const txs: TxRow[][] = Array.from({ length: 3 }, () => []);
      const deltas: DeltaRow[][] = [];
      for (let step = 0; step < 80; step++) {
        const roll = random();
        try {
          if (roll < 0.1 && deltas.length > 0) {
            const delta = pick(deltas);
            const rows = delta.map(({ id, before, after }) => ({
              id,
              base: after,
              working: before,
            }));
            // A row whose Node and parent are still there is skipped only for a tree rule.
            const there = (r: TxRow) =>
              (!r.base || doc.nodes.has(r.id)) &&
              (!r.working?.parentId || doc.nodes.has(r.working.parentId));
            const change = revert(doc, delta);
            seen.skipped += rows.filter((r) => change.skipped.includes(r.id) && there(r)).length;
            seen.rekeyed += rekeyed(change, rows);
          } else if (roll < 0.18) {
            const rows = pick(txs);
            const before = copy(doc);
            try {
              seen.rekeyed += rekeyed(commitTransaction(doc, rows), rows);
              deltas.push(diff(before, doc));
            } catch (e) {
              if (e instanceof KalamoError && e.data.code === "TREE_CONFLICT") seen.refused++;
              throw e;
            } finally {
              rows.length = 0;
            }
          } else if (roll < 0.6) stage(doc, pick(txs), pick(edits));
          else deltas.push(write(doc, pick(edits)));
        } catch (e) {
          if (!(e instanceof KalamoError)) throw e;
        }
        reopens(doc);
      }
    }
    expect(seen.refused).toBeGreaterThan(0);
    expect(seen.skipped).toBeGreaterThan(0);
    expect(seen.rekeyed).toBeGreaterThan(0);
  });
});
