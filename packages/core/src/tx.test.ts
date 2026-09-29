import { describe, expect, it } from "vitest";
import { createDocument, createNodes } from "./document.ts";
import { deleteNodes, transformNodes, updateNodes } from "./edit.ts";
import { KalamoError } from "./errors.ts";
import { convertToPath } from "./path-op.ts";
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
