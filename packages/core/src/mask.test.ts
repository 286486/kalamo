import { describe, expect, it } from "vitest";
import { bounds, childrenOf, createDocument, createNodes } from "./document.ts";
import { ZibelError } from "./errors.ts";
import { makeMask, releaseMask } from "./mask.ts";
import type { Node } from "./schema.ts";

const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ZibelError) return e.data;
    throw e;
  }
  throw new Error("expected a ZibelError");
};

/** Under the Layer, bottom to top: below, a, clip (an ellipse), b, above; a text; a Group. */
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
  const [below, a, clip, b, above, text, group] = createNodes(doc, [
    rect(0),
    rect(10),
    { type: "ellipse", parentId: layerId, x: 20, y: 20, width: 20, height: 20 },
    rect(30),
    rect(40),
    { type: "text", parentId: layerId, x: 0, y: 100, content: "Hi" },
    {
      type: "group",
      parentId: layerId,
      children: [(({ parentId: _, ...child }) => child)(rect(0))],
    },
  ]).nodes as [Node, Node, Node, Node, Node, Node, Node];
  return { doc, layerId, below, a, clip, b, above, text, group };
}

describe("makeMask", () => {
  it("groups the members at the topmost one's place, keeping their stacking order", () => {
    const s = scene();
    const { group, updated } = makeMask(s.doc, {
      clipNodeId: s.clip.id,
      contentIds: [s.b.id, s.a.id],
    });
    expect(childrenOf(s.doc, s.layerId).map((n) => n.id)).toEqual([
      s.below.id,
      group.id,
      s.above.id,
      s.text.id,
      s.group.id,
    ]);
    expect(childrenOf(s.doc, group.id).map((n) => n.id)).toEqual([s.a.id, s.clip.id, s.b.id]);
    expect(group).toMatchObject({ type: "group", name: "", parentId: s.layerId });
    expect(updated.map((n) => n.id).sort()).toEqual([s.a.id, s.clip.id, s.b.id].sort());
  });

  it("makes the clip Node the Clipping Path and empties its Appearance, as Illustrator does", () => {
    const s = scene();
    const { group } = makeMask(s.doc, { clipNodeId: s.clip.id, contentIds: [s.a.id] });
    expect(s.doc.nodes.get(s.clip.id)).toMatchObject({
      clipping: true,
      appearance: { fills: [], strokes: [] },
    });
    expect(bounds(s.doc, group)).toEqual({ x: 20, y: 20, width: 20, height: 20 });
  });

  it("clips a Group", () => {
    const s = scene();
    const { group } = makeMask(s.doc, { clipNodeId: s.clip.id, contentIds: [s.group.id] });
    expect(s.doc.nodes.get(s.group.id)?.parentId).toBe(group.id);
  });

  it.each<[string, (s: ReturnType<typeof scene>) => object, string, string]>([
    [
      "an unknown clip",
      () => ({ clipNodeId: "nope", contentIds: ["x"] }),
      "NODE_NOT_FOUND",
      "clipNodeId",
    ],
    [
      "an unknown content Node",
      (s) => ({ clipNodeId: s.clip.id, contentIds: [s.a.id, "nope"] }),
      "NODE_NOT_FOUND",
      "contentIds[1]",
    ],
    [
      "a text as the clip",
      (s) => ({ clipNodeId: s.text.id, contentIds: [s.a.id] }),
      "INVALID_MASK",
      "clipNodeId",
    ],
    [
      "a Group as the clip",
      (s) => ({ clipNodeId: s.group.id, contentIds: [s.a.id] }),
      "INVALID_MASK",
      "clipNodeId",
    ],
    [
      "the clip among the content",
      (s) => ({ clipNodeId: s.clip.id, contentIds: [s.clip.id] }),
      "INVALID_MASK",
      "contentIds[0]",
    ],
    [
      "a Layer as content",
      (s) => ({ clipNodeId: s.clip.id, contentIds: [s.layerId] }),
      "INVALID_MASK",
      "contentIds[0]",
    ],
    [
      "content under another parent",
      (s) => ({ clipNodeId: s.clip.id, contentIds: [childrenOf(s.doc, s.group.id)[0]?.id] }),
      "INVALID_MASK",
      "contentIds[0]",
    ],
    [
      "an opacity mask",
      (s) => ({ clipNodeId: s.clip.id, contentIds: [s.a.id], kind: "opacity" }),
      "INVALID_MASK",
      "kind",
    ],
  ])("refuses %s", (_, input, code, path) => {
    const s = scene();
    const before = [...s.doc.nodes.values()];
    const e = errorOf(() => makeMask(s.doc, input(s) as never));
    expect(e).toMatchObject({ code, path, hint: expect.stringMatching(/\S/) });
    expect([...s.doc.nodes.values()]).toEqual(before);
  });

  it("refuses a Clipping Path as content, which would give a Group two", () => {
    const s = scene();
    const { group } = makeMask(s.doc, { clipNodeId: s.clip.id, contentIds: [s.a.id] });
    const [c2] = createNodes(s.doc, [
      { type: "rect", parentId: group.id, x: 0, y: 0, width: 5, height: 5 },
    ]).nodes as [Node];
    const before = [...s.doc.nodes.values()];
    expect(
      errorOf(() => makeMask(s.doc, { clipNodeId: c2.id, contentIds: [s.a.id, s.clip.id] })),
    ).toMatchObject({ code: "INVALID_MASK", path: "contentIds[1]" });
    expect([...s.doc.nodes.values()]).toEqual(before);
  });

  it("refuses a clip that already clips", () => {
    const s = scene();
    makeMask(s.doc, { clipNodeId: s.clip.id, contentIds: [s.a.id] });
    expect(
      errorOf(() => makeMask(s.doc, { clipNodeId: s.clip.id, contentIds: [s.b.id] })),
    ).toMatchObject({ code: "INVALID_MASK", path: "clipNodeId" });
  });
});

