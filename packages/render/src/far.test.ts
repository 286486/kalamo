import {
  createDocument,
  createNodes,
  type Document,
  makeMask,
  type Node,
  type RenderScope,
} from "@zibel/core";
import { scopeRect, toSvg } from "@zibel/io";
import { describe, expect, it } from "vitest";
import { RED_2x2_PNG } from "../../../fixtures/images.ts";
import { svgToPixels } from "./png.ts";
import { fit, renderSvg } from "./svg.ts";

// resvg panics on an isolated Node whose content lies more than about two image sides outside the
// image (ADR-0054), or its parent layer's (ADR-0055): these Documents hold such Nodes, which
// `render` must leave out or bound.

const SRC = "a".repeat(64);
const images = () => RED_2x2_PNG;
const RED = { fills: [{ color: "#FF0000" }], strokes: [] };
const BLUE = { fills: [{ color: "#0000FF" }], strokes: [] };
const rect = (x: number, y: number, width = 20, height = 20, appearance: object = RED) =>
  ({ type: "rect", x, y, width, height, appearance }) as const;
const dot = (x: number, y: number, size = 5) =>
  ({ type: "ellipse", x, y, width: size, height: size }) as const;
/** Far outside any rect these tests render: the Artboard is 100 × 100 at (0, 0). */
const FAR = 1000;

/** Names a Node spec that `make` gives opacity 0.5, which a create cannot set. */
const TRANSLUCENT = "translucent";
/**
 * Creates the Nodes under `parentId`, returning every Node made, each container before its
 * children; one named TRANSLUCENT gets opacity 0.5.
 */
function make(doc: Document, parentId: string | null, specs: object[]) {
  const { nodes } = createNodes(doc, specs.map((s) => ({ parentId, ...s })) as never);
  for (const n of nodes) if (n.name === TRANSLUCENT) n.opacity = 0.5;
  return nodes as Node[];
}
const look = (n: Node | undefined, s: Partial<Node>) => Object.assign(n as Node, s);
/** A kind that makes one Node, and its children, in the given look. */
const one =
  (spec: object, s: Partial<Node>) =>
  (doc: Document, p: string): void =>
    void look(make(doc, p, [spec])[0], s);

/** One white 100 × 100 Artboard with a blue rect at (20, 20), 20 × 20. */
function newDoc() {
  const { doc, defaultLayerId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 100, height: 100, background: "#FFFFFF" }],
  });
  doc.images.set(SRC, { mime: "image/png", width: 2, height: 2 });
  const [blue] = make(doc, defaultLayerId, [rect(20, 20, 20, 20, BLUE)]);
  return { doc, defaultLayerId, blueId: (blue as Node).id };
}

/** A translucent rect inside the image, the Node an isolated parent's layer must still hold. */
const translucent = () => ({ ...rect(60, 60, 10, 10), name: TRANSLUCENT });
/** Reaches from far left of the image into it, so it is kept and its parent's layer starts far out. */
const farLeft = () => rect(-500, 10, 520, 20);
/** A far-left child, then a translucent one, under a parent of `spec` in look `s`. */
const nested = (spec: object, s: Partial<Node>) =>
  one({ ...spec, children: [farLeft(), translucent()] }, s);
/** A Clipping Mask of a near circle over a far-left child and a translucent one; its clip made by `paint`. */
const nestedMask =
  (paint: Partial<Node> = {}) =>
  (doc: Document, p: string) => {
    const [a, b, clip] = make(doc, p, [farLeft(), translucent(), dot(0, 0, 90)]) as Node[];
    look(clip, paint);
    makeMask(doc, { clipNodeId: clip?.id ?? "", contentIds: [a?.id ?? "", b?.id ?? ""] });
  };

/**
 * An isolated parent reaching far left, holding an isolated Node inside the image: resvg bands the
 * nested layer in its parent layer's pixels, so it panics without ADR-0055's bound (#129).
 */
