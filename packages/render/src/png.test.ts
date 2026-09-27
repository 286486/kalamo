import {
  bounds,
  convertToPath,
  createDocument,
  createNodes,
  imageSource,
  makeMask,
  parseDocument,
} from "@zibel/core";
import { docRect, scopeRect, toSvg } from "@zibel/io";
import { expect, it } from "vitest";
import fixture from "../../../fixtures/documents/inkscape.zibel.json?raw";
import { RED_2x2_PNG } from "../../../fixtures/images.ts";
import { svgToPixels, svgToPng } from "./png.ts";

it("rasterises SVG with resvg-wasm inside workerd", async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"><rect width="10" height="10" fill="#FF0000"/></svg>`;
  const { png, width, height } = await svgToPng(svg, 2);
  expect([width, height]).toEqual([20, 20]);
  expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
});

/** Pixels that are not the white background, as [x, y]. */
async function ink(svg: string) {
  const { pixels, width } = await svgToPixels(svg, 1);
  const out: [number, number][] = [];
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] !== 255 || pixels[i + 1] !== 255 || pixels[i + 2] !== 255) {
      out.push([(i / 4) % width, Math.floor(i / 4 / width)]);
    }
  }
  return out;
}

it("draws text in the bundled font, inside the bounds node_get reports", async () => {
  const { doc, defaultLayerId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100, background: "#FFFFFF" }],
  });
  const [text] = createNodes(doc, [
    { type: "text", parentId: defaultLayerId, x: 20, y: 50, content: "Hg", fontSize: 24 },
  ]).nodes;
  const b = text && bounds(doc, text);
  if (!b) throw new Error("setup");
  const drawn = await ink(toSvg(doc));
  // workerd has no system fonts: without the bundled one resvg draws no glyphs at all.
  expect(drawn.length).toBeGreaterThan(20);
  // Pixel [x, y] covers x..x+1; allow a pixel of antialiasing past the box.
  const inside = ([x, y]: [number, number]) =>
    b.x - 1 <= x && x < b.x + b.width + 1 && b.y - 1 <= y && y < b.y + b.height + 1;
  expect(drawn.filter((p) => !inside(p))).toEqual([]);
});

it("draws each bundled face inside its own bounds (ADR-0028)", async () => {
  const styles = [
    "Regular",
    "Italic",
    "Bold",
    "Bold Italic",
    "Black",
    "Black Italic",
    // Exported as their own weights, which resvg must match to the face core measures them in.
    "Light",
    "Semibold",
    "ExtraBold Italic",
  ] as const;
  const drawn = await Promise.all(
    styles.map(async (fontStyle) => {
      const { doc, defaultLayerId } = createDocument({
        id: "d",
        name: "Doc",
        artboards: [{ width: 300, height: 100, background: "#FFFFFF" }],
      });
      const [text] = createNodes(doc, [
        {
          type: "text",
          parentId: defaultLayerId,
          x: 20,
          y: 70,
          content: "HHHH",
          fontSize: 48,
          fontStyle,
        },
      ]).nodes;
      const b = text && bounds(doc, text);
      if (!b) throw new Error("setup");
      const pixels = await ink(toSvg(doc));
      const outside = pixels.filter(
        ([x, y]) => x < b.x - 1 || x >= b.x + b.width + 1 || y < b.y - 1 || y >= b.y + b.height + 1,
      );
      return { outside, right: Math.max(...pixels.map(([x]) => x)), key: pixels.join(";") };
    }),
  );
  expect(drawn.map((d) => d.outside)).toEqual(styles.map(() => []));
  const [regular, italic, bold, , black, blackItalic, light, semibold, extraBoldItalic] = drawn;
  // Only Regular is drawn when a face is missing, so each wider face shows it loaded.
  expect(bold?.right).toBeGreaterThan(regular?.right ?? Infinity);
  expect(black?.right).toBeGreaterThan(bold?.right ?? Infinity);
  expect(italic?.key).not.toBe(regular?.key);
  expect(new Set(drawn.slice(0, 6).map((d) => d.key)).size).toBe(6);
  expect([light?.key, semibold?.key, extraBoldItalic?.key]).toEqual([
    regular?.key,
    bold?.key,
    blackItalic?.key,
  ]);
});

