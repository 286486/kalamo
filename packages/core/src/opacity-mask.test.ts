import { describe, expect, it } from "vitest";
import {
  bounds,
  childrenOf,
  createDocument,
  createNodes,
  paintedLeaves,
  visibleBounds,
} from "./document.ts";
import { duplicateNodes, reparentNodes, transformNodes, updateNodes } from "./edit.ts";
import { KalamoError } from "./errors.ts";
import { parseDocument, serializeDocument } from "./file.ts";
import { makeMask, releaseMask } from "./mask.ts";
import type { Document, GroupNode, Node, ShapeNode } from "./schema.ts";
import { type DeltaRow, revert } from "./tx.ts";

// Opacity Masks (ADR-0103): a Group whose one mask's luminance is the content's opacity.

const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof KalamoError) return e.data;
    throw e;
  }
  throw new Error("expected a KalamoError");
};

const fill = { fills: [{ color: "#808080" }], strokes: [{ color: "#000000", width: 4 }] };

/**
 * Under the Layer, bottom to top: below, a (x 10..60), mask (a grey ellipse over x 20..140, Stroke
 * 4 wide), b (x 30..80), above; a hidden rect; a Group.
 */
function scene() {
  const { doc, defaultLayerId: layerId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 200 }],
  });
  const rect = (x: number) => ({
    type: "rect" as const,
    parentId: layerId,
    x,
    y: 0,
    width: 50,
    height: 50,
  });
  const [below, a, mask, b, above, hidden, group] = createNodes(doc, [
    rect(0),
    rect(10),
    {
      type: "ellipse",
      parentId: layerId,
      x: 20,
      y: 20,
      width: 120,
      height: 100,
      appearance: fill,
    },
    rect(30),
    rect(40),
    rect(0),
    {
      type: "group",
      parentId: layerId,
      children: [(({ parentId: _, ...child }) => child)(rect(0))],
    },
  ]).nodes as [Node, Node, ShapeNode, Node, Node, Node, Node];
  doc.nodes.set(hidden.id, { ...hidden, visible: false });
  return { doc, layerId, below, a, mask, b, above, hidden, group };
}
type Scene = ReturnType<typeof scene>;

const opacity = (s: Scene, extra: { clip?: boolean; invert?: boolean } = {}) =>
  makeMask(s.doc, {
    clipNodeId: s.mask.id,
    contentIds: [s.b.id, s.a.id],
    kind: "opacity",
    ...extra,
  });

const get = (s: Scene, n: Node) => s.doc.nodes.get(n.id) as Node;

/** Runs `edit` and returns its delta, as the Document DO stores it for undo (ADR-0011). */
function write(doc: Document, edit: (doc: Document) => unknown): DeltaRow[] {
  const before = new Map(doc.nodes);
  edit(doc);
  return [...new Set([...before.keys(), ...doc.nodes.keys()])]
    .map((id) => ({ id, before: before.get(id) ?? null, after: doc.nodes.get(id) ?? null }))
    .filter((r) => r.before !== r.after);
}