const NESTED: Record<string, (doc: Document, layerId: string) => void> = {
  "the #129 repro, a translucent Group over a far-left child and a translucent one": nested(
    { type: "group" },
    { opacity: 0.5 },
  ),
  "a blended Group holding a translucent child": nested({ type: "group" }, { blendMode: "screen" }),
  "a translucent Group reaching far above": one(
    { type: "group", children: [rect(10, -500, 20, 520), translucent()] },
    { opacity: 0.5 },
  ),
  "a Group Clipping Mask with far content holding a translucent child": nestedMask(),
  "a Layer Clipping Mask with far content holding a translucent child": (doc, p) => {
    const [layer] = make(doc, p, [{ type: "layer" }]) as [Node];
    make(doc, layer.id, [farLeft(), translucent(), dot(0, 0, 90)]);
    makeMask(doc, { layerId: layer.id });
  },
  "a painted Clipping Path's wrapper around far content and a translucent child (ADR-0051)":
    nestedMask({
      appearance: { fills: [], strokes: [{ type: "solid", color: "#00FF00" }] } as never,
    }),
  "a translucent container Appearance painting far content inside an inner Clipping Mask": (
    doc,
    p,
  ) => {
    const [painter, , content, clip] = make(doc, p, [
      {
        type: "group",
        appearance: { fills: [{ color: "#00FF00" }] },
        children: [farLeft(), dot(0, 0, 90), translucent()],
      },
    ]) as Node[];
    look(painter, { opacity: 0.5 });
    makeMask(doc, { clipNodeId: clip?.id ?? "", contentIds: [content?.id ?? ""] });
  },
  "isolated Groups three deep, each reaching far left": (doc, p) => {
    const [a, , b, , c] = make(doc, p, [
      {
        type: "group",
        children: [
          farLeft(),
          {
            type: "group",
            children: [
              rect(-400, 40, 420, 5),
              { type: "group", children: [rect(-300, 50, 320, 5), translucent()] },
            ],
          },
        ],
      },
    ]);
    look(a, { opacity: 0.5 });
    look(b, { blendMode: "multiply" });
    look(c, { opacity: 0.5 });
  },
};

/** Far isolated content of each kind, made under a Layer. */
const KINDS: Record<string, (doc: Document, layerId: string) => void> = {
  "a translucent leaf": one(rect(FAR, 0), { opacity: 0.5 }),
  "a blended leaf": one(rect(FAR, 0), { blendMode: "multiply" }),
  "a translucent Group": one(
    { type: "group", children: [rect(FAR, 0), rect(FAR + 30, 0)] },
    {
      opacity: 0.5,
    },
  ),
  "a Group Clipping Mask": (doc, p) => {
    const [content, clip] = make(doc, p, [rect(FAR, 0), dot(FAR + 5, 5)]) as [Node, Node];
    makeMask(doc, { clipNodeId: clip.id, contentIds: [content.id] });
  },
  "a Layer Clipping Mask": (doc, p) => {
    const [layer] = make(doc, p, [{ type: "layer" }]) as [Node];
    make(doc, layer.id, [rect(FAR, 0), dot(FAR + 5, 5)]);
    makeMask(doc, { layerId: layer.id });
  },
  "a Clipping Mask with a near Clipping Path and far content": (doc, p) => {
    const [content, clip] = make(doc, p, [rect(FAR, 0), dot(60, 60, 10)]) as [Node, Node];
    makeMask(doc, { clipNodeId: clip.id, contentIds: [content.id] });
  },
  "an Image with opacity": one(
    { type: "image", src: SRC, x: FAR, y: 0, width: 20, height: 20 },
    { opacity: 0.5 },
  ),
  "a text with opacity": one({ type: "text", x: FAR, y: 50, content: "Hi" }, { opacity: 0.5 }),
  "a container Appearance painting far content inside an inner Clipping Mask": (doc, p) => {
    const [, , content, clip] = make(doc, p, [
      {
        type: "group",
        appearance: { fills: [{ color: "#00FF00" }] },
        children: [rect(60, 60, 10, 10), rect(FAR, 0), dot(80, 80)],
      },
    ]) as [Node, Node, Node, Node];
    makeMask(doc, { clipNodeId: clip.id, contentIds: [content.id] });
  },
  "a nested isolated Node inside a kept container": (doc, p) => {
    const [outer, , inner] = make(doc, p, [
      {
        type: "group",
        children: [
          rect(60, 60, 10, 10),
          { type: "group", children: [rect(FAR, 0), rect(FAR + 30, 0)] },
        ],
      },
    ]);
    look(outer, { opacity: 0.5 });
    look(inner, { blendMode: "screen" });
  },
  ...NESTED,
};