it("draws tracking, baseline shift and rotation inside the bounds node_get reports", async () => {
  const draw = async (extra: object) => {
    const { doc, defaultLayerId } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 200, height: 100, background: "#FFFFFF" }],
    });
    const [text] = createNodes(doc, [
      {
        type: "text",
        parentId: defaultLayerId,
        x: 20,
        y: 60,
        content: "HH",
        fontSize: 40,
        ...extra,
      },
    ]).nodes;
    const b = text && bounds(doc, text);
    if (!b) throw new Error("setup");
    const pixels = await ink(toSvg(doc));
    const outside = pixels.filter(
      ([x, y]) => x < b.x - 1 || x >= b.x + b.width + 1 || y < b.y - 1 || y >= b.y + b.height + 1,
    );
    const [xs, ys] = [pixels.map(([x]) => x), pixels.map(([, y]) => y)];
    return { outside, right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
  };
  const second = (range: object) => ({ ranges: [{ start: 1, end: 2, ...range }] });
  const [plain, tracked, shifted, rotated] = await Promise.all([
    draw({}),
    draw({ tracking: 500 }),
    draw(second({ baselineShift: 15 })),
    draw(second({ rotation: 90 })),
  ]);
  if (!plain || !tracked || !shifted || !rotated) throw new Error("setup");
  expect([plain, tracked, shifted, rotated].map((d) => d.outside)).toEqual([[], [], [], []]);
  expect(tracked.right).toBeGreaterThanOrEqual(plain.right + 19);
  expect(shifted.top).toBeLessThanOrEqual(plain.top - 14);
  expect(rotated.bottom).toBeGreaterThanOrEqual(plain.bottom + 15);
});

/** The runs of consecutive rows that hold ink: one per drawn line of text. */
const bands = (drawn: [number, number][]) =>
  [...new Set(drawn.map(([, y]) => y))]
    .sort((a, b) => a - b)
    .filter((y, i, ys) => ys[i - 1] !== y - 1).length;

it("draws each line of Point Type and each shown line of Area Type, inside their bounds", async () => {
  const draw = async (input: object) => {
    const { doc, defaultLayerId } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 200, height: 100, background: "#FFFFFF" }],
    });
    const [text] = createNodes(doc, [{ parentId: defaultLayerId, ...input } as never]).nodes;
    const b = text && bounds(doc, text);
    if (!b) throw new Error("setup");
    const drawn = await ink(toSvg(doc));
    const inside = ([x, y]: [number, number]) =>
      b.x - 1 <= x && x < b.x + b.width + 1 && b.y - 1 <= y && y < b.y + b.height + 1;
    return { lines: bands(drawn), outside: drawn.filter((p) => !inside(p)) };
  };
  expect(await draw({ type: "text", x: 20, y: 25, content: "Hg\nHg\nHg", fontSize: 24 })).toEqual({
    lines: 3,
    outside: [],
  });
  // 60 pt holds four 14.4 pt lines; the fifth overflows and is not drawn.
  expect(
    await draw({
      type: "text",
      kind: "area",
      x: 20,
      y: 10,
      width: 100,
      height: 60,
      content: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen",
    }),
  ).toEqual({ lines: 4, outside: [] });
});