describe("makeMask with kind opacity", () => {
  it("groups the members at the topmost one's place, in their stacking order, keeping the mask's Appearance", () => {
    const s = scene();
    const { group, updated } = opacity(s);
    expect(childrenOf(s.doc, s.layerId).map((n) => n.id)).toEqual([
      s.below.id,
      group.id,
      s.above.id,
      s.hidden.id,
      s.group.id,
    ]);
    expect(childrenOf(s.doc, group.id).map((n) => n.id)).toEqual([s.a.id, s.mask.id, s.b.id]);
    expect(updated.map((n) => n.id).sort()).toEqual([s.a.id, s.mask.id, s.b.id].sort());
    expect(get(s, s.mask)).toMatchObject({
      opacityMask: { clip: true, invert: false, link: true },
      appearance: s.mask.appearance,
    });
    expect(get(s, s.mask)).not.toHaveProperty("clipping");
  });

  it("takes clip and invert", () => {
    const s = scene();
    opacity(s, { clip: false, invert: true });
    expect(get(s, s.mask)).toMatchObject({
      opacityMask: { clip: false, invert: true, link: true },
    });
  });

  it.each(["group", "a"] as const)("masks with a %s", (key) => {
    const s = scene();
    const content = key === "group" ? s.a : s.b;
    makeMask(s.doc, { clipNodeId: s[key].id, contentIds: [content.id], kind: "opacity" });
    expect(get(s, s[key])).toMatchObject({ opacityMask: { clip: true } });
  });

  it.each<[string, (s: Scene) => object, string]>([
    ["a Layer as the mask", (s) => ({ clipNodeId: s.layerId, contentIds: [s.a.id] }), "clipNodeId"],
    ["a hidden mask", (s) => ({ clipNodeId: s.hidden.id, contentIds: [s.a.id] }), "clipNodeId"],
    [
      "the mask among the content",
      (s) => ({ clipNodeId: s.mask.id, contentIds: [s.mask.id] }),
      "contentIds[0]",
    ],
    [
      "a Layer as content",
      (s) => ({ clipNodeId: s.mask.id, contentIds: [s.layerId] }),
      "contentIds[0]",
    ],
    [
      "content under another parent",
      (s) => ({ clipNodeId: s.mask.id, contentIds: [childrenOf(s.doc, s.group.id)[0]?.id] }),
      "contentIds[0]",
    ],
    ["a layerId", (s) => ({ layerId: s.layerId }), "layerId"],
  ])("refuses %s with INVALID_MASK, changing nothing", (_, input, path) => {
    const s = scene();
    const before = [...s.doc.nodes.values()];
    const e = errorOf(() => makeMask(s.doc, { ...input(s), kind: "opacity" } as never));
    expect(e).toMatchObject({ code: "INVALID_MASK", path, hint: expect.stringMatching(/\S/) });
    expect([...s.doc.nodes.values()]).toEqual(before);
  });

  it.each(["clip", "invert"])("refuses %s on a Clipping Mask", (option) => {
    const s = scene();
    const before = [...s.doc.nodes.values()];
    const input = { clipNodeId: s.mask.id, contentIds: [s.a.id], [option]: true };
    expect(errorOf(() => makeMask(s.doc, input))).toMatchObject({
      code: "INVALID_MASK",
      path: option,
      hint: expect.stringContaining('kind "opacity"'),
    });
    expect(errorOf(() => makeMask(s.doc, { layerId: s.layerId, [option]: false }))).toMatchObject({
      code: "INVALID_MASK",
      path: option,
    });
    expect([...s.doc.nodes.values()]).toEqual(before);
  });

  it.each(["clip", "opacity"] as const)(
    "refuses a mask as the %s Node or as content, which would give a Group two",
    (kind) => {
      const s = scene();
      const { group } = opacity(s);
      const [other] = createNodes(s.doc, [
        { type: "rect", parentId: group.id, x: 0, y: 0, width: 5, height: 5 },
      ]).nodes as [Node];
      const before = [...s.doc.nodes.values()];
      expect(
        errorOf(() => makeMask(s.doc, { clipNodeId: other.id, contentIds: [s.mask.id], kind })),
      ).toMatchObject({ code: "INVALID_MASK", path: "contentIds[0]" });
      expect(
        errorOf(() => makeMask(s.doc, { clipNodeId: s.mask.id, contentIds: [s.a.id], kind })),
      ).toMatchObject({ code: "INVALID_MASK", path: "clipNodeId" });
      expect([...s.doc.nodes.values()]).toEqual(before);
    },
  );

  it("refuses a Clipping Path as the mask", () => {
    const s = scene();
    makeMask(s.doc, { clipNodeId: s.mask.id, contentIds: [s.a.id] });
    expect(
      errorOf(() =>
        makeMask(s.doc, { clipNodeId: s.mask.id, contentIds: [s.b.id], kind: "opacity" }),
      ),
    ).toMatchObject({ code: "INVALID_MASK", path: "clipNodeId" });
  });
});

