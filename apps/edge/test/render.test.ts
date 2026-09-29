import { expect, it } from "vitest";
import fixture from "../../../fixtures/documents/inkscape.kalamo.json?raw";
import { call, errorOf } from "./rpc.ts";

type Rect = { x: number; y: number; width: number; height: number };

const newDoc = async (artboards: object[] = [{ width: 200, height: 100 }]) =>
  (await call("kalamo_doc_create", { name: "Doc", artboards })).structuredContent as {
    docId: string;
    defaultLayerId: string;
    artboards: { id: string; frame: Rect }[];
  };

/** The width and height a PNG's IHDR chunk declares. */
function pngSize(result: { content: { type: string; data?: string; mimeType?: string }[] }) {
  const image = result.content.find((c) => c.type === "image");
  expect(image?.mimeType).toBe("image/png");
  const png = Uint8Array.from(atob(image?.data ?? ""), (c) => c.charCodeAt(0));
  expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  const ihdr = new DataView(png.buffer, 16, 8);
  return { width: ihdr.getUint32(0), height: ihdr.getUint32(4) };
}

/** Renders, and checks the PNG is as large as the viewport says. */
async function render(args: object) {
  const result = await call("kalamo_render", args);
  expect(result.isError).toBeFalsy();
  expect(pngSize(result)).toEqual(result.structuredContent.viewport.pixelSize);
  return result.structuredContent.viewport;
}

const redRect = (parentId: string) => ({
  type: "rect",
  parentId,
  x: 10,
  y: 10,
  width: 50,
  height: 30,
  appearance: { fills: [{ color: "#FF0000" }], strokes: [{ color: "#000000", width: 4 }] },
});

it("renders the Document to a PNG with viewport metadata", async () => {
  const doc = await newDoc();
  await call("kalamo_node_create", { docId: doc.docId, nodes: [redRect(doc.defaultLayerId)] });
  expect(await render({ docId: doc.docId, scale: 2 })).toEqual({
    docRect: { x: 0, y: 0, width: 200, height: 100 },
    pixelSize: { width: 400, height: 200 },
    scale: 2,
  });
});

it("renders each Render Scope at the pixel size and docRect it covers", async () => {
  const doc = await newDoc([
    { width: 200, height: 100 },
    { width: 50, height: 40 },
  ]);
  const rectId = (
    await call("kalamo_node_create", { docId: doc.docId, nodes: [redRect(doc.defaultLayerId)] })
  ).structuredContent.createdIds[0];
  const second = doc.artboards[1];
  expect(await render({ docId: doc.docId, scope: { artboardId: second?.id } })).toEqual({
    docRect: second?.frame,
    pixelSize: { width: 50, height: 40 },
    scale: 1,
  });
  // The rect's visibleBounds: its 4 pt Stroke reaches 2 pt past each side.
  expect(await render({ docId: doc.docId, scope: { nodeIds: [rectId] }, scale: 2 })).toEqual({
    docRect: { x: 8, y: 8, width: 54, height: 34 },
    pixelSize: { width: 108, height: 68 },
    scale: 2,
  });
  // Widened to whole pixels, so docX = docRect.x + px / scale stays exact.
  expect(
    await render({
      docId: doc.docId,
      scope: { rect: { x: 1, y: 2, width: 10.2, height: 10 } },
      scale: 2,
    }),
  ).toEqual({
    docRect: { x: 1, y: 2, width: 10.5, height: 10 },
    pixelSize: { width: 21, height: 20 },
    scale: 2,
  });
});

it("lowers the scale to fit maxSize and reports the scale used", async () => {
  const doc = await newDoc([{ width: 2000, height: 100 }]);
  expect(await render({ docId: doc.docId })).toEqual({
    docRect: { x: 0, y: 0, width: 2000, height: 100 },
    pixelSize: { width: 1600, height: 80 },
    scale: 0.8,
  });
  expect((await render({ docId: doc.docId, maxSize: 500 })).pixelSize).toEqual({
    width: 500,
    height: 25,
  });
});

it("refuses an image larger than 4096 px per side with LIMIT_EXCEEDED and a hint", async () => {
  const { docId } = await newDoc([{ width: 2000, height: 100 }]);
  expect(errorOf(await call("kalamo_render", { docId, scale: 4, maxSize: 8000 }))).toMatchObject({
    code: "LIMIT_EXCEEDED",
    path: "maxSize",
    hint: expect.stringContaining("4096"),
  });
  expect(errorOf(await call("kalamo_export", { docId, format: "png", scale: 4 }))).toMatchObject({
    code: "LIMIT_EXCEEDED",
    path: "scale",
    hint: expect.stringContaining("scale <= 2.04"),
  });
});