it("keeps runs of spaces, so the drawn width follows the advance sum", async () => {
  const svg = (content: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><rect width="400" height="100" fill="#FFFFFF"/>` +
    `<text x="0" y="80" font-family="Source Sans 3" font-size="100" style="font-kerning:none" xml:space="preserve">${content}</text></svg>`;
  const right = async (content: string) => Math.max(...(await ink(svg(content))).map(([x]) => x));
  // Two more spaces move the last glyph right by two space advances: 2 × 200 × 100 / 1000 = 40 pt.
  expect((await right("a    b")) - (await right("a  b"))).toBeCloseTo(40, -0.5);
});

it("draws a font Zibel does not bundle in Source Sans 3", async () => {
  const svg = (family: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#FFFFFF"/>` +
    `<text x="0" y="80" font-family="${family}" font-size="60">Hi</text></svg>`;
  const bundled = await ink(svg("Source Sans 3"));
  expect(bundled.length).toBeGreaterThan(0);
  expect(await ink(svg("Helvetica"))).toEqual(bundled);
  expect(await ink(svg("'DejaVu Serif', serif"))).toEqual(bundled);
});

it("leaves an evenodd hole unpainted, and fills it under nonzero", async () => {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 70, height: 70, background: "#FFFFFF" }],
  });
  // Both subpaths wind the same way, so only evenodd makes the inner one a hole.
  const d = "M 10 10 L 60 10 L 60 60 L 10 60 Z M 25 25 L 45 25 L 45 45 L 25 45 Z";
  const [ring] = createNodes(doc, [
    {
      type: "path",
      parentId,
      d,
      fillRule: "evenodd",
      appearance: { fills: [{ color: "#000000" }] },
    },
  ]).nodes;
  const inked = async () => (await ink(toSvg(doc))).map((p) => p.join());
  expect(await inked()).toContain("15,35");
  expect(await inked()).not.toContain("35,35");
  if (ring) doc.nodes.set(ring.id, { ...ring, fillRule: "nonzero" } as typeof ring);
  expect(await inked()).toContain("35,35");
});

it("paints a slice, a chord and an open arc of an ellipse (ADR-0025)", async () => {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 140, background: "#FFFFFF" }],
  });
  const pie = { type: "ellipse" as const, parentId, width: 80, height: 60, endAngle: 270 };
  const filled = { fills: [{ color: "#000000" }] };
  const stroked = { fills: [], strokes: [{ color: "#000000", width: 4 }] };
  createNodes(doc, [
    { ...pie, x: 0, y: 0, appearance: filled },
    { ...pie, x: 100, y: 0, arcType: "chord", appearance: filled },
    { ...pie, x: 0, y: 70, arcType: "chord", appearance: stroked },
    { ...pie, x: 100, y: 70, arcType: "open", appearance: stroked },
  ]);
  const drawn = new Set((await ink(toSvg(doc))).map((p) => p.join()));
  // 270° to 360° is the top right quarter: the slice leaves it out, the chord only past its line.
  expect(drawn.has("50,22")).toBe(false);
  expect(drawn.has("30,37")).toBe(true);
  expect(drawn.has("150,22")).toBe(true);
  expect(drawn.has("165,10")).toBe(false);
  // The chord's line is stroked, the open arc's is not; both stroke the arc.
  expect(drawn.has("60,85")).toBe(true);
  expect(drawn.has("160,85")).toBe(false);
  expect(drawn.has("1,100")).toBe(true);
  expect(drawn.has("101,100")).toBe(true);
});

