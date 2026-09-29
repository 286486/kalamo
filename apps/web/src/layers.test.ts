import {
  childrenOf,
  createDocument,
  createNodes,
  duplicateNodes,
  makeMask,
  type Node,
  type ReparentInput,
  reparentNodes,
} from "@kalamo/core";
import { describe, expect, it } from "vitest";
import {
  autoName,
  type Drop,
  dropAt,
  dropCopies,
  dropMoves,
  duplicateRows,
  layerMask,
  rows,
} from "./layers.ts";

/**
 * Layer 1: Group g (rects a, b), rect c, hidden rect h, locked Group lg (rect m), Layer 3 (rect e).
 * Layer 2: rect d.
 */
function fixture() {
  const { doc, defaultLayerId: l1 } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100 }],
  });
  const rect = (clientKey: string) =>
    ({ type: "rect", clientKey, x: 0, y: 0, width: 10, height: 10 }) as const;
  const at = (parentId: string) => (key: string) => ({ ...rect(key), parentId });
  const { keyMap } = createNodes(doc, [
    { type: "group", clientKey: "g", parentId: l1, children: [rect("a"), rect("b")] },
    at(l1)("c"),
    at(l1)("h"),
    { type: "group", clientKey: "lg", parentId: l1, children: [rect("m")] },
    { type: "layer", clientKey: "l3", parentId: l1 },
    { type: "layer", clientKey: "l2" },
  ]);
  keyMap.l1 = l1;
  const id = (key: string) => keyMap[key] as string;
  Object.assign(keyMap, createNodes(doc, [at(id("l3"))("e"), at(id("l2"))("d")]).keyMap);
  const set = (key: string, patch: Partial<Node>) =>
    doc.nodes.set(id(key), { ...(doc.nodes.get(id(key)) as Node), ...patch } as Node);
  set("h", { visible: false });
  set("lg", { locked: true });
  const key = (nodeId: string) => Object.keys(keyMap).find((k) => keyMap[k] === nodeId);
  return { doc, id, key };
}

it("lists siblings topmost first, Layers expanded and Groups collapsed", () => {
  const { doc, id, key } = fixture();
  const out = rows(doc, new Set(), null);
  expect(out.map((r) => key(r.node.id))).toEqual(["l2", "d", "l1", "l3", "e", "lg", "h", "c", "g"]);
  expect(out.map((r) => r.depth)).toEqual([0, 1, 0, 1, 2, 1, 1, 1, 1]);
  const g = out.find((r) => r.node.id === id("g"));
  expect(g).toMatchObject({ expandable: true, expanded: false });
  expect(out.find((r) => r.node.id === id("c"))).toMatchObject({ expandable: false });
});

it("expands a toggled Group and collapses a toggled Layer", () => {
  const { doc, id, key } = fixture();
  const keys = (toggled: string[]) =>
    rows(doc, new Set(toggled.map(id)), null).map((r) => `${key(r.node.id)}:${r.depth}`);
  expect(keys(["g"]).slice(-3)).toEqual(["g:1", "b:2", "a:2"]);
  expect(keys(["l1"])).toEqual(["l2:0", "d:1", "l1:0"]);
});

it("dims every row hidden or locked, itself or through an ancestor", () => {
  const { doc, id, key } = fixture();
  const dimmed = rows(doc, new Set([id("lg")]), null)
    .filter((r) => r.dimmed)
    .map((r) => key(r.node.id));
  expect(dimmed).toEqual(["lg", "m", "h"]);
});

it("auto-names each type of unnamed Node", () => {
  const types = ["rect", "ellipse", "line", "polygon", "star", "path", "group", "layer"] as const;
  expect(
    types.map((type) =>
      autoName(createDocument({ id: "d", name: "D", artboards: [] }).doc, { type } as Node),
    ),
  ).toEqual([
    "<Rectangle>",
    "<Ellipse>",
    "<Line>",
    "<Polygon>",
    "<Star>",
    "<Path>",
    "<Group>",
    "<Layer>",
  ]);
});