it("answers a scope that names nothing with an error and its path", async () => {
  const doc = await newDoc();
  const groupId = (
    await call("kalamo_node_create", {
      docId: doc.docId,
      nodes: [{ type: "group", parentId: doc.defaultLayerId, children: [] }],
    })
  ).structuredContent.createdIds[0];
  const err = async (args: object) =>
    errorOf(await call("kalamo_render", { docId: doc.docId, ...args }));
  expect(await err({ scope: { artboardId: "nope" } })).toMatchObject({
    code: "ARTBOARD_NOT_FOUND",
    path: "scope.artboardId",
  });
  expect(await err({ scope: { nodeIds: [groupId, "nope"] } })).toMatchObject({
    code: "NODE_NOT_FOUND",
    path: "scope.nodeIds[1]",
  });
  expect(await err({ scope: { nodeIds: [groupId] } })).toMatchObject({ code: "NOTHING_TO_RENDER" });
  expect(await err({ background: "red" })).toMatchObject({
    code: "INVALID_COLOR",
    path: "background",
  });
});

it("draws overlays and a background into the image, at the same size", async () => {
  const doc = await newDoc();
  await call("kalamo_node_create", { docId: doc.docId, nodes: [redRect(doc.defaultLayerId)] });
  const png = async (args: object) => {
    const result = await call("kalamo_render", { docId: doc.docId, ...args });
    expect(pngSize(result)).toEqual({ width: 200, height: 100 });
    return result.content[0].data;
  };
  const plain = await png({});
  for (const overlay of ["bounds", "ids", "artboards"]) {
    expect(await png({ overlays: [overlay] })).not.toBe(plain);
  }
  expect(await png({ background: "#112233" })).not.toBe(plain);
});

