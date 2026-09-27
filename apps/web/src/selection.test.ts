import { createDocument, createNodes, makeMask, type Node } from "@zibel/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  combine,
  editable,
  expandable,
  hitTest,
  inverse,
  marquee,
  maskInput,
  objectOf,
  objects,
  pathTargets,
  placeParent,
  releasable,
} from "./selection.ts";

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
  const rect = (clientKey: string, x: number) =>
    ({ type: "rect", clientKey, x, y: 0, width: 10, height: 10 }) as const;
  const at = (parentId: string) => (key: string, x: number) => ({ ...rect(key, x), parentId });
  const { keyMap } = createNodes(doc, [
    { type: "group", clientKey: "g", parentId: l1, children: [rect("a", 0), rect("b", 20)] },
    at(l1)("c", 40),
    at(l1)("h", 60),
    { type: "group", clientKey: "lg", parentId: l1, children: [rect("m", 80)] },
    { type: "layer", clientKey: "l3", parentId: l1 },
    { type: "layer", clientKey: "l2" },
  ]);
  keyMap.l1 = l1;
  const id = (key: string) => keyMap[key] as string;
  Object.assign(keyMap, createNodes(doc, [at(id("l3"))("e", 100), at(id("l2"))("d", 120)]).keyMap);
  const set = (key: string, patch: Partial<Node>) =>
    doc.nodes.set(id(key), { ...(doc.nodes.get(id(key)) as Node), ...patch } as Node);
  set("h", { visible: false });
  set("lg", { locked: true });
  return { doc, id, node: (key: string) => doc.nodes.get(id(key)) as Node };
}

describe("objectOf", () => {
  it("is the outermost Group below the Layer, or the Node itself", () => {
    const { doc, id, node } = fixture();
    expect(objectOf(doc, node("a"))?.id).toBe(id("g"));
    expect(objectOf(doc, node("c"))?.id).toBe(id("c"));
    expect(objectOf(doc, node("e"))?.id).toBe(id("e"));
    expect(objectOf(doc, node("l3"))).toBeNull();
  });
});

describe("objects", () => {
  it("skips hidden and locked objects and what is inside them", () => {
    const { doc, id } = fixture();
    const keys = ["g", "c", "e", "d"];
    expect(objects(doc).map((n) => n.id)).toEqual(expect.arrayContaining(keys.map(id)));
    expect(objects(doc)).toHaveLength(keys.length);
  });

  it("skips everything in a hidden Layer", () => {
    const { doc, id, node } = fixture();
    doc.nodes.set(id("l2"), { ...node("l2"), visible: false });
    expect(objects(doc).map((n) => n.id)).not.toContain(id("d"));
  });
});

describe("editable", () => {
  it("is false for a Node hidden or locked itself or through an ancestor", () => {
    const { doc, id, node } = fixture();
    expect(["m", "h", "lg"].map((k) => editable(doc, node(k)))).toEqual([false, false, false]);
    expect(["c", "a", "e"].map((k) => editable(doc, node(k)))).toEqual([true, true, true]);
    doc.nodes.set(id("l1"), { ...node("l1"), visible: false });
    expect(editable(doc, node("c"))).toBe(false);
  });
});

it("lists the selectable objects in one Layer, its sublayers included", () => {
  const { doc, id } = fixture();
  const ids = objects(doc, id("l1")).map((n) => n.id);
  expect(ids).toEqual(expect.arrayContaining(["g", "c", "e"].map(id)));
  expect(ids).toHaveLength(3);
});

describe("combine", () => {
  it("replaces, toggles with Shift and removes with Alt+Shift", () => {
    const plain = { shift: false, alt: false };
    expect(combine(["x", "y"], ["z"], plain)).toEqual(["z"]);
    expect(combine(["x", "y"], [], plain)).toEqual([]);
    expect(combine(["x", "y"], ["y", "z"], { shift: true, alt: false })).toEqual(["x", "z"]);
    expect(combine(["x", "y"], ["y", "z"], { shift: true, alt: true })).toEqual(["x"]);
    expect(combine(["x"], [], { shift: true, alt: false })).toEqual(["x"]);
  });
});

describe("marquee", () => {
  it("takes every selectable object whose bounds it touches", () => {
    const { doc, id } = fixture();
    // x 5..45 touches a (in g), b (in g) and c's left edge at 40; not h, m or e.
    const hit = marquee(doc, { x: 5, y: 5, width: 35, height: 10 });
    expect(hit.sort()).toEqual([id("g"), id("c")].sort());
    expect(marquee(doc, { x: 55, y: 0, width: 40, height: 10 })).toEqual([]);
  });
});

it("inverse selects the other selectable objects", () => {
  const { doc, id } = fixture();
  expect(inverse(doc, [id("g"), id("d")]).sort()).toEqual([id("c"), id("e")].sort());
});

it("is not editable when the Node is gone", () => {
  const { doc } = fixture();
  expect(editable(doc, undefined)).toBe(false);
});