it("offers no disclosure for an empty container", () => {
  const { doc, id } = fixture();
  doc.nodes.delete(id("e"));
  expect(rows(doc, new Set(), null).find((r) => r.node.id === id("l3"))).toMatchObject({
    expandable: false,
    expanded: false,
  });
});

it("auto-names a text by its content", () => {
  expect(
    autoName(createDocument({ id: "d", name: "D", artboards: [] }).doc, {
      type: "text",
      content: "Q3\nrevenue",
    } as Node),
  ).toBe("Q3 revenue");
});

it.each([
  ["an ellipse", { type: "ellipse", x: 0, y: 0, width: 5, height: 5 }],
  ["a text", { type: "text", x: 0, y: 5, content: "Hi" }],
])("auto-names a Clipping Mask and its Clipping Path, %s, as Illustrator does", (_, by) => {
  const { doc, defaultLayerId: parentId } = createDocument({ id: "d", name: "D", artboards: [] });
  const [content, clip] = createNodes(doc, [
    { type: "rect", parentId, x: 0, y: 0, width: 5, height: 5 },
    { ...by, parentId } as never,
  ]).nodes as [Node, Node];
  const { group } = makeMask(doc, { clipNodeId: clip.id, contentIds: [content.id] });
  expect(autoName(doc, group)).toBe("<Clip Group>");
  expect(autoName(doc, doc.nodes.get(clip.id) as Node)).toBe("<Clipping Path>");
  expect(autoName(doc, content)).toBe("<Rectangle>");
});

it("names an Image as Illustrator names an embedded one", () => {
  const { doc, defaultLayerId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100 }],
  });
  const src = "a".repeat(64);
  doc.images.set(src, { mime: "image/png", width: 2, height: 2 });
  const [image] = createNodes(doc, [{ type: "image", parentId: defaultLayerId, src, x: 0, y: 0 }])
    .nodes as [Node];
  expect(autoName(doc, image)).toBe("<Image>");
});

it("names a linked Image <Linked File>, with or without its pixels", () => {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100 }],
  });
  const src = "a".repeat(64);
  doc.images.set(src, { mime: "image/png", width: 2, height: 2 });
  const frame = {
    type: "image",
    parentId,
    file: "a.png",
    x: 0,
    y: 0,
    width: 2,
    height: 2,
  } as const;
  const images = createNodes(doc, [frame, { ...frame, src }]).nodes as Node[];
  expect(images.map((n) => autoName(doc, n))).toEqual(["<Linked File>", "<Linked File>"]);
});