it("exports the fixture Document as Inkscape SVG that matches the stored file", async () => {
  const { docId, artboards } = (await call("kalamo_doc_open", { content: fixture }))
    .structuredContent as { docId: string; artboards: { frame: Rect }[] };
  const result = await call("kalamo_export", { docId, format: "svg" });
  // The viewBox is the first Artboard, the page Inkscape binds to the viewport.
  expect(result.structuredContent).toEqual({ docRect: artboards[0]?.frame });
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe("text");
  const svg: string = result.content[0].text;
  expect(svg).toContain('viewBox="0 0 300 200" kalamo:scope="doc"');
  // Each mapping of ADR-0017, by the fixture's fixed ids.
  const z = (id: string) => `id="z-01M38T29${id}"`;
  for (const part of [
    'width="300pt" height="200pt" viewBox="0 0 300 200"',
    '<sodipodi:namedview inkscape:document-units="pt">',
    `<inkscape:page x="0" y="0" width="300" height="200" ${z("S8GTJN2S1004N4Q1BH")} inkscape:label="Artboard 1"/>`,
    `<inkscape:page x="320" y="0" width="120" height="120" ${z("S9V6NZ3YY4ARKXBP1G")} inkscape:label="Artboard 2"/>`,
    'fill="#FFF4D6" kalamo:artboard="01M38T29S9V6NZ3YY4ARKXBP1G" sodipodi:insensitive="true"/>',
    `<g ${z("SH6VR2ZZQ4C3WAHQMX")} inkscape:label="Guides" sodipodi:insensitive="true" inkscape:groupmode="layer" style="display:none">`,
    `<rect x="20" y="20" width="120" height="70" rx="12" ry="12" ${z("SBZ873XP2NBD2K6CYR")} inkscape:label="Card"`,
    `<ellipse cx="205" cy="45" rx="45" ry="25" ${z("SDPGEMM6AY4DF6ZSGG")}`,
    `<circle cx="190" cy="120" r="30" ${z("SDXC0F0T3ESSQD0P4P")}`,
    `<line x1="20" y1="110" x2="140" y2="180" ${z("SE45Q1MFZT7V62RNER")}`,
    'sodipodi:type="star" sodipodi:sides="6" sodipodi:cx="60" sodipodi:cy="150" sodipodi:r1="30"',
    'inkscape:flatsided="true"',
    'sodipodi:type="star" sodipodi:sides="5" sodipodi:cx="260" sodipodi:cy="150" sodipodi:r1="35" sodipodi:r2="15"',
    'inkscape:flatsided="false"',
    `${z("SFMVZ9S4MNJSJD618Z")} fill="#66CCAA" stroke="#004433"`,
    `<g ${z("SF5XG8X1F6BB53G505")} kalamo:stack="true"><path d="M 330 110 L 410 110 L 370 150 Z" fill="#FF0000" fill-opacity="0.502"/>`,
    `<path d="M 150 155 L 215 155 L 215 195 L 150 195 Z M 170 165 L 195 165 L 195 185 L 170 185 Z" fill-rule="evenodd" ${z("SK0MP0VNDPATH0RVNG")}`,
    '<text x="20" y="195" font-family="Source Sans 3" font-size="14"',
    'kalamo:tags="[&quot;badge&quot;,&quot;export&quot;]" kalamo:meta="{&quot;quote\\&quot;d&quot;:[1,2],&quot;source&quot;:&quot;fixture&quot;}"',
    // ADR-0023: an Image as <image xlink:href>, which Inkscape 1.2 draws, cropped by a Clipping Mask.
    'xmlns:xlink="http://www.w3.org/1999/xlink"',
    '<image x="470" y="10" width="24" height="16" preserveAspectRatio="none" xlink:href="data:image/png;base64,iVBOR',
    `<image x="470" y="40" width="48" height="48" preserveAspectRatio="xMidYMid slice" xlink:href="data:image/png;base64,`,
    `<g ${z("SQCR0PPEDGR0VP0000")} inkscape:label="Cropped" clip-path="url(#clip-z-01M38T29SQCR0PPEDGR0VP0000)">`,
    // ADR-0024: a star's angle, twist, rounding and jitter, its parameters at full precision.
    'sodipodi:cx="640.25" sodipodi:cy="45.5" sodipodi:r1="36" sodipodi:r2="16"',
    'inkscape:flatsided="false" inkscape:rounded="0.18" inkscape:randomized="0.1"',
    // ADR-0025: a cut ellipse as an Inkscape arc, its angles in radians at full precision.
    `sodipodi:type="arc" sodipodi:cx="740" sodipodi:cy="30" sodipodi:rx="30" sodipodi:ry="20" sodipodi:start="0" sodipodi:end="${(3 * Math.PI) / 2}" sodipodi:arc-type="slice"`,
    // ADR-0026: a gradient as a self-contained userSpaceOnUse element in the <defs> before its
    // element, a radial's ellipse as its gradientTransform, a stop's alpha as stop-opacity.
    `<defs><linearGradient id="fill-0-z-01M38T29STGRAD1ENT0000000A" gradientUnits="userSpaceOnUse" x1="830" y1="25" x2="880" y2="25">`,
    'cx="910" cy="30" r="20" fx="913.330127" fy="21.535898" gradientTransform="matrix(0.866025 0.5 -0.25 0.433013 129.416883 -437.990381)"',
    '<stop offset="1" stop-color="#9FD0FF" stop-opacity="0"/>',
    'stroke="url(#stroke-0-z-01M38T29STGRAD1ENT0000000C)"',
    // ADR-0028: a text's style as font-weight and font-style, left out for Regular.
    `font-size="14" font-weight="900" font-style="italic" ${z("SVTYPE0000000000D0")}`,
    // ADR-0029: tracking as letter-spacing, and a Character Range as a nested tspan.
    `font-size="20" letter-spacing="2" ${z("SWCHARS000000000A0")}`,
    '<tspan fill="#E9C46A" baseline-shift="2" rotate="-15">L</tspan>',
    // ADR-0051: a stroked Clipping Path's clip wraps the content, its Strokes drawn after it.
    `<g ${z("SYC11PPA1NTGR0VP00")} inkscape:label="Framed"><g kalamo:clipped="true" clip-path="url(#clip-z-01M38T29SYC11PPA1NTGR0VP00)">`,
    '<g kalamo:paint="clip-stroke" sodipodi:insensitive="true" inkscape:label="Clipping Path Stroke" style="opacity:0.6;mix-blend-mode:multiply">',
    // ADR-0052: a text Clipping Path unpainted in its <clipPath>, its overflow hidden.
    `<clipPath id="clip-z-01M38T29SZTEXTC11PGR0VP000" clipPathUnits="userSpaceOnUse"><text font-family="Source Sans 3" font-size="24" font-weight="900" ${z("SZTEXTC11PTYPE0000")}`,
    '<tspan style="visibility:hidden">hidden</tspan></text></clipPath>',
  ]) {
    expect(svg).toContain(part);
  }
  await expect(svg).toMatchFileSnapshot("../../../fixtures/documents/inkscape.svg");
  // resvg in the Worker draws the same file, namespaces and all, over every Artboard.
  expect(await render({ docId })).toEqual({
    docRect: { x: 0, y: 0, width: 1580, height: 480 },
    pixelSize: { width: 1580, height: 480 },
    scale: 1,
  });
}, 30_000);