it("rounds the pixel size to the nearest pixel and stretches the drawing to it", async () => {
  // Why fit() widens the rect to whole pixels: at 10.2 pt × 2 resvg draws 20 px, not 20.4.
  const size = async (width: number) =>
    (
      await svgToPixels(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="10" viewBox="0 0 ${width} 10"/>`,
        2,
      )
    ).width;
  expect(await size(10.2)).toBe(20);
  expect(await size(10.5)).toBe(21);
});

it("reads the root's pt as one pixel per point at scale 1", async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10pt" height="5pt" viewBox="0 0 10 5"/>`;
  expect(await svgToPixels(svg, 1)).toMatchObject({ width: 10, height: 5 });
  expect(await svgToPixels(svg, 2)).toMatchObject({ width: 20, height: 10 });
});

it("draws the fixture Document with known pixels", async () => {
  const file = parseDocument(fixture);
  const images = imageSource(file.images);
  const doc = {
    id: "d",
    version: 1 as const,
    rev: 0,
    ...file,
    nodes: new Map(file.nodes.map((n) => [n.id, n])),
  };
  const hash = async (svg: string) => {
    const { pixels } = await svgToPixels(svg, 2);
    const digest = await crypto.subtle.digest("SHA-256", pixels);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  const turned = { nodeIds: [file.nodes.find((n) => n.name === "Turned")?.id ?? ""] };
  // Changed once, by #25: a native <rect rx> or <circle> draws the exact outline where the <path>
  // before it rounded control points to 3 decimals, which moved 3 edge pixels by up to 16/255.
  // Both changed again, by #26: "Turned" draws with its stored 0.866025 where export wrote 0.866, which
  // moved 28 of its antialiased edge pixels at 2x by up to 10/255.
  // The whole Document again, by #27: the fixture gained a Sublayer, a multiply rect, a two-Stroke
  // path with a translucent Stroke and a hidden ellipse. Writing alpha as fill-opacity did not
  // move a pixel. Again by #30: the fixture gained an evenodd ring; by #31, a Clipping Mask; by #33,
  // a multi-line Point Type and an Area Type (writing text as line tspans moved no pixel); by #32,
  // a third Artboard holding three Images, one cropped by a Clipping Mask; by #34, a fourth holding
  // a rounded, randomized, twisted star, a rounded, randomized polygon and a randomized star whose
  // round-number vertices sit on Inkscape's seed grid; by #35, a fifth holding a slice, a chord
  // and an open arc; by #22, a sixth holding linear and radial gradients on Fills, a Stroke, a
  // text, a turned rect and a stack; by #19, a seventh holding the five non-Regular faces as Point
  // Type and a Bold Italic Area Type; by #20, an eighth Artboard holding tracked text and Character
  // Ranges.
  expect(await hash(toSvg(doc, docRect(doc), { images }))).toBe(
    "411e7baaaae6b2404d8360cde3d1e42486614dec6be81bb0c48fb606da18525a",
  );
  expect(await hash(toSvg(doc, scopeRect(doc, turned), { scope: turned, images }))).toBe(
    "24c1e7ad8db33f59933a1b355c879cb19bfdfd67d70b11427b196aa646ea4b60",
  );
});

it("clips by an inline clipPath the Group refers to before it is defined", async () => {
  const svg = (clip: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#FFFFFF"/>` +
    `<g clip-path="url(#c)"><rect width="100" height="100" fill="#FF0000"/>` +
    `<clipPath id="c" clipPathUnits="userSpaceOnUse">${clip}</clipPath></g></svg>`;
  const drawn = await ink(svg(`<circle cx="50" cy="50" r="10" fill="none"/>`));
  const at = (x: number, y: number) => drawn.some(([px, py]) => px === x && py === y);
  expect(at(50, 50)).toBe(true);
  expect(at(5, 5)).toBe(false);
  expect(drawn.length).toBeLessThan(400);
  // clip-rule, not fill-rule, decides a hole inside a clipPath.
  const ring = `<path d="M 10 10 L 90 10 L 90 90 L 10 90 Z M 40 40 L 60 40 L 60 60 L 40 60 Z"`;
  expect(
    (await ink(svg(`${ring} clip-rule="evenodd"/>`))).some(([x, y]) => x === 50 && y === 50),
  ).toBe(false);
  expect(
    (await ink(svg(`${ring} fill-rule="evenodd"/>`))).some(([x, y]) => x === 50 && y === 50),
  ).toBe(true);
});

it("draws a Clipping Mask's content only inside its Clipping Path", async () => {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 100, height: 100, background: "#FFFFFF" }],
  });
  const [content, clip] = createNodes(doc, [
    {
      type: "rect",
      parentId,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      appearance: { fills: [{ color: "#FF0000" }] },
    },
    { type: "ellipse", parentId, x: 40, y: 40, width: 20, height: 20 },
  ]).nodes;
  if (!content || !clip) throw new Error("setup");
  makeMask(doc, { clipNodeId: clip.id, contentIds: [content.id] });
  const drawn = await ink(toSvg(doc));
  expect(drawn.some(([x, y]) => x === 50 && y === 50)).toBe(true);
  expect(drawn.every(([x, y]) => x >= 39 && x <= 60 && y >= 39 && y <= 60)).toBe(true);
});