describe("a Layer Clipping Mask (ADR-0053)", () => {
  /** Layer 1 holding rect a and ellipse clip, then Layer 2 on top, empty. */
  function layered() {
    const { doc, defaultLayerId: l1 } = createDocument({ id: "d", name: "D", artboards: [] });
    const [a, clip] = createNodes(doc, [
      { type: "rect", parentId: l1, x: 0, y: 0, width: 5, height: 5 },
      { type: "ellipse", parentId: l1, x: 0, y: 0, width: 5, height: 5 },
    ]).nodes as [Node, Node];
    const [l2] = createNodes(doc, [{ type: "layer" }]).nodes as [Node];
    return { doc, l1, a, clip, l2 };
  }

  it("keeps a clipped Layer's name, and underlines it and its Clipping Path's", () => {
    const { doc, l1, a, clip } = layered();
    makeMask(doc, { layerId: l1 });
    const layer = doc.nodes.get(l1) as Node;
    expect(autoName(doc, layer)).toBe("<Layer>");
    expect(autoName(doc, doc.nodes.get(clip.id) as Node)).toBe("<Clipping Path>");
    const underlined = rows(doc, new Set(), null)
      .filter((r) => r.underlined)
      .map((r) => r.node.id);
    expect(underlined).toEqual([l1, clip.id]);
    expect(rows(doc, new Set(), null).find((r) => r.node.id === a.id)?.underlined).toBe(false);
  });

  it("underlines a Clip Group's name", () => {
    const { doc, a, clip } = layered();
    const { group } = makeMask(doc, { clipNodeId: clip.id, contentIds: [a.id] });
    expect(
      rows(doc, new Set([group.id]), null)
        .filter((r) => r.underlined)
        .map((r) => r.node.id),
    ).toEqual([group.id, clip.id]);
  });

  it("makes or releases the Layer of the Selection, else the top Layer", () => {
    const { doc, l1, a, l2 } = layered();
    expect(layerMask(doc, [a.id], null)).toEqual({
      label: "Make Clipping Mask",
      command: { type: "mask_make", input: { layerId: l1 } },
    });
    makeMask(doc, { layerId: l1 });
    expect(layerMask(doc, [a.id], null)).toEqual({
      label: "Release Clipping Mask",
      command: { type: "mask_release", nodeIds: [l1] },
    });
    // The top Layer is empty.
    expect(layerMask(doc, [], null)).toEqual({ label: "Make Clipping Mask", command: null });
    createNodes(doc, [{ type: "rect", parentId: l2.id, x: 0, y: 0, width: 1, height: 1 }]);
    expect(layerMask(doc, [], null).command).toEqual({
      type: "mask_make",
      input: { layerId: l2.id },
    });
    doc.nodes.set(l2.id, { ...l2, locked: true });
    expect(layerMask(doc, [], null).command).toBeNull();
  });
});

describe("in Isolation Mode (ADR-0057)", () => {
  it("lists only the isolated Group, expanded at depth 0, and what is in it", () => {
    const { doc, id, key } = fixture();
    const scoped = rows(doc, new Set([id("g")]), id("g"));
    expect(scoped.map((r) => `${key(r.node.id)}:${r.depth}`)).toEqual(["g:0", "b:1", "a:1"]);
    expect(scoped[0]).toMatchObject({ expanded: true, expandable: false });
    // Toggled or not outside Isolation Mode, the root stays expanded.
    expect(rows(doc, new Set(), id("g")).map((r) => key(r.node.id))).toEqual(["g", "b", "a"]);
  });

  it("disables the Make/Release Clipping Mask button", () => {
    const { doc, id } = fixture();
    expect(layerMask(doc, [id("a")], id("g"))).toEqual({
      label: "Make Clipping Mask",
      command: null,
    });
    expect(layerMask(doc, [id("a")], null).command).not.toBeNull();
  });

  it("labels the button by the Layer, not by an isolated Clip Group", () => {
    const { doc, id } = fixture();
    const { group } = makeMask(doc, { clipNodeId: id("c"), contentIds: [id("g")] });
    expect(layerMask(doc, [id("a")], group.id)).toEqual({
      label: "Make Clipping Mask",
      command: null,
    });
  });
});

