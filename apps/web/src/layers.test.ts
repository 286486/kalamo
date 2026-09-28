import { createDocument, createNodes, makeMask, type Node } from "@zibel/core";
import { describe, expect, it } from "vitest";
import { autoName, layerMask, rows } from "./layers.ts";

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
