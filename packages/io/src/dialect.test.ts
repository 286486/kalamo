import {
  createDocument,
  createNodes,
  type Document,
  imageId,
  imageSource,
  parseDocument,
  type RenderScope,
  readImage,
  resolveImages,
  serializeDocument,
  withAlpha,
} from "@kalamo/core";
import { expect, it } from "vitest";
import { RED_2x2_PNG } from "../../../fixtures/images.ts";
import {
  alpha,
  arcAttrs,
  arcOf,
  idOf,
  paintAttrs,
  scopeAttr,
  scopeOf,
  starAttrs,
  starOf,
  xmlId,
} from "./dialect.ts";
import { parseSvg, resolveLinks } from "./read.ts";
import { toSvg } from "./write.ts";

const fixtures = import.meta.glob("../../../fixtures/documents/*.kalamo.json", {
  query: "?raw",
  import: "default",
  eager: true,
});

const open = (text: string): Document => {
  const file = parseDocument(text);
  return {
    ...file,
    id: "DOC",
    version: 1,
    rev: 1,
    nodes: new Map(file.nodes.map((n) => [n.id, n])),
  };
};

it.each(Object.entries(fixtures).map(([path, text]) => [path.split("/").pop(), path, text]))(
  "writes %s and reads it back as the same Document",
  async (_name, path, text) => {
    const doc = open(text);
    const images = imageSource(parseDocument(text).images);
    const svg = toSvg(doc, undefined, { images });
    // The export, byte for byte: a change to the dialect shows here first (vitest -u to accept).
    await expect(svg).toMatchFileSnapshot(path.replace(/\.kalamo\.json$/, ".svg"));
    // A linked Image keeps its pixels from the Document that holds them, as Place does (ADR-0042).
    const read = await resolveImages(resolveLinks(parseSvg(svg), (id) => doc.images.get(id)));
    // The fixture's missing link warns on every read (ADR-0042).
    expect(read.warnings.map((w) => w.code)).toEqual(
      [...doc.nodes.values()].some((n) => n.type === "image" && n.src === undefined)
        ? ["IMAGE_LINK_MISSING"]
        : [],
    );
    expect(read.scope).toBeUndefined();
    const back = {
      ...doc,
      name: read.name,
      artboards: read.artboards,
      nodes: new Map(read.nodes.map((n) => [n.id, n])),
    };
    expect(serializeDocument(back, imageSource(read.images))).toBe(serializeDocument(doc, images));
  },
);

it("reads an exported Image back with the same src, frame and preserveAspectRatio", async () => {
  const { doc, defaultLayerId } = createDocument({
    id: "DOC",
    name: "Doc",
    artboards: [{ width: 100, height: 100 }],
  });
  const file = readImage(RED_2x2_PNG, "src");
  const src = await imageId(file.bytes);
  doc.images.set(src, file);
  createNodes(doc, [
    { type: "image", parentId: defaultLayerId, src, x: 1.5, y: 2, width: 30, height: 20 },
    {
      type: "image",
      parentId: defaultLayerId,
      src,
      x: 0,
      y: 0,
      preserveAspectRatio: "xMaxYMin slice",
    },
  ]);
  const images = imageSource(new Map([[src, file]]));
  const read = await resolveImages(parseSvg(toSvg(doc, undefined, { images })));
  expect(read.warnings).toEqual([]);
  const back = { ...doc, nodes: new Map(read.nodes.map((n) => [n.id, n])) };
  expect(serializeDocument(back, imageSource(read.images))).toBe(serializeDocument(doc, images));
});

it("reads back every Render Scope, id and alpha byte it writes", () => {
  const scopes: RenderScope[] = [
    { artboardId: "01M38T29S8GTJN2S1004N4Q1BH" },
    { nodeIds: ["01M38T29S8GTJN2S1004N4Q1BH", "01M38T29S9V6NZ3YY4ARKXBP1G"] },
    { rect: { x: -1.5, y: 2, width: 300.125, height: 0.001 } },
  ];
  for (const scope of scopes) expect(scopeOf(scopeAttr(scope))).toEqual(scope);
  expect(scopeAttr()).toBe("doc");
  expect(scopeOf("doc")).toBeUndefined();
  expect(idOf(xmlId("01M38T29S8GTJN2S1004N4Q1BH"))).toBe("01M38T29S8GTJN2S1004N4Q1BH");
  expect(idOf("path123")).toBeUndefined();
  for (let byte = 0; byte < 256; byte++) {
    const color = `#12AB9F${byte.toString(16).padStart(2, "0").toUpperCase()}`;
    const paint = paintAttrs("fill", color);
    const back = withAlpha(paint.fill as string, alpha(paint["fill-opacity"]));
    expect(back).toBe(byte === 255 ? "#12AB9F" : color);
  }
});

it("reads back a polygon's and a star's parameters exactly", () => {
  const { doc, defaultLayerId: parentId } = createDocument({ id: "d", name: "Doc", artboards: [] });
  const inkscape = { angle: -15, rounded: 0.25, randomized: 0.1 };
  const [polygon, star] = createNodes(doc, [
    { type: "polygon", parentId, cx: 0, cy: 0, radius: 30, sides: 6, ...inkscape },
    {
      type: "star",
      parentId,
      cx: 0,
      cy: 0,
      outerRadius: 35,
      innerRadius: 15,
      points: 5,
      ...inkscape,
      angle: 30,
      twist: 10,
    },
  ]).nodes;
  if (polygon?.type !== "polygon" || star?.type !== "star") throw new Error("setup");
  expect(starOf(starAttrs(polygon))).toEqual({
    type: "polygon",
    radius: 30,
    sides: 6,
    ...inkscape,
  });
  expect(starOf(starAttrs(star))).toEqual({
    type: "star",
    outerRadius: 35,
    innerRadius: 15,
    points: 5,
    ...inkscape,
    angle: 30,
    twist: 10,
  });
});

it("reads back an ellipse's angles and arc type exactly", () => {
  const { doc, defaultLayerId: parentId } = createDocument({ id: "d", name: "Doc", artboards: [] });
  const box = { type: "ellipse" as const, parentId, x: 0, y: 0, width: 30, height: 20 };
  const cuts = [
    { startAngle: 300, endAngle: 60, arcType: "chord" },
    { startAngle: 0, endAngle: 270, arcType: "open" },
    { startAngle: 12.345, endAngle: 359.999, arcType: "slice" },
    { startAngle: 0, endAngle: 360, arcType: "slice" },
  ] as const;
  for (const cut of cuts) {
    const [n] = createNodes(doc, [{ ...box, ...cut }]).nodes;
    if (n?.type !== "ellipse") throw new Error("setup");
    expect(arcOf(arcAttrs(n))).toEqual(cut);
  }
});

it("reads back the scope a file was exported at", () => {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "DOC",
    name: "Doc",
    artboards: [{ width: 100, height: 100 }],
  });
  const [rect] = createNodes(doc, [
    { type: "rect", parentId, x: 0, y: 0, width: 10, height: 10 },
  ]).nodes;
  const artboardId = doc.artboards[0]?.id ?? "";
  for (const scope of [
    { artboardId },
    { nodeIds: [rect?.id ?? ""] },
    { rect: { x: 1, y: 2, width: 3, height: 4 } },
  ] satisfies RenderScope[]) {
    expect(parseSvg(toSvg(doc, undefined, { scope })).scope).toEqual(scope);
  }
});