describe("dropMoves (ADR-0075)", () => {
  /** The keys of the parent's children after the moves, bottom first. */
  const after = (drop: ReturnType<typeof fixture>, moves: ReparentInput[], parent: string) => {
    const doc = { ...drop.doc, nodes: new Map(drop.doc.nodes) };
    reparentNodes(doc, moves);
    return childrenOf(doc, drop.id(parent)).map((n) => drop.key(n.id));
  };

  it("puts a Node dropped on a Group on top inside it", () => {
    const f = fixture();
    const out = dropMoves(f.doc, [f.id("c")], { zone: "onto", id: f.id("g") }, null);
    expect(out).toEqual({ moves: [{ nodeId: f.id("c"), parentId: f.id("g") }], moved: true });
    expect(after(f, out?.moves ?? [], "g")).toEqual(["a", "b", "c"]);
  });

  it("restacks a Node dropped between its siblings, and sees a drop where it is as no move", () => {
    const f = fixture();
    const up = dropMoves(f.doc, [f.id("g")], { zone: "above", id: f.id("c") }, null);
    expect(up?.moves).toEqual([{ nodeId: f.id("g"), parentId: f.id("l1"), after: f.id("c") }]);
    expect(after(f, up?.moves ?? [], "l1")).toEqual(["c", "g", "h", "lg", "l3"]);
    expect(dropMoves(f.doc, [f.id("c")], { zone: "above", id: f.id("g") }, null)?.moved).toBe(
      false,
    );
    expect(dropMoves(f.doc, [f.id("c")], { zone: "below", id: f.id("h") }, null)?.moved).toBe(
      false,
    );
  });

  it("keeps two dragged Nodes in their panel order, whatever order they are named in", () => {
    const f = fixture();
    const out = dropMoves(f.doc, [f.id("c"), f.id("d")], { zone: "onto", id: f.id("l3") }, null);
    expect(after(f, out?.moves ?? [], "l3")).toEqual(["e", "c", "d"]);
    // Anchored on an undragged sibling, never on a dragged one.
    const gap = dropMoves(f.doc, [f.id("h"), f.id("g")], { zone: "below", id: f.id("c") }, null);
    expect(after(f, gap?.moves ?? [], "l1")).toEqual(["g", "h", "c", "lg", "l3"]);
  });

  it("moves a sub-Layer to the top level and back, and drops a descendant of a dragged Node", () => {
    const f = fixture();
    const out = dropMoves(f.doc, [f.id("l3"), f.id("e")], { zone: "above", id: f.id("l2") }, null);
    expect(out?.moves).toEqual([{ nodeId: f.id("l3"), parentId: null, after: f.id("l2") }]);
    const doc = { ...f.doc, nodes: new Map(f.doc.nodes) };
    reparentNodes(doc, out?.moves ?? []);
    const back = dropMoves(doc, [f.id("l3")], { zone: "onto", id: f.id("l1") }, null);
    expect(back?.moves).toEqual([{ nodeId: f.id("l3"), parentId: f.id("l1") }]);
    // Below Layer 1 from the last row of its contents: the bottom of the top level.
    const bottom = dropMoves(f.doc, [f.id("l3")], { zone: "below", id: f.id("l1") }, null);
    expect(bottom?.moves).toEqual([{ nodeId: f.id("l3"), parentId: null, before: f.id("l1") }]);
  });

  it("leaves a Node in a locked container where it is, and moves the rest", () => {
    const f = fixture();
    const out = dropMoves(f.doc, [f.id("c"), f.id("m")], { zone: "onto", id: f.id("l3") }, null);
    expect(out?.moves).toEqual([{ nodeId: f.id("c"), parentId: f.id("l3") }]);
  });

  it("keeps a Clipping Path restacked in its Clip Group the Clipping Path (ADR-0071)", () => {
    const f = fixture();
    const { group } = makeMask(f.doc, { clipNodeId: f.id("c"), contentIds: [f.id("g")] });
    const out = dropMoves(f.doc, [f.id("c")], { zone: "below", id: f.id("g") }, null);
    const doc = { ...f.doc, nodes: new Map(f.doc.nodes) };
    reparentNodes(doc, out?.moves ?? []);
    expect(childrenOf(doc, group.id).map((n) => f.key(n.id))).toEqual(["c", "g"]);
    expect(doc.nodes.get(f.id("c"))).toMatchObject({ clipping: true });
  });

  it("refuses a drop core refuses, or into or out of a locked container, or out of scope", () => {
    const f = fixture();
    const refused = (dragged: string, drop: Drop, scope: string | null = null) =>
      dropMoves(f.doc, [f.id(dragged)], drop, scope);
    expect(refused("l1", { zone: "onto", id: f.id("l3") })).toBeNull();
    expect(refused("g", { zone: "onto", id: f.id("g") })).toBeNull();
    expect(refused("l3", { zone: "onto", id: f.id("g") })).toBeNull();
    expect(refused("l3", { zone: "above", id: f.id("a") })).toBeNull();
    expect(refused("c", { zone: "above", id: f.id("l2") })).toBeNull();
    expect(refused("c", { zone: "onto", id: f.id("lg") })).toBeNull();
    expect(refused("c", { zone: "above", id: f.id("m") })).toBeNull();
    expect(refused("m", { zone: "above", id: f.id("c") })).toBeNull();
    expect(refused("a", { zone: "above", id: f.id("g") }, f.id("g"))).toBeNull();
    // A locked Node in an unlocked parent moves, and a hidden container takes a drop.
    expect(refused("lg", { zone: "above", id: f.id("c") })?.moved).toBe(true);
    expect(refused("a", { zone: "above", id: f.id("b") }, f.id("g"))?.moved).toBe(true);
    const hidden = { ...f.doc.nodes.get(f.id("g")), visible: false } as Node;
    f.doc.nodes.set(hidden.id, hidden);
    expect(refused("c", { zone: "onto", id: f.id("g") })?.moved).toBe(true);
  });
});