/**
 * The Document with the kind's far content, and a scope of the Render Scope named. The nodeIds
 * scope lists a Layer Clipping Mask whose Clipping Path is near and whose content is the far kind.
 */
function setUp(scopeName: string, kind: (doc: Document, layerId: string) => void) {
  const { doc, defaultLayerId, blueId } = newDoc();
  if (scopeName !== "nodeIds") {
    kind(doc, defaultLayerId);
    const scope: RenderScope | undefined =
      scopeName === "artboardId"
        ? { artboardId: doc.artboards[0]?.id ?? "" }
        : scopeName === "rect"
          ? { rect: { x: 0, y: 0, width: 50, height: 50 } }
          : undefined;
    return { doc, scope };
  }
  const [layer] = make(doc, null, [{ type: "layer" }]) as [Node];
  kind(doc, layer.id);
  make(doc, layer.id, [dot(0, 0, 60)]);
  makeMask(doc, { layerId: layer.id });
  return { doc, scope: { nodeIds: [blueId, layer.id] } };
}

/** `render`'s pixels of the scope at `scale`, and the RGBA of a Document point. */
async function render(doc: Document, scope: RenderScope | undefined, scale = 1) {
  const { rect, pixelSize } = fit(scopeRect(doc, scope), scale);
  const { pixels, width, height } = await svgToPixels(
    renderSvg(doc, rect, { scope, scale, images }),
    scale,
  );
  expect({ width, height }).toEqual(pixelSize);
  const at = (x: number, y: number) => {
    const i = (Math.floor((y - rect.y) * scale) * width + Math.floor((x - rect.x) * scale)) * 4;
    return [...pixels.subarray(i, i + 4)];
  };
  return { rect, pixels, at };
}

describe.each(["artboardId", "rect", "Document", "nodeIds"])("the %s scope", (scopeName) => {
  it.each(Object.keys(KINDS))("renders its artwork past far content: %s", async (kind) => {
    const { doc, scope } = setUp(scopeName, KINDS[kind] as never);
    const { at } = await render(doc, scope);
    expect(at(30, 30)).toEqual([0, 0, 255, 255]);
  });
});

it("draws the pixels uncut toSvg draws when isolated Nodes lie one to two image sides out", async () => {
  const { doc, defaultLayerId } = newDoc();
  // Left and above only: past the right or bottom edge resvg panics beyond one image side.
  for (const [spec, s] of [
    [rect(-150, 30), { opacity: 0.5 }],
    [rect(30, -170), { blendMode: "multiply" }],
    [{ type: "group", children: [rect(-180, -180), rect(-150, 60)] }, { opacity: 0.5 }],
    [{ type: "text", x: -180, y: 50, content: "Hi" }, { opacity: 0.5 }],
  ] as const) {
    look(make(doc, defaultLayerId, [spec])[0], s);
  }
  const [content, clip] = make(doc, defaultLayerId, [rect(-170, 60), dot(-165, 65)]) as [
    Node,
    Node,
  ];
  makeMask(doc, { clipNodeId: clip.id, contentIds: [content.id] });
  // Partly inside, so kept: its layer reaches the image.
  look(make(doc, defaultLayerId, [rect(90, 80, 200, 10)])[0], { opacity: 0.5 });
  const scope = { artboardId: doc.artboards[0]?.id ?? "" };
  const { rect: r, pixels } = await render(doc, scope);
  const uncut = await svgToPixels(toSvg(doc, r, { scope, images, linked: "draw" }), 1);
  expect(pixels).toEqual(uncut.pixels);
});

it("draws the in-rect pixels of a Node partly inside, and of one only its Stroke reaches", async () => {
  const { doc, defaultLayerId } = newDoc();
  const [wide, stroked] = make(doc, defaultLayerId, [
    rect(90, 2, 2 * FAR, 5),
    // Its outline lies 1.1 image sides below; its Stroke's outer half reaches back up to y = 10.
    rect(40, 210, 20, 10, { fills: [], strokes: [{ color: "#00FF00", width: 400 }] }),
  ]);
  look(wide, { opacity: 0.5 });
  look(stroked, { opacity: 0.5 });
  const { at } = await render(doc, { artboardId: doc.artboards[0]?.id ?? "" });
  const near = (got: number[], rgb: number[]) =>
    rgb.every((v, i) => Math.abs((got[i] ?? 0) - v) <= 1);
  expect(at(95, 4)).toSatisfy((got: number[]) => near(got, [255, 128, 128]));
  expect(at(70, 50)).toSatisfy((got: number[]) => near(got, [128, 255, 128]));
});

