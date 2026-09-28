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
// image (ADR-0054): these Documents hold such Nodes, which `render` must leave out.

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

/** Creates the Nodes under `parentId`, returning every Node made, each container before its children. */
const make = (doc: Document, parentId: string | null, specs: object[]) =>
  createNodes(doc, specs.map((s) => ({ parentId, ...s })) as never).nodes as Node[];
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