describe("dropAt (ADR-0075)", () => {
  // l2, d, l1, l3 (expanded), e, lg, h, c, g: depths 0, 1, 0, 1, 2, 1, 1, 1, 1.
  /** The drop at `y` and `level` over `key`'s row, as "zone target depth". */
  const pointer = () => {
    const f = fixture();
    const listed = rows(f.doc, new Set(), null);
    return (key: string, y: number, level = 9) => {
      const i = listed.findIndex((r) => f.key(r.node.id) === key);
      const { zone, id, depth } = dropAt(listed, i, y, level);
      return `${zone} ${f.key(id)} ${depth}`;
    };
  };

  it("splits a collapsed container's row in quarters, an expanded one's and a leaf's in two", () => {
    const at = pointer();
    expect([0.24, 0.25, 0.74, 0.75].map((y) => at("g", y))).toEqual([
      "above g 1",
      "onto g 1",
      "onto g 1",
      "below g 1",
    ]);
    expect([at("l3", 0.24), at("l3", 0.25), at("l3", 0.99)]).toEqual([
      "above l3 1",
      "onto l3 1",
      "onto l3 1",
    ]);
    expect([at("c", 0.49), at("c", 0.5)]).toEqual(["above c 1", "below c 1"]);
  });

  it("drops below the last row of a container's contents at the pointer's indent", () => {
    const at = pointer();
    // The last row: below it, or below Layer 1 at the top level.
    expect([at("g", 0.9), at("g", 0.9, 0), at("g", 0.9, -1)]).toEqual([
      "below g 1",
      "below l1 0",
      "below l1 0",
    ]);
    // e closes l3, not l1, since lg follows at depth 1.
    expect([at("e", 0.9, 2), at("e", 0.9, 0)]).toEqual(["below e 2", "below l3 1"]);
    expect(at("d", 0.9, 0)).toBe("below l2 0");
  });
});

