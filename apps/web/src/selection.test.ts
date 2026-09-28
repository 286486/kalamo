import {
  applyTo,
  bounds,
  createDocument,
  createNodes,
  invert,
  type Matrix,
  makeMask,
  multiply,
  type Node,
  type Rect,
  type ShapeNode,
} from "@zibel/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boxContext } from "./boxContext.ts";
import { marqueeAnchors, parseKey, pick } from "./direct.ts";
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
    expect(objectOf(doc, node("a"), null)?.id).toBe(id("g"));
    expect(objectOf(doc, node("c"), null)?.id).toBe(id("c"));
    expect(objectOf(doc, node("e"), null)?.id).toBe(id("e"));
    expect(objectOf(doc, node("l3"), null)).toBeNull();
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
    const hit = marquee(doc, { x: 5, y: 5, width: 35, height: 10 }, null);
    expect(hit.sort()).toEqual([id("g"), id("c")].sort());
    expect(marquee(doc, { x: 55, y: 0, width: 40, height: 10 }, null)).toEqual([]);
  });
});

it("inverse selects the other selectable objects", () => {
  const { doc, id } = fixture();
  expect(inverse(doc, [id("g"), id("d")], null).sort()).toEqual([id("c"), id("e")].sort());
});

it("is not editable when the Node is gone", () => {
  const { doc } = fixture();
  expect(editable(doc, undefined)).toBe(false);
});

/**
 * A one-pixel OffscreenCanvas whose glyphs are boxes 6 wide and 8 tall above their origin, one per
 * character but a space, laid out from where fillText puts the string.
 */