it("exports PNG as image content with its viewport, in the same scopes", async () => {
  const doc = await newDoc();
  const rectId = (
    await call("kalamo_node_create", { docId: doc.docId, nodes: [redRect(doc.defaultLayerId)] })
  ).structuredContent.createdIds[0];
  const result = await call("kalamo_export", {
    docId: doc.docId,
    format: "png",
    scope: { nodeIds: [rectId] },
    scale: 2,
  });
  expect(result.structuredContent).toEqual({
    viewport: {
      docRect: { x: 8, y: 8, width: 54, height: 34 },
      pixelSize: { width: 108, height: 68 },
      scale: 2,
    },
  });
  expect(pngSize(result)).toEqual({ width: 108, height: 68 });
});

it("renders and exports a scope while a Clipping Mask or a translucent Node lies far outside it (ADR-0054)", async () => {
  const doc = await newDoc([
    { width: 100, height: 100 },
    { width: 100, height: 100 },
  ]);
  const { docId, defaultLayerId: parentId } = doc;
  const [contentId, clipId] = (
    await call("kalamo_node_create", {
      docId,
      nodes: [
        { type: "rect", parentId, x: 300, y: 0, width: 20, height: 20 },
        { type: "ellipse", parentId, x: 305, y: 5, width: 5, height: 5 },
      ],
    })
  ).structuredContent.createdIds;
  const mask = await call("kalamo_mask_make", {
    docId,
    clipNodeId: clipId,
    contentIds: [contentId],
  });
  expect(mask.isError).toBeFalsy();
  const artboardId = doc.artboards[0]?.id;
  await render({ docId, scope: { artboardId } });
  await render({ docId, scope: { rect: { x: 0, y: 0, width: 50, height: 50 } } });
  const png = await call("kalamo_export", { docId, format: "png", scope: { artboardId } });
  expect(png.isError).toBeFalsy();
  expect(pngSize(png)).toEqual(png.structuredContent.viewport.pixelSize);
  // export SVG still writes the far Clipping Mask.
  const svg = await call("kalamo_export", { docId, format: "svg", scope: { artboardId } });
  expect(svg.content[0].text).toContain("<clipPath");

  const lone = await newDoc([{ width: 100, height: 100 }]);
  const [rectId] = (
    await call("kalamo_node_create", {
      docId: lone.docId,
      nodes: [
        { type: "rect", parentId: lone.defaultLayerId, x: 1000, y: 0, width: 20, height: 20 },
      ],
    })
  ).structuredContent.createdIds;
  const updated = await call("kalamo_node_update", {
    docId: lone.docId,
    updates: [{ nodeId: rectId, patch: { opacity: 0.5 } }],
  });
  expect(updated.isError).toBeFalsy();
  await render({ docId: lone.docId });
});

it("renders and exports an Artboard while a translucent Group over far artwork holds a translucent child (#129)", async () => {
  const doc = await newDoc([{ width: 100, height: 100 }]);
  const { docId, defaultLayerId: parentId } = doc;
  const [groupId, , innerId] = (
    await call("kalamo_node_create", {
      docId,
      nodes: [
        {
          type: "group",
          parentId,
          children: [
            { type: "rect", x: -500, y: 10, width: 520, height: 20 },
            { type: "rect", x: 30, y: 30, width: 20, height: 20 },
          ],
        },
      ],
    })
  ).structuredContent.createdIds;
  const updated = await call("kalamo_node_update", {
    docId,
    updates: [
      { nodeId: groupId, patch: { opacity: 0.5 } },
      { nodeId: innerId, patch: { opacity: 0.5 } },
    ],
  });
  expect(updated.isError).toBeFalsy();
  const artboardId = doc.artboards[0]?.id;
  expect(await render({ docId, scope: { artboardId } })).toMatchObject({
    pixelSize: { width: 100, height: 100 },
  });
  const png = await call("kalamo_export", { docId, format: "png", scope: { artboardId } });
  expect(png.isError).toBeFalsy();
  expect(pngSize(png)).toEqual({ width: 100, height: 100 });
});