describe("hitTest", () => {
  it("hits a text anywhere inside its bounds", () => {
    const { doc, defaultLayerId } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 200, height: 100 }],
    });
    const [t] = createNodes(doc, [
      { type: "text", parentId: defaultLayerId, x: 10, y: 50, content: "Hi" },
    ]).nodes;
    // A text needs no Path2D: bounds (10, 38)-(20.776, 53.912) decide.
    const ctx = {
      save() {},
      restore() {},
      setTransform() {},
    } as unknown as CanvasRenderingContext2D;
    expect(hitTest(ctx, doc, 15, 40, 1)).toBe(t?.id);
    expect(hitTest(ctx, doc, 22, 40, 1)).toBeNull();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("tests a Path's Fill with its fill rule, so a click in an evenodd hole misses", () => {
    // workerd has no Path2D; the geometry is the browser's, the rule is ours to pass.
    vi.stubGlobal("Path2D", class {});
    const { doc, defaultLayerId: parentId } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 200, height: 100 }],
    });
    const d = "M 0 0 L 30 0 L 30 30 L 0 30 Z M 10 10 L 20 10 L 20 20 L 10 20 Z";
    const [ring] = createNodes(doc, [
      {
        type: "path",
        parentId,
        d,
        fillRule: "evenodd",
        appearance: { fills: [{ color: "#000000" }] },
      },
    ]).nodes;
    const rules: unknown[] = [];
    const ctx = {
      save() {},
      restore() {},
      setTransform() {},
      isPointInPath: (_p: unknown, _x: number, _y: number, rule?: string) => {
        rules.push(rule);
        return rule !== "evenodd";
      },
      isPointInStroke: () => false,
    } as unknown as CanvasRenderingContext2D;
    expect(hitTest(ctx, doc, 15, 15, 1)).toBeNull();
    if (ring) doc.nodes.set(ring.id, { ...ring, fillRule: "nonzero" } as Node);
    expect(hitTest(ctx, doc, 15, 15, 1)).toBe(ring?.id);
    expect(rules).toEqual(["evenodd", "nonzero"]);
  });

  it("hits a Clipping Mask's content only inside its Clipping Path, which is never a hit itself", () => {
    // A Path2D that is its d's bounding box: enough for rects.
    vi.stubGlobal(
      "Path2D",
      class {
        constructor(readonly d: string) {}
      },
    );
    const box = (d: string, x: number, y: number) => {
      const n = d.match(/-?[\d.]+/g)?.map(Number) ?? [];
      const xs = n.filter((_, i) => i % 2 === 0);
      const ys = n.filter((_, i) => i % 2 === 1);
      return (
        Math.min(...xs) <= x && x <= Math.max(...xs) && Math.min(...ys) <= y && y <= Math.max(...ys)
      );
    };
    const ctx = {
      save() {},
      restore() {},
      setTransform() {},
      isPointInPath: (p: { d: string }, x: number, y: number) => box(p.d, x, y),
      isPointInStroke: () => false,
    } as unknown as CanvasRenderingContext2D;
    const { doc, defaultLayerId: parentId } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 200, height: 100 }],
    });
    const [content, clip] = createNodes(doc, [
      { type: "rect", parentId, x: 0, y: 0, width: 50, height: 50 },
      { type: "rect", parentId, x: 60, y: 0, width: 10, height: 10 },
    ]).nodes as [Node, Node];
    // The clip sits beside the content, so a click on it would hit it were it painted.
    const { group } = makeMask(doc, { clipNodeId: clip.id, contentIds: [content.id] });
    doc.nodes.set(clip.id, {
      ...(doc.nodes.get(clip.id) as Node),
      transform: [1, 0, 0, 1, -55, 0],
    } as Node);
    expect(hitTest(ctx, doc, 8, 5, 1)).toBe(group.id);
    expect(hitTest(ctx, doc, 30, 30, 1)).toBeNull();
    expect(hitTest(ctx, doc, 65, 5, 1)).toBeNull();
  });
});

describe("maskInput", () => {
  it("clips with the topmost selected Node, as Illustrator picks it, whatever order it was selected in", () => {
    const { doc, id } = fixture();
    expect(maskInput(doc, [id("c"), id("g")])).toEqual({
      clipNodeId: id("c"),
      contentIds: [id("g")],
    });
    // In Layer 3, above Layer 1's own children.
    expect(maskInput(doc, [id("e"), id("c")])?.clipNodeId).toBe(id("e"));
  });

  it("is null without two editable Nodes selected", () => {
    const { doc, id } = fixture();
    expect(maskInput(doc, [id("c")])).toBeNull();
    expect(maskInput(doc, [id("c"), id("m")])).toBeNull();
  });
});

it("releasable lists the selected Clipping Masks and Clipping Paths only", () => {
  const { doc, id } = fixture();
  const { group } = makeMask(doc, { clipNodeId: id("c"), contentIds: [id("g")] });
  expect(releasable(doc, [group.id, id("e")])).toEqual([group.id]);
  expect(releasable(doc, [id("c")])).toEqual([id("c")]);
  expect(releasable(doc, [id("e"), id("a")])).toEqual([]);
});

describe("placeParent", () => {
  it("is the nearest Layer of the first selected Node, else the top Layer", () => {
    const { doc, id } = fixture();
    expect(placeParent(doc, [id("a"), id("d")])).toBe(id("l1"));
    expect(placeParent(doc, [id("e")])).toBe(id("l3"));
    expect(placeParent(doc, [])).toBe(id("l2"));
  });
});

it("expandable lists the selected editable Live Shapes only", () => {
  const { doc, id } = fixture();
  expect(expandable(doc, [id("c"), id("g"), id("h"), id("e")])).toEqual([id("c"), id("e")]);
});

it("pathTargets lists the selected editable paths and Live Shapes, and those in selected Groups", () => {
  const { doc, id } = fixture();
  expect(pathTargets(doc, [id("g"), id("a"), id("h"), id("lg"), id("l3")])).toEqual([
    id("a"),
    id("b"),
    id("e"),
  ]);
});