describe("an Opacity Mask's bounds", () => {
  it("are its content's, without the mask", () => {
    const s = scene();
    const { group } = opacity(s);
    expect(bounds(s.doc, group)).toEqual({ x: 10, y: 0, width: 70, height: 50 });
    // Each rect has the default 1 pt Stroke; the mask's 4 pt one reaches nothing.
    expect(visibleBounds(s.doc, group)).toEqual({ x: 9.5, y: -0.5, width: 71, height: 51 });
  });

  it("leave the mask out of a container's painted leaves (ADR-0043)", () => {
    const s = scene();
    const { group } = opacity(s);
    const ids = paintedLeaves(s.doc, group).map((l) => l.node.id);
    expect(ids).toEqual([s.a.id, s.b.id]);
  });
});

describe("releaseMask of an Opacity Mask", () => {
  it.each(["group", "mask"])(
    "releases from the %s's id, keeping the Group and the mask, painted",
    (by) => {
      const s = scene();
      const { group } = opacity(s);
      const { nodes } = releaseMask(s.doc, [(by === "group" ? group : s.mask).id]);
      expect(nodes.map((n) => n.id)).toEqual([s.mask.id]);
      expect(get(s, s.mask)).not.toHaveProperty("opacityMask");
      expect(get(s, s.mask)).toMatchObject({ parentId: group.id, appearance: s.mask.appearance });
      expect(paintedLeaves(s.doc, group).map((l) => l.node.id)).toContain(s.mask.id);
    },
  );

  it("names both kinds when a Group masks nothing", () => {
    const s = scene();
    expect(errorOf(() => releaseMask(s.doc, [s.group.id]))).toMatchObject({
      code: "INVALID_MASK",
      message: expect.stringMatching(/Clipping Mask.*Opacity Mask/),
    });
  });
});

describe("node_update on a mask", () => {
  it.each(["clip", "invert", "link"] as const)("flips %s alone", (flag) => {
    const s = scene();
    opacity(s);
    const was = { clip: true, invert: false, link: true };
    updateNodes(s.doc, [{ nodeId: s.mask.id, patch: { opacityMask: { [flag]: !was[flag] } } }]);
    expect(get(s, s.mask)).toMatchObject({ opacityMask: { ...was, [flag]: !was[flag] } });
  });

  it.each<[string, (s: Scene) => { nodeId: string; patch: object }, string, RegExp]>([
    [
      "adding opacityMask",
      (s) => ({ nodeId: s.above.id, patch: { opacityMask: { clip: true } } }),
      ".opacityMask",
      /mask_make/,
    ],
    [
      "deleting opacityMask",
      (s) => ({ nodeId: s.mask.id, patch: { opacityMask: null } }),
      ".opacityMask",
      /mask_release/,
    ],
    [
      "hiding the mask",
      (s) => ({ nodeId: s.mask.id, patch: { visible: false } }),
      ".visible",
      /mask_release/,
    ],
    [
      "a flag that is no boolean",
      (s) => ({ nodeId: s.mask.id, patch: { opacityMask: { clip: "yes" } } }),
      ".opacityMask.clip",
      /\S/,
    ],
    [
      "an unknown option",
      (s) => ({ nodeId: s.mask.id, patch: { opacityMask: { feather: 2 } } }),
      ".opacityMask",
      /\S/,
    ],
  ])("refuses %s with INVALID_PATCH", (_, update, key, hint) => {
    const s = scene();
    opacity(s);
    const before = [...s.doc.nodes.values()];
    expect(errorOf(() => updateNodes(s.doc, [update(s) as never]))).toMatchObject({
      code: "INVALID_PATCH",
      path: `updates[0].patch${key}`,
      hint: expect.stringMatching(hint),
    });
    expect([...s.doc.nodes.values()]).toEqual(before);
  });
});