describe("dropCopies (ADR-0075)", () => {
  /** The keys of the parent's children after the copy, bottom first; a copy of `x` is `x+`. */
  const after = (f: ReturnType<typeof fixture>, dragged: string[], drop: Drop, parent: string) => {
    const input = dropCopies(f.doc, dragged.map(f.id), drop, null);
    if (!input) return null;
    const doc = { ...f.doc, nodes: new Map(f.doc.nodes) };
    const { copies } = duplicateNodes(doc, input);
    const source = (id: string) => Object.keys(copies).find((k) => copies[k]?.includes(id));
    return childrenOf(doc, f.id(parent)).map((n) => f.key(n.id) ?? `${f.key(source(n.id) ?? "")}+`);
  };

  it("copies onto a container's top, or into a gap, where a move would land", () => {
    const f = fixture();
    expect(after(f, ["c"], { zone: "onto", id: f.id("g") }, "g")).toEqual(["a", "b", "c+"]);
    expect(after(f, ["g"], { zone: "above", id: f.id("c") }, "l1")).toEqual([
      "g",
      "c",
      "g+",
      "h",
      "lg",
      "l3",
    ]);
    const bottom = dropCopies(f.doc, [f.id("l3")], { zone: "below", id: f.id("l1") }, null);
    expect(bottom).toEqual({ nodeIds: [f.id("l3")], targetParentId: null, before: f.id("l1") });
  });

  it("copies to a gap next to the original, where a move would change nothing", () => {
    const f = fixture();
    expect(after(f, ["c"], { zone: "above", id: f.id("c") }, "l1")).toEqual([
      "g",
      "c",
      "c+",
      "h",
      "lg",
      "l3",
    ]);
    expect(after(f, ["c"], { zone: "below", id: f.id("c") }, "l1")).toEqual([
      "g",
      "c+",
      "c",
      "h",
      "lg",
      "l3",
    ]);
    expect(after(f, ["c"], { zone: "above", id: f.id("g") }, "l1")).toEqual([
      "g",
      "c+",
      "c",
      "h",
      "lg",
      "l3",
    ]);
  });

  it("copies several Nodes as one block in their panel order, leaving out a locked container's", () => {
    const f = fixture();
    expect(after(f, ["c", "d", "m"], { zone: "onto", id: f.id("l3") }, "l3")).toEqual([
      "e",
      "c+",
      "d+",
    ]);
    expect(after(f, ["h", "g"], { zone: "below", id: f.id("c") }, "l1")).toEqual([
      "g",
      "g+",
      "h+",
      "c",
      "h",
      "lg",
      "l3",
    ]);
  });

  it("refuses every drop a move refuses, a copy into its own descendant too", () => {
    const f = fixture();
    const refused = (dragged: string, drop: Drop, scope: string | null = null) =>
      dropCopies(f.doc, [f.id(dragged)], drop, scope);
    expect(refused("l1", { zone: "onto", id: f.id("l3") })).toBeNull();
    expect(refused("g", { zone: "onto", id: f.id("g") })).toBeNull();
    expect(refused("g", { zone: "above", id: f.id("a") })).toBeNull();
    expect(refused("l3", { zone: "onto", id: f.id("g") })).toBeNull();
    expect(refused("c", { zone: "onto", id: f.id("lg") })).toBeNull();
    expect(refused("m", { zone: "above", id: f.id("c") })).toBeNull();
    expect(refused("a", { zone: "above", id: f.id("g") }, f.id("g"))).toBeNull();
  });
});

describe("duplicateRows (#195)", () => {
  const plan = (f: ReturnType<typeof fixture>, selected: string[], scope: string | null = null) => {
    const { label, input } = duplicateRows(f.doc, selected.map(f.id), scope);
    return { label, ids: input?.nodeIds.map(f.key) ?? null };
  };

  it("names one row, counting rows inside it as that one, and appends copy to Layers", () => {
    const f = fixture();
    const { input } = duplicateRows(f.doc, [f.id("l3"), f.id("e")], null);
    expect(input).toEqual({ nodeIds: [f.id("l3")], layerSuffix: " copy" });
    expect(plan(f, ["l2"])).toEqual({ label: 'Duplicate "<Layer>"', ids: ["l2"] });
    expect(plan(f, ["c", "d"])).toEqual({ label: "Duplicate Selection", ids: ["c", "d"] });
  });

  it("leaves out a row whose copy would land in a locked container or outside the Isolation", () => {
    const f = fixture();
    expect(plan(f, ["m"])).toEqual({ label: 'Duplicate "<Rectangle>"', ids: null });
    expect(plan(f, ["m", "c"]).ids).toEqual(["c"]);
    // The locked Group itself lands in an unlocked Layer.
    expect(plan(f, ["lg"]).ids).toEqual(["lg"]);
    expect(plan(f, ["a", "c"], f.id("g")).ids).toEqual(["a"]);
    expect(plan(f, ["g"], f.id("g")).ids).toBeNull();
    expect(plan(f, [])).toEqual({ label: "Duplicate Selection", ids: null });
  });
});