it("draws a painted Clipping Path whose content lies far away (ADR-0051)", async () => {
  const { doc, defaultLayerId } = newDoc();
  const [content, clip] = make(doc, defaultLayerId, [rect(FAR, 0), dot(60, 60, 20)]) as [
    Node,
    Node,
  ];
  makeMask(doc, { clipNodeId: clip.id, contentIds: [content.id] });
  look(doc.nodes.get(clip.id), {
    appearance: { fills: [{ type: "solid", color: "#00FF00" }], strokes: [] },
  });
  const { at } = await render(doc, { artboardId: doc.artboards[0]?.id ?? "" });
  expect(at(70, 70)).toEqual([0, 255, 0, 255]);
});

it("draws the whole of a nested translucent rect, not only its columns within two sides of its parent's layer (#129)", async () => {
  const { doc, defaultLayerId } = newDoc();
  look(
    make(doc, defaultLayerId, [
      {
        type: "group",
        children: [rect(-150, 70, 160, 10), { ...rect(30, 50, 50, 10), name: TRANSLUCENT }],
      },
    ])[0],
    { opacity: 0.5 },
  );
  const { at } = await render(doc, { artboardId: doc.artboards[0]?.id ?? "" });
  const colour = at(30, 55);
  expect(colour).not.toEqual([255, 255, 255, 255]);
  for (let x = 30; x < 80; x++) expect(at(x, 55), `column ${x}`).toEqual(colour);
  expect(at(80, 55)).toEqual([255, 255, 255, 255]);
});

describe("an isolated parent and a nested isolated Node anywhere along an axis (#129)", () => {
  // Image sides 4, 16 and 100 px, and a wide, short one; positions in image sides.
  const images = [
    { rect: { x: 0, y: 0, width: 100, height: 100 }, scale: 0.04 },
    { rect: { x: 0, y: 0, width: 100, height: 100 }, scale: 0.16 },
    { rect: { x: 0, y: 0, width: 100, height: 100 }, scale: 1 },
    { rect: { x: 0, y: 0, width: 100, height: 8 }, scale: 1 },
  ];
  const cases = images.flatMap((image) =>
    ["x", "y"].flatMap((axis) =>
      [-50, -4, -2, -1.2, -0.5, 0].flatMap((parent) =>
        [-2, -0.3, 0.5, 0.9, 1.3, 2].map((child) => ({ ...image, axis, parent, child })),
      ),
    ),
  );
  it.each(cases)(
    "renders: $rect.width × $rect.height at $scale, along $axis, parent from $parent, child at $child",
    async ({ rect: r, scale, axis, parent, child }) => {
      const { doc, defaultLayerId } = newDoc();
      const side = axis === "x" ? r.width : r.height;
      // A child from `parent` sides out into the image, and a nested one a tenth of a side long.
      const along = (from: number, length: number) =>
        axis === "x"
          ? rect(from, 0.1 * r.height, length, 0.1 * r.height)
          : rect(0.1 * r.width, from, 0.1 * r.width, length);
      look(
        make(doc, defaultLayerId, [
          {
            type: "group",
            children: [
              along(parent * side, (0.2 - parent) * side),
              { ...along(child * side, 0.1 * side), name: TRANSLUCENT },
            ],
          },
        ])[0],
        { opacity: 0.5 },
      );
      await render(doc, { rect: r }, scale);
    },
  );
});

it("relies on resvg sizing a filtered layer from its filter region (ADR-0055)", async () => {
  // The #129 repro with the bound render writes: without the filter, resvg 2.6.2 panics.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><filter id="bound" filterUnits="userSpaceOnUse" x="-50" y="-50" width="200" height="200" color-interpolation-filters="sRGB"><feOffset/></filter></defs><g opacity=".5" filter="url(#bound)"><rect x="-500" y="10" width="520" height="20"/><rect x="30" y="30" width="20" height="20" opacity=".5"/></g></svg>`;
  const drawn = await svgToPixels(svg, 1).catch((e: unknown) => {
    throw new Error(
      `resvg no longer sizes a filtered layer from its filter region, which render's bound relies on (ADR-0055): ${e}`,
    );
  });
  expect(drawn.width).toBe(100);
});