it("draws an Image's pixels in its frame and nowhere else", async () => {
  const { doc, defaultLayerId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 40, height: 40, background: "#FFFFFF" }],
  });
  const src = "a".repeat(64);
  doc.images.set(src, { mime: "image/png", width: 2, height: 2 });
  createNodes(doc, [
    { type: "image", parentId: defaultLayerId, src, x: 10, y: 10, width: 20, height: 20 },
  ]);
  const drawn = await ink(toSvg(doc, docRect(doc), { images: () => RED_2x2_PNG }));
  expect(drawn.length).toBe(400);
  expect(drawn.filter(([x, y]) => x < 10 || x >= 30 || y < 10 || y >= 30)).toEqual([]);
});

it("draws a linear gradient from start to end, and a radial one's first stop at its focus", async () => {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 100, height: 60, background: "#FFFFFF" }],
  });
  const stops = [
    { offset: 0, color: "#FF0000" },
    { offset: 1, color: "#0000FF" },
  ];
  createNodes(doc, [
    {
      type: "rect",
      parentId,
      x: 0,
      y: 0,
      width: 100,
      height: 10,
      appearance: { fills: [{ type: "gradient", gradient: { type: "linear", stops } }] },
    },
    {
      type: "rect",
      parentId,
      x: 0,
      y: 20,
      width: 40,
      height: 40,
      appearance: {
        fills: [
          {
            type: "gradient",
            gradient: { type: "radial", stops, radius: 20, focus: { x: 8, y: 40 } },
          },
        ],
      },
    },
  ]);
  const { pixels, width } = await svgToPixels(toSvg(doc, docRect(doc)), 1);
  const at = (x: number, y: number) => [
    ...pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 3),
  ];
  const [r0, , b0] = at(2, 5);
  const [r1, , b1] = at(97, 5);
  expect(r0).toBeGreaterThan(240);
  expect(b0).toBeLessThan(15);
  expect(r1).toBeLessThan(15);
  expect(b1).toBeGreaterThan(240);
  // Red at the focus, left of the centre, and already half way to blue at the centre.
  expect(at(8, 40)[0]).toBeGreaterThan(230);
  expect(at(20, 40)[0]).toBeLessThan(200);
});

it("paints Live Shapes the same after Convert to Path", async () => {
  const { doc, defaultLayerId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100, background: "#FFFFFF" }],
  });
  const appearance = {
    fills: [{ color: "#3366CC" }],
    strokes: [{ color: "#000000", width: 3 }],
  };
  const ids = createNodes(
    doc,
    [
      { type: "rect" as const, x: 10, y: 10, width: 60, height: 40, radius: 8, appearance },
      { type: "ellipse" as const, x: 80, y: 10, width: 50, height: 40, endAngle: 270, appearance },
      {
        type: "star" as const,
        cx: 165,
        cy: 50,
        outerRadius: 30,
        innerRadius: 12,
        points: 5,
        appearance,
      },
      { type: "line" as const, x1: 10, y1: 80, x2: 190, y2: 90, appearance },
    ].map((n) => ({ ...n, parentId: defaultLayerId })),
  ).nodes.map((n) => n.id);
  const rect = docRect(doc);
  const before = await svgToPixels(toSvg(doc, rect), 1);
  expect(convertToPath(doc, ids).updated).toHaveLength(4);
  const after = await svgToPixels(toSvg(doc, rect), 1);
  // A path's antialiasing is not a <rect>'s or <ellipse>'s to the level: allow a few edge pixels.
  const differ = before.pixels.filter((v, i) => Math.abs(v - (after.pixels[i] ?? 0)) > 2).length;
  expect(differ).toBeLessThanOrEqual(4);
});