describe("releaseMask", () => {
  const masked = () => {
    const s = scene();
    const { group } = makeMask(s.doc, { clipNodeId: s.clip.id, contentIds: [s.a.id] });
    return { ...s, mask: group };
  };

  it.each(["mask", "clip"])(
    "releases from the %s's id, keeping the Group and the unpainted Path",
    (by) => {
      const s = masked();
      const { nodes } = releaseMask(s.doc, [(by === "mask" ? s.mask : s.clip).id]);
      const clip = s.doc.nodes.get(s.clip.id);
      expect(clip && "clipping" in clip).toBe(false);
      expect(clip).toMatchObject({ parentId: s.mask.id, appearance: { fills: [], strokes: [] } });
      expect(nodes.map((n) => n.id)).toEqual([s.clip.id]);
      expect(bounds(s.doc, s.mask)).toEqual({ x: 10, y: 0, width: 50, height: 50 });
    },
  );

  it("keeps the Appearance the Clipping Path was given (ADR-0051)", () => {
    const s = masked();
    const appearance = {
      fills: [{ type: "solid" as const, color: "#ff0000" }],
      strokes: [
        {
          type: "solid" as const,
          color: "#0000ff",
          width: 4,
          cap: "butt" as const,
          join: "miter" as const,
          miterLimit: 4,
          dash: [],
        },
      ],
    };
    const clip = s.doc.nodes.get(s.clip.id) as Node;
    s.doc.nodes.set(clip.id, { ...clip, appearance } as Node);
    releaseMask(s.doc, [s.mask.id]);
    expect(s.doc.nodes.get(s.clip.id)).toMatchObject({ appearance });
  });

  it("releases once when both ids are listed", () => {
    const s = masked();
    expect(releaseMask(s.doc, [s.mask.id, s.clip.id]).nodes).toHaveLength(1);
  });

  it("refuses a Group that does not clip", () => {
    const s = masked();
    expect(errorOf(() => releaseMask(s.doc, [s.group.id]))).toMatchObject({
      code: "INVALID_MASK",
      path: "nodeIds[0]",
    });
  });
});

describe("an Image", () => {
  const withImage = () => {
    const { doc, defaultLayerId: parentId } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 200, height: 200 }],
    });
    const src = "a".repeat(64);
    doc.images.set(src, { mime: "image/png", width: 40, height: 40 });
    const [image, rect] = createNodes(doc, [
      { type: "image", parentId, src, x: 0, y: 0 },
      { type: "rect", parentId, x: 10, y: 10, width: 20, height: 20 },
    ]).nodes as [Node, Node];
    return { doc, image, rect };
  };

  it("is cropped by a Clipping Mask to the clip's bounds", () => {
    const { doc, image, rect } = withImage();
    const { group } = makeMask(doc, { clipNodeId: rect.id, contentIds: [image.id] });
    expect(bounds(doc, group)).toEqual({ x: 10, y: 10, width: 20, height: 20 });
  });

  it("cannot be a Clipping Path", () => {
    const { doc, image, rect } = withImage();
    expect(
      errorOf(() => makeMask(doc, { clipNodeId: image.id, contentIds: [rect.id] })),
    ).toMatchObject({
      code: "INVALID_MASK",
      message: "A image cannot be a Clipping Path.",
    });
  });
});