describe("undo", () => {
  it("reverses make, a flag change and release", () => {
    const s = scene();
    const start = new Map(s.doc.nodes);
    const made = write(s.doc, () => opacity(s));
    const afterMake = new Map(s.doc.nodes);
    const flipped = write(s.doc, (d) =>
      updateNodes(d, [{ nodeId: s.mask.id, patch: { opacityMask: { invert: true } } }]),
    );
    const afterFlip = new Map(s.doc.nodes);
    const released = write(s.doc, (d) => releaseMask(d, [s.mask.id]));
    revert(s.doc, released);
    expect(s.doc.nodes).toEqual(afterFlip);
    revert(s.doc, flipped);
    expect(s.doc.nodes).toEqual(afterMake);
    revert(s.doc, made);
    expect(s.doc.nodes).toEqual(start);
  });
});

describe("Link (ADR-0103)", () => {
  const moved = (s: Scene, n: Node) => (s.doc.nodes.get(n.id) as Node).transform.slice(4);
  const translate = { x: 7, y: 3 };

  it.each(["the Group", "its Layer"])("moves a linked mask with %s", (target) => {
    const s = scene();
    const { group } = opacity(s);
    transformNodes(s.doc, { nodeIds: [target === "the Group" ? group.id : s.layerId], translate });
    expect(moved(s, s.mask)).toEqual([7, 3]);
    expect(moved(s, s.a)).toEqual([7, 3]);
  });

  it("leaves an unlinked mask where it is, and the Group's bounds follow the content", () => {
    const s = scene();
    const { group } = opacity(s);
    updateNodes(s.doc, [{ nodeId: s.mask.id, patch: { opacityMask: { link: false } } }]);
    const before = bounds(s.doc, group) as { x: number };
    transformNodes(s.doc, { nodeIds: [group.id], translate });
    expect(moved(s, s.mask)).toEqual([0, 0]);
    expect(moved(s, s.b)).toEqual([7, 3]);
    expect(bounds(s.doc, group)).toMatchObject({ x: before.x + 7 });
  });

  it.each([true, false])("moves only the mask when it is named, linked %s", (link) => {
    const s = scene();
    opacity(s);
    updateNodes(s.doc, [{ nodeId: s.mask.id, patch: { opacityMask: { link } } }]);
    transformNodes(s.doc, { nodeIds: [s.mask.id], translate });
    expect(moved(s, s.mask)).toEqual([7, 3]);
    expect(moved(s, s.a)).toEqual([0, 0]);
  });

  it("moves an unlinked mask once when it is named with its Group", () => {
    const s = scene();
    const { group } = opacity(s);
    updateNodes(s.doc, [{ nodeId: s.mask.id, patch: { opacityMask: { link: false } } }]);
    const { warnings } = transformNodes(s.doc, { nodeIds: [group.id, s.mask.id], translate });
    expect(moved(s, s.mask)).toEqual([7, 3]);
    expect(moved(s, s.a)).toEqual([7, 3]);
    expect(warnings).toEqual([]);
  });

  it("never moves the mask with a content child", () => {
    const s = scene();
    opacity(s);
    transformNodes(s.doc, { nodeIds: [s.a.id], translate });
    expect(moved(s, s.mask)).toEqual([0, 0]);
  });

  it("keeps the leaves of an unlinked Group mask in place", () => {
    const s = scene();
    const { group } = makeMask(s.doc, {
      clipNodeId: s.group.id,
      contentIds: [s.above.id],
      kind: "opacity",
    });
    updateNodes(s.doc, [{ nodeId: s.group.id, patch: { opacityMask: { link: false } } }]);
    transformNodes(s.doc, { nodeIds: [group.id], translate });
    const [leaf] = childrenOf(s.doc, s.group.id) as [Node];
    expect(leaf.transform.slice(4)).toEqual([0, 0]);
    expect(moved(s, s.above)).toEqual([7, 3]);
  });
});