class GlyphBoxes {
  getContext() {
    let m: Matrix = [1, 0, 0, 1, 0, 0];
    const stack: Matrix[] = [];
    let alpha = 0;
    return {
      setTransform: (...t: Matrix) => {
        m = t;
      },
      transform: (...t: Matrix) => {
        m = multiply(m, t);
      },
      save: () => stack.push(m),
      restore: () => {
        m = stack.pop() ?? m;
      },
      clearRect: () => {
        alpha = 0;
      },
      fillText: (text: string, x: number, y: number) => {
        const [px, py] = applyTo(invert(m), 0.5, 0.5);
        [...text].forEach((c, i) => {
          const left = x + 6 * i;
          if (c !== " " && left <= px && px <= left + 6 && y - 8 <= py && py <= y) alpha = 255;
        });
      },
      getImageData: () => ({ data: [0, 0, 0, alpha] }),
    };
  }
}

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
    expect(hitTest(ctx, doc, 15, 40, 1, { scope: null })).toBe(t?.id);
    expect(hitTest(ctx, doc, 22, 40, 1, { scope: null })).toBeNull();
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
    expect(hitTest(ctx, doc, 15, 15, 1, { scope: null })).toBeNull();
    if (ring) doc.nodes.set(ring.id, { ...ring, fillRule: "nonzero" } as Node);
    expect(hitTest(ctx, doc, 15, 15, 1, { scope: null })).toBe(ring?.id);
    expect(rules).toEqual(["evenodd", "nonzero"]);
  });

  it("hits a Clipping Mask's content only inside its Clipping Path, which is never a hit itself", () => {
    const ctx = boxContext();
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
    expect(hitTest(ctx, doc, 8, 5, 1, { scope: null })).toBe(group.id);
    expect(hitTest(ctx, doc, 30, 30, 1, { scope: null })).toBeNull();
    expect(hitTest(ctx, doc, 65, 5, 1, { scope: null })).toBeNull();
  });

  it("hits a painted Clipping Path's Fill where it clips and its Stroke's outer half too (ADR-0051)", () => {
    const ctx = boxContext();
    const { doc, defaultLayerId: parentId } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 200, height: 100 }],
    });
    const [content, clip] = createNodes(doc, [
      { type: "rect", parentId, x: 0, y: 0, width: 50, height: 50 },
      { type: "rect", parentId, x: 40, y: 0, width: 40, height: 40 },
    ]).nodes as [Node, Node];
    const { group } = makeMask(doc, { clipNodeId: clip.id, contentIds: [content.id] });
    const unpainted = doc.nodes.get(clip.id) as ShapeNode;
    // Unpainted, as Make leaves it: nothing but the content hits.
    expect(hitTest(ctx, doc, 70, 20, 1, { scope: null })).toBeNull();
    expect(hitTest(ctx, doc, 83, 20, 1, { scope: null })).toBeNull();
    const fill = { type: "solid" as const, color: "#FF0000" };
    const pen = { cap: "butt", join: "miter", miterLimit: 10, dash: [] } as const;
    const stroke = { ...fill, color: "#0000FF", width: 10, ...pen, dash: [] };
    doc.nodes.set(clip.id, { ...unpainted, appearance: { fills: [fill], strokes: [stroke] } });
    for (const [x, y] of [
      [70, 20],
      [83, 20],
    ] as const) {
      expect(hitTest(ctx, doc, x, y, 1, { scope: null })).toBe(group.id);
      expect(hitTest(ctx, doc, x, y, 1, { leaf: true, scope: null })).toBe(clip.id);
    }
    // The content sits above the Fill, and the Stroke above the content.
    expect(hitTest(ctx, doc, 45, 20, 1, { leaf: true, scope: null })).toBe(content.id);
    expect(hitTest(ctx, doc, 41, 20, 1, { leaf: true, scope: null })).toBe(clip.id);
    expect(hitTest(ctx, doc, 90, 20, 1, { scope: null })).toBeNull();
  });

  it("hits a clipped Layer's content itself, only inside its Clipping Path, and a painted one's Stroke outside it (ADR-0053)", () => {
    const ctx = boxContext();
    const { doc, defaultLayerId: parentId } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 200, height: 100 }],
    });
    const [sub, clip] = createNodes(doc, [
      { type: "layer", parentId },
      { type: "rect", parentId, x: 40, y: 0, width: 40, height: 40 },
    ]).nodes as [Node, Node];
    const [content] = createNodes(doc, [
      { type: "rect", parentId: sub.id, x: 0, y: 0, width: 50, height: 50 },
    ]).nodes as [Node];
    makeMask(doc, { layerId: parentId });
    expect(hitTest(ctx, doc, 45, 20, 1, { scope: null })).toBe(content.id);
    expect(hitTest(ctx, doc, 20, 20, 1, { scope: null })).toBeNull();
    // Unpainted, the Clipping Path is never hit.
    expect(hitTest(ctx, doc, 70, 20, 1, { scope: null })).toBeNull();
    const pen = { cap: "butt", join: "miter", miterLimit: 10, dash: [] } as const;
    const stroke = { type: "solid" as const, color: "#0000FF", width: 10, ...pen, dash: [] };
    const unpainted = doc.nodes.get(clip.id) as ShapeNode;
    doc.nodes.set(clip.id, { ...unpainted, appearance: { fills: [], strokes: [stroke] } });
    expect(hitTest(ctx, doc, 83, 20, 1, { scope: null })).toBe(clip.id);
  });

  it("hits a text Clipping Mask's content only on its glyphs, and a painted text anywhere in its frame (ADR-0052)", () => {
    vi.stubGlobal("OffscreenCanvas", GlyphBoxes);
    const ctx = boxContext();
    const { doc, defaultLayerId: parentId } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 200, height: 100 }],
    });
    const [content, clip] = createNodes(doc, [
      { type: "rect", parentId, x: 0, y: 0, width: 100, height: 100 },
      { type: "text", parentId, x: 10, y: 50, content: "H H" },
    ]).nodes as [Node, Node];
    const { group } = makeMask(doc, { clipNodeId: clip.id, contentIds: [content.id] });
    const text = { ...(doc.nodes.get(clip.id) as Node), transform: [1, 0, 0, 1, 20, 0] } as Node;
    doc.nodes.set(clip.id, text);
    // Each H is a box from its origin 6 wide, 8 tall: 30 to 36 and 42 to 48, above y 50.
    expect(hitTest(ctx, doc, 33, 46, 1, { scope: null })).toBe(group.id);
    expect(hitTest(ctx, doc, 45, 46, 1, { leaf: true, scope: null })).toBe(content.id);
    expect(hitTest(ctx, doc, 39, 46, 1, { scope: null })).toBeNull();
    expect(hitTest(ctx, doc, 13, 46, 1, { scope: null })).toBeNull();
    const fill = { type: "solid" as const, color: "#FF0000" };
    doc.nodes.set(clip.id, { ...text, appearance: { fills: [fill], strokes: [] } } as Node);
    expect(hitTest(ctx, doc, 39, 46, 1, { leaf: true, scope: null })).toBe(clip.id);
    expect(hitTest(ctx, doc, 33, 46, 1, { leaf: true, scope: null })).toBe(content.id);
  });

  describe("a container's Appearance (ADR-0043)", () => {
    const rect = (name: string, x: number, filled = true) => ({
      type: "rect" as const,
      name,
      x,
      y: 0,
      width: 10,
      height: 10,
      appearance: { fills: filled ? [{ color: "#FF0000" }] : [], strokes: [] },
    });
    const stroke = (width: number) => ({ color: "#0000FF", width });
    /** Group g holding `children`, painted by `appearance`, in the default Layer. */
    const scene = (
      appearance: { fills?: object[]; strokes?: object[]; contents?: number },
      children: object[],
    ) => {
      const { doc, defaultLayerId: parentId } = createDocument({
        id: "d",
        name: "Doc",
        artboards: [{ width: 200, height: 100 }],
      });
      createNodes(doc, [
        {
          type: "group",
          name: "g",
          parentId,
          appearance: { fills: [], strokes: [], contents: 0, ...appearance },
          children,
        },
      ] as never);
      // By name, or by id for the default Layer and what hitTest returns.
      const node = (name: string) =>
        [...doc.nodes.values()].find((n) => n.name === name || n.id === name) as Node;
      const hit = (x: number, y: number, leaf = false) => {
        const id = hitTest(boxContext(), doc, x, y, 1, { leaf, scope: null });
        return id && node(id).name;
      };
      return { doc, node, hit, parentId };
    };

    it("hits a Stroke outside every child's Fill as the Group, and as the leaf it paints", () => {
      const { hit, node } = scene({ strokes: [stroke(4)] }, [rect("a", 0)]);
      expect([hit(11.5, 5), hit(11.5, 5, true)]).toEqual(["g", "a"]);
      Object.assign(node("g"), { appearance: undefined });
      expect(hit(11.5, 5)).toBeNull();
    });

    it("hits a hairline Stroke within the click tolerance, over the child it covers", () => {
      const { doc } = scene({ strokes: [stroke(0.1)] }, [rect("a", 0), rect("b", 8)]);
      const leafAt = (tolerance: number) =>
        hitTest(boxContext(), doc, 11.5, 5, tolerance, { leaf: true, scope: null });
      expect(doc.nodes.get(leafAt(4) ?? "")?.name).toBe("a");
      expect(doc.nodes.get(leafAt(1) ?? "")?.name).toBe("b");
    });

    it("hits a Fill inside an unfilled child", () => {
      const { hit } = scene({ fills: [{ color: "#00FF00" }] }, [rect("a", 0, false)]);
      expect([hit(5, 5), hit(5, 5, true)]).toEqual(["g", "a"]);
    });

    it("hits paints below the children only where no child is, and above before the child they cover", () => {
      // b's Fill covers a's right edge, where the Stroke paints a.
      const children = [rect("a", 0), rect("b", 8)];
      const at = (contents: number) => scene({ strokes: [stroke(2)], contents }, children).hit;
      expect(at(0)(10, 5, true)).toBe("a");
      expect(at(1)(10, 5, true)).toBe("b");
      expect(at(1)(-0.5, 5, true)).toBe("a");
    });

    it("hits a Layer's paint as the object that holds the painted leaf", () => {
      const { hit, node, parentId } = scene({}, [rect("a", 0)]);
      Object.assign(node(parentId), {
        appearance: { fills: [], strokes: [stroke(4)], contents: 0 },
      });
      expect([hit(11.5, 5), hit(11.5, 5, true)]).toEqual(["g", "a"]);
    });

    it("lets the click through a locked Group, a locked or hidden painted leaf", () => {
      const lockedGroup = scene({ strokes: [stroke(4)] }, [rect("a", 0)]);
      lockedGroup.node("g").locked = true;
      const inner = { type: "group", name: "i", children: [rect("a", 0)] };
      const lockedLeaf = scene({ strokes: [stroke(4)] }, [inner]);
      lockedLeaf.node("i").locked = true;
      const hidden = scene({ strokes: [stroke(4)] }, [rect("a", 0)]);
      hidden.node("a").visible = false;
      expect([lockedGroup, lockedLeaf, hidden].map((s) => s.hit(11.5, 5, true))).toEqual([
        null,
        null,
        null,
      ]);
    });

    it("hits a paint on a text anywhere in its frame, over a sibling it covers", () => {
      // The text's frame is (10, 38)-(20.776, 53.912); b covers part of it, above it.
      const text = { type: "text", name: "t", x: 10, y: 50, content: "Hi" };
      const b = { ...rect("b", 12), y: 40 };
      const { hit, node } = scene({ strokes: [stroke(1)] }, [text, b]);
      expect(hit(15, 45, true)).toBe("t");
      Object.assign(node("g"), { appearance: undefined });
      expect(hit(15, 45, true)).toBe("b");
    });

    it("hits a paint on an inner Clipping Mask's leaf only inside that mask's Clipping Path", () => {
      const { doc, hit, node } = scene({ strokes: [stroke(4)] }, []);
      const [content, clip] = createNodes(doc, [
        { ...rect("content", 0, false), parentId: node("g").id, width: 50 },
        { ...rect("clip", 0), parentId: node("g").id, width: 30 },
      ]).nodes as [Node, Node];
      makeMask(doc, { clipNodeId: clip.id, contentIds: [content.id] });
      // 1.5 inside the top edge: only the Group's Stroke, not the leaf's hairline, reaches it.
      expect(hit(5, 1.5, true)).toBe("content");
      expect(hit(40, 1.5, true)).toBeNull();
    });

    it("hits no paint of a Clipping Mask outside its Clipping Path", () => {
      const { doc, hit, node } = scene({}, []);
      const [content, clip] = createNodes(doc, [
        { ...rect("content", 0), parentId: node("g").id, width: 50 },
        { ...rect("clip", 0), parentId: node("g").id, width: 30 },
      ]).nodes as [Node, Node];
      const { group } = makeMask(doc, { clipNodeId: clip.id, contentIds: [content.id] });
      Object.assign(group, { appearance: { fills: [], strokes: [stroke(4)], contents: 0 } });
      expect(hit(50, 5, true)).toBeNull();
      expect(hit(0, 5, true)).toBe("content");
    });
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
    expect(placeParent(doc, [id("a"), id("d")], null)).toBe(id("l1"));
    expect(placeParent(doc, [id("e")], null)).toBe(id("l3"));
    expect(placeParent(doc, [], null)).toBe(id("l2"));
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

describe("in Isolation Mode (ADR-0057)", () => {
  /**
   * Layer: rect bg (0–100), Clip Group g: content (10–90 × 10–40) clipped by an unpainted clip
   * (20–60 × 10–40), and a nested Clip Group n (45–55 × 15–25).
   */
  function isolated() {
    const { doc, defaultLayerId: parentId } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 200, height: 100 }],
    });
    const rect = (x: number, y: number, width: number, height: number) =>
      ({ type: "rect", parentId, x, y, width, height }) as const;
    const [bg, content, inner, innerClip, clip] = createNodes(doc, [
      rect(0, 0, 100, 100),
      rect(10, 10, 80, 30),
      rect(45, 15, 10, 10),
      rect(45, 15, 10, 10),
      rect(20, 10, 40, 30),
    ]).nodes as Node[] as [Node, Node, Node, Node, Node];
    const { group: n } = makeMask(doc, { clipNodeId: innerClip.id, contentIds: [inner.id] });
    const { group: g } = makeMask(doc, { clipNodeId: clip.id, contentIds: [content.id, n.id] });
    return { doc, bg, content, inner, clip, n, g, parentId };
  }

  it("picks the outermost object below the isolated Group, only where it is visible", () => {
    const ctx = boxContext();
    const { doc, content, n, g } = isolated();
    const scope = g.id;
    expect(hitTest(ctx, doc, 40, 30, 1, { scope })).toBe(content.id);
    expect(hitTest(ctx, doc, 50, 20, 1, { scope })).toBe(n.id);
    // Outside the Clipping Path the content is not drawn, and bg is outside the scope.
    expect(hitTest(ctx, doc, 75, 30, 1, { scope })).toBeNull();
    expect(hitTest(ctx, doc, 5, 5, 1, { scope })).toBeNull();
  });

  it("hits the isolated Group's unpainted Clipping Path on its outline, not inside it", () => {
    const ctx = boxContext();
    const { doc, content, clip, g } = isolated();
    expect(hitTest(ctx, doc, 20.4, 30, 1, { scope: g.id })).toBe(clip.id);
    expect(hitTest(ctx, doc, 60, 30, 1, { scope: g.id })).toBe(clip.id);
    expect(hitTest(ctx, doc, 25, 30, 1, { scope: g.id })).toBe(content.id);
  });

  it("hits a painted Clipping Path as it does outside Isolation Mode", () => {
    const ctx = boxContext();
    const { doc, content, clip, g } = isolated();
    const pen = { cap: "butt", join: "miter", miterLimit: 10, dash: [] } as const;
    const stroke = { type: "solid" as const, color: "#0000FF", width: 4, ...pen, dash: [] };
    doc.nodes.set(clip.id, {
      ...(doc.nodes.get(clip.id) as ShapeNode),
      appearance: { fills: [], strokes: [stroke] },
    } as Node);
    expect(hitTest(ctx, doc, 21.5, 30, 1, { scope: g.id })).toBe(clip.id);
    expect(hitTest(ctx, doc, 21.5, 30, 1, { scope: null })).toBe(g.id);
    expect(hitTest(ctx, doc, 25, 30, 1, { scope: g.id })).toBe(content.id);
  });

  it("leaves everything unchanged without a scope", () => {
    const ctx = boxContext();
    const { doc, bg, g } = isolated();
    expect(hitTest(ctx, doc, 40, 30, 1, { scope: null })).toBe(g.id);
    expect(hitTest(ctx, doc, 20.4, 30, 1, { scope: null })).toBe(g.id);
    expect(hitTest(ctx, doc, 75, 30, 1, { scope: null })).toBe(bg.id);
  });

  it("hits only leaves in scope for Direct Selection", () => {
    const ctx = boxContext();
    const { doc, inner, g } = isolated();
    expect(hitTest(ctx, doc, 50, 20, 1, { leaf: true, scope: g.id })).toBe(inner.id);
    expect(hitTest(ctx, doc, 5, 5, 1, { leaf: true, scope: g.id })).toBeNull();
    expect(
      pick(doc, { selection: [], anchors: [], x: 0, y: 0, tolerance: 1, scope: g.id }),
    ).toBeNull();
    expect(
      pick(doc, { selection: [], anchors: [], x: 0, y: 0, tolerance: 1, scope: null }),
    ).not.toBeNull();
    const all = { x: -5, y: -5, width: 200, height: 200 };
    const nodes = (keys: string[]) => new Set(keys.map((k) => parseKey(k).nodeId));
    // Every path in the Group, the Clipping Paths included, and none outside it.
    expect(nodes(marqueeAnchors(doc, all, g.id)).size).toBe(4);
    expect(nodes(marqueeAnchors(doc, all, null)).size).toBe(5);
  });

  it("keeps a marquee, Select All and Inverse in the isolated Group, its Clipping Path included", () => {
    const { doc, bg, content, clip, n, g } = isolated();
    const all = { x: -5, y: -5, width: 200, height: 200 };
    const inside = [content.id, n.id, clip.id].sort();
    expect(marquee(doc, all, g.id).sort()).toEqual(inside);
    expect(marquee(doc, all, null).sort()).toEqual([bg.id, g.id].sort());
    expect(
      objects(doc, g.id)
        .map((o) => o.id)
        .sort(),
    ).toEqual(inside);
    expect(inverse(doc, [content.id], g.id).sort()).toEqual([n.id, clip.id].sort());
  });

  it("puts Place and new art in the isolated Group", () => {
    const { doc, bg, g, parentId } = isolated();
    expect(placeParent(doc, [bg.id], g.id)).toBe(g.id);
    expect(placeParent(doc, [bg.id], null)).toBe(parentId);
  });

  it("keeps the clip of a Layer Clipping Mask above the isolated Group", () => {
    const ctx = boxContext();
    const { doc, content, g, parentId } = isolated();
    createNodes(doc, [{ type: "rect", parentId, x: 0, y: 0, width: 30, height: 100 }]);
    makeMask(doc, { layerId: parentId });
    expect(hitTest(ctx, doc, 25, 30, 1, { scope: g.id })).toBe(content.id);
    expect(hitTest(ctx, doc, 40, 30, 1, { scope: g.id })).toBeNull();
    // The isolated Group's own Clipping Path, outside the Layer's, is not drawn there either.
    expect(hitTest(ctx, doc, 60, 30, 1, { scope: g.id })).toBeNull();
  });

  it("hits a text Clipping Path on its frame's edges, leaving the content inside it reachable", () => {
    vi.stubGlobal("OffscreenCanvas", GlyphBoxes);
    const ctx = boxContext();
    const { doc, defaultLayerId: parentId } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 200, height: 100 }],
    });
    const [content, clip] = createNodes(doc, [
      { type: "rect", parentId, x: 0, y: 0, width: 100, height: 100 },
      { type: "text", parentId, x: 30, y: 50, content: "H H" },
    ]).nodes as [Node, Node];
    const { group } = makeMask(doc, { clipNodeId: clip.id, contentIds: [content.id] });
    const b = bounds(doc, doc.nodes.get(clip.id) as Node) as Rect;
    const scope = group.id;
    // The frame's top edge, between the glyphs.
    expect(hitTest(ctx, doc, 39, b.y, 1, { scope })).toBe(clip.id);
    expect(hitTest(ctx, doc, 33, 46, 1, { scope })).toBe(content.id);
    expect(hitTest(ctx, doc, 39, 46, 1, { scope })).toBeNull();
    // Outside Isolation Mode the unpainted text still hits nothing.
    expect(hitTest(ctx, doc, 39, b.y, 1, { scope: null })).toBeNull();
  });
});