describe("a mask leaving its Group", () => {
  it("paints again once moved to another parent, and keeps masking when restacked", () => {
    const s = scene();
    const { group } = opacity(s);
    reparentNodes(s.doc, [{ nodeId: s.mask.id, parentId: group.id, index: 0 }]);
    expect(get(s, s.mask)).toHaveProperty("opacityMask");
    reparentNodes(s.doc, [{ nodeId: s.mask.id, parentId: s.layerId }]);
    expect(get(s, s.mask)).not.toHaveProperty("opacityMask");
  });

  it("is copied unmasked alone, and masking with its Group", () => {
    const s = scene();
    const { group } = opacity(s);
    const alone = duplicateNodes(s.doc, { nodeIds: [s.mask.id] }).created[0] as Node;
    expect(alone).not.toHaveProperty("opacityMask");
    const { created } = duplicateNodes(s.doc, { nodeIds: [group.id] });
    const copy = created[0] as GroupNode;
    expect(childrenOf(s.doc, copy.id).filter((n) => "opacityMask" in n)).toHaveLength(1);
  });
});

describe("doc_open (ADR-0016)", () => {
  const file = () => {
    const s = scene();
    const { group } = opacity(s);
    return { s, group, f: JSON.parse(serializeDocument(s.doc)) };
  };
  type N = Record<string, unknown> & { id: string };
  const at = (f: { nodes: N[] }, id: string) => f.nodes.findIndex((n) => n.id === id);
  const errorPath = (f: object) => errorOf(() => parseDocument(JSON.stringify(f)));

  it("reads an Opacity Mask back as it was written", () => {
    const { s, f } = file();
    const back = parseDocument(JSON.stringify(f));
    expect(back.nodes.find((n) => n.id === s.mask.id)).toMatchObject({
      opacityMask: { clip: true, invert: false, link: true },
    });
  });

  it("refuses a Group with two masks", () => {
    const { s, f } = file();
    f.nodes[at(f, s.a.id)].opacityMask = { clip: true, invert: false, link: true };
    expect(errorPath(f)).toMatchObject({
      code: "INVALID_DOCUMENT",
      path: `nodes[${Math.max(at(f, s.a.id), at(f, s.mask.id))}].opacityMask`,
      message: expect.stringContaining("already has a mask"),
    });
  });

  it("refuses a Group with a Clipping Path and a mask", () => {
    const { s, f } = file();
    f.nodes[at(f, s.a.id)].clipping = true;
    const later = Math.max(at(f, s.a.id), at(f, s.mask.id));
    expect(errorPath(f)).toMatchObject({
      code: "INVALID_DOCUMENT",
      path: expect.stringMatching(new RegExp(`^nodes\\[${later}\\]\\.(clipping|opacityMask)$`)),
    });
  });

  it("refuses a Node that is both a Clipping Path and a mask", () => {
    const { s, f } = file();
    f.nodes[at(f, s.mask.id)].clipping = true;
    expect(errorPath(f)).toMatchObject({
      code: "INVALID_DOCUMENT",
      path: `nodes[${at(f, s.mask.id)}].opacityMask`,
      message: "A Node is a Clipping Path or a mask, not both.",
    });
  });

  it("refuses a mask of a Layer, and a hidden mask", () => {
    const { s, f } = file();
    const mask = { clip: true, invert: false, link: true };
    f.nodes[at(f, s.above.id)].opacityMask = mask;
    expect(errorPath(f)).toMatchObject({
      code: "INVALID_DOCUMENT",
      path: `nodes[${at(f, s.above.id)}].opacityMask`,
    });
    const g = file();
    g.f.nodes[at(g.f, g.s.mask.id)].visible = false;
    expect(errorPath(g.f)).toMatchObject({
      code: "INVALID_DOCUMENT",
      path: `nodes[${at(g.f, g.s.mask.id)}].visible`,
    });
  });
});
