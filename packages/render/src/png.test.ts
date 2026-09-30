import {
  BUNDLED_FAMILIES,
  BUNDLED_FONT,
  bounds,
  convertToPath,
  createDocument,
  createNodes,
  imageSource,
  makeMask,
  type Node,
  parseDocument,
  pathOp,
  type Rect,
  transformNodes,
  updateNodes,
} from "@kalamo/core";
import { docRect, scopeRect, toSvg } from "@kalamo/io";
import { describe, expect, it } from "vitest";
import { COMPOSITING, near } from "../../../fixtures/compositing.ts";
import fixture from "../../../fixtures/documents/inkscape.kalamo.json?raw";
import { RED_2x2_PNG } from "../../../fixtures/images.ts";
import { LAZY_FONTS, renderFonts, svgToPixels, svgToPng } from "./png.ts";
import { fit, renderSvg } from "./svg.ts";

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

describe("alignment (ADR-0077)", () => {
  /** The ink of one text, rendered as `render` does, and its layout's box. */
  const drawn = async (text: Record<string, unknown>) => {
    const { doc, defaultLayerId } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 300, height: 200, background: "#FFFFFF" }],
    });
    const [n] = createNodes(doc, [
      { type: "text", parentId: defaultLayerId, fontSize: 16, ...text } as never,
    ]).nodes as [Node];
    return { box: bounds(doc, n) as Rect, ink: await ink(renderSvg(doc)) };
  };
  const inside =
    (b: Rect) =>
    ([x, y]: [number, number]) =>
      b.x - 1 <= x && x < b.x + b.width + 1 && b.y - 1 <= y && y < b.y + b.height + 1;
  const point = { x: 150, y: 60, content: "Hello there\nHi\nwide wide line" };
  const area = {
    kind: "area",
    x: 20,
    y: 20,
    width: 200,
    height: 160,
    content: "The quick brown fox jumps over the lazy dog and keeps going.\nA second paragraph.",
  };

  it.each(["left", "center", "right", "justify"])(
    "draws %s Point Type and Area Type inside their boxes",
    async (alignment) => {
      for (const text of [point, area]) {
        const { box, ink: pixels } = await drawn({ ...text, alignment });
        expect(pixels.length).toBeGreaterThan(50);
        expect(pixels.filter((p) => !inside(box)(p))).toEqual([]);
      }
    },
  );

  it("centres a Point Type line's ink on x within 1 pt", async () => {
    const { ink: pixels } = await drawn({ x: 150, y: 60, content: "HHHH", alignment: "center" });
    const xs = pixels.map(([x]) => x);
    const [left, right] = [Math.min(...xs), Math.max(...xs) + 1];
    expect(Math.abs((left + right) / 2 - 150)).toBeLessThanOrEqual(1);
  });

  it("draws a justified line out to the frame's right edge, as the layout does", async () => {
    const { ink: pixels } = await drawn({ ...area, alignment: "justify" });
    const firstLine = pixels.filter(([, y]) => y < 38);
    const right = Math.max(...firstLine.map(([x]) => x)) + 1;
    // A glyph's side bearing keeps its ink a little inside its advance.
    expect(right).toBeGreaterThan(218);
    expect(right).toBeLessThanOrEqual(221);
  });
});

it("draws a shaped Area Type's spans where the layout puts them, none in the frame's notch (ADR-0078)", async () => {
  const { doc, defaultLayerId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 120, background: "#FFFFFF" }],
  });
  createNodes(doc, [
    {
      type: "text",
      kind: "area",
      parentId: defaultLayerId,
      frame: "M 10 10 L 70 10 L 70 50 L 130 50 L 130 10 L 190 10 L 190 110 L 10 110 Z",
      content:
        "Words fill the left span then the right one, and below the notch the full width of it.",
      fontSize: 10,
    },
  ]);
  const drawn = await ink(renderSvg(doc));
  expect(drawn.length).toBeGreaterThan(100);
  // Inside the frame's bounds, a pixel of antialiasing aside, and never in the notch above y 50.
  expect(drawn.filter(([x, y]) => x < 9 || x > 191 || y < 9 || y > 111)).toEqual([]);
  expect(drawn.filter(([x, y]) => x > 71 && x < 129 && y < 48)).toEqual([]);
  // The right span's first line draws, from x 130.
  expect(drawn.some(([x, y]) => x >= 130 && y < 30)).toBe(true);
});

const CONVERTED = "Converted text keeps every line where it was.\nA second paragraph.";
it.each([
  ["left", CONVERTED],
  ["center", CONVERTED],
  ["right", CONVERTED],
  // CJK in Noto Sans SC stacks by leading alone as Latin does (ADR-0080).
  ["left", "Latin with 中文字 and 日本語の文 wraps.\n第二段 second"],
] as const)(
  "draws %s text pixel for pixel alike before and after each Convert: %s (ADR-0079)",
  async (alignment, content) => {
    const { doc, defaultLayerId } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 200, height: 120, background: "#FFFFFF" }],
    });
    const [t] = createNodes(doc, [
      {
        type: "text",
        kind: "area",
        parentId: defaultLayerId,
        x: 20,
        y: 10,
        width: 120,
        height: 100,
        fontSize: 11,
        tracking: 40,
        alignment,
        content,
        ranges: [{ start: 3, end: 12, fill: "#FF0000", baselineShift: 2 }],
      },
    ]).nodes as [Node];
    const pixels = async () => (await svgToPixels(renderSvg(doc), 2)).pixels;
    const area = await pixels();
    expect(area.some((v) => v !== 255)).toBe(true);
    updateNodes(doc, [{ nodeId: t.id, patch: { kind: "point" } }]);
    expect(doc.nodes.get(t.id)).toMatchObject({ kind: "point" });
    expect(await pixels()).toEqual(area);
    updateNodes(doc, [{ nodeId: t.id, patch: { kind: "area" } }]);
    expect(doc.nodes.get(t.id)).toMatchObject({ kind: "area" });
    expect(await pixels()).toEqual(area);
  },
  // Each render of the CJK case loads Noto Sans SC, as the other Noto tests here do.
  30_000,
);

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

/** "HH" at 40 pt with `extra`: its ink outside its bounds, its red pixels and its ink's extent. */
const drawHH = async (extra: object) => {
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
  const { pixels: rgba } = await svgToPixels(toSvg(doc), 1);
  let red = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if ((rgba[i] ?? 0) > 200 && (rgba[i + 1] ?? 0) < 60 && (rgba[i + 2] ?? 0) < 60) red++;
  }
  return { outside, red, right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
};

it("draws tracking, baseline shift, rotation and range overrides inside the bounds node_get reports", async () => {
  const second = (range: object) => ({ ranges: [{ start: 1, end: 2, ...range }] });
  const drawn = await Promise.all([
    drawHH({}),
    drawHH({ tracking: 500 }),
    drawHH(second({ baselineShift: 15 })),
    drawHH(second({ rotation: 90 })),
    drawHH({ ranges: [{ start: 0, end: 1, tracking: 500 }] }),
    drawHH(second({ fontStyle: "Black Italic" })),
    drawHH(second({ fontFamily: "Noto Sans SC" })),
    drawHH(second({ fontSize: 60 })),
  ]);
  const [plain, tracked, shifted, rotated, rangeTracked, styled, family, sized] = drawn;
  if (!plain || !tracked || !shifted || !rotated || !rangeTracked || !styled || !family || !sized) {
    throw new Error("setup");
  }
  // The second H at 60 pt, 20 pt larger: its ink about 0.6 em wider and its cap 0.66 em taller.
  expect(sized.right).toBeGreaterThanOrEqual(plain.right + 10);
  expect(sized.top).toBeLessThanOrEqual(plain.top - 12);
  expect(drawn.map((d) => d.outside)).toEqual(drawn.map(() => []));
  expect(styled.right).toBeGreaterThan(plain.right);
  // Noto Sans SC's H is 728 units to Source Sans 3's 652: 3 px wider at 40 pt.
  expect(family.right).toBeGreaterThanOrEqual(plain.right + 2);
  expect(tracked.right).toBeGreaterThanOrEqual(plain.right + 19);
  expect(rangeTracked.right).toBe(tracked.right);
  expect(shifted.top).toBeLessThanOrEqual(plain.top - 14);
  expect(rotated.bottom).toBeGreaterThanOrEqual(plain.bottom + 15);
}, 30_000);

it("draws a range stroke in its colour, inside the bounds node_get reports (ADR-0068)", async () => {
  const stroked = (ranges?: object[]) => ({
    appearance: { fills: [{ color: "#FFFFFF" }], strokes: [{ color: "#000000", width: 2 }] },
    ...(ranges && { ranges }),
  });
  const [plain, ranged] = await Promise.all([
    drawHH(stroked()),
    drawHH(stroked([{ start: 1, end: 2, stroke: "#FF0000" }])),
  ]);
  expect([plain?.outside, ranged?.outside]).toEqual([[], []]);
  expect(plain?.red).toBe(0);
  expect(ranged?.red).toBeGreaterThan(100);
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

it("draws a font Kalamo does not bundle in Source Sans 3", async () => {
  const svg = (family: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#FFFFFF"/>` +
    `<text x="0" y="80" font-family="${family}" font-size="60">Hi</text></svg>`;
  const bundled = await ink(svg("Source Sans 3"));
  expect(bundled.length).toBeGreaterThan(0);
  expect(await ink(svg("Helvetica"))).toEqual(bundled);
  expect(await ink(svg("'DejaVu Serif', serif"))).toEqual(bundled);
});

/**
 * One text in `fontStyle` at 100 pt drawn as `render` draws it, and a function giving the pixels of
 * columns `from` to `to` in pt, row by row.
 */
async function drawnText(content: string, fontStyle = "Regular", fontFamily = "Source Sans 3") {
  const { doc, defaultLayerId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 400, height: 150, background: "#FFFFFF" }],
  });
  const [text] = createNodes(doc, [
    {
      type: "text",
      parentId: defaultLayerId,
      x: 10,
      y: 110,
      content,
      fontSize: 100,
      fontStyle,
      fontFamily,
    },
  ] as never).nodes;
  const { pixels, width } = await svgToPixels(renderSvg(doc), 1);
  const columns = (from: number, to: number) => {
    const rows: string[] = [];
    for (let y = 0; y < pixels.length / 4 / width; y++) {
      rows.push(pixels.subarray((y * width + from) * 4, (y * width + to) * 4).join());
    }
    return rows.join("\n");
  };
  return { columns, box: text && bounds(doc, text) };
}

it("draws a character Source Sans 3 lacks in Noto Sans SC, the rest of its line as before (ADR-0063)", async () => {
  for (const style of ["Regular", "Bold", "Black", "Bold Italic"]) {
    const mixed = await drawnText("Hi 小", style);
    const latin = await drawnText("Hi", style);
    const notdef = await drawnText("Hi ก", style);
    // "Hi " ends at 小's origin; its ink stays left of it.
    const at = Math.floor((mixed.box?.width ?? 0) - 100 + 10);
    expect(mixed.columns(0, at), style).toBe(latin.columns(0, at));
    expect(mixed.columns(at, 400), style).not.toBe(notdef.columns(at, 400));
    expect(mixed.columns(at, 400), style).not.toBe(latin.columns(at, 400));
  }
  // Noto Sans SC has no italic, so an italic draws its CJK upright, and Bold and heavier in Bold.
  const cjk = async (style: string) => (await drawnText("小", style)).columns(0, 400);
  expect(await cjk("Bold Italic")).toBe(await cjk("Bold"));
  expect(await cjk("Italic")).toBe(await cjk("Regular"));
  expect(await cjk("Black")).toBe(await cjk("Bold"));
  expect(await cjk("Bold")).not.toBe(await cjk("Regular"));
}, 30_000);

it("keeps an Area Type's last line in Source Sans 3 when CJK overflows after it", async () => {
  const drawn = async (content: string) => {
    const { doc, defaultLayerId: parentId } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 200, height: 100, background: "#FFFFFF" }],
    });
    createNodes(doc, [
      {
        type: "text",
        parentId,
        kind: "area",
        x: 0,
        y: 0,
        width: 200,
        height: 60,
        content,
        fontSize: 40,
        fontStyle: "Bold",
      },
      // Visible CJK elsewhere, so the render loads Noto Sans SC.
      { type: "text", parentId, x: 0, y: 95, content: "小", fontSize: 20 },
    ] as never);
    return ink(renderSvg(doc));
  };
  expect(await drawn("Hi\n小动物小动物")).toEqual(await drawn("Hi\nกขคกขค"));
});

// Noto Sans KR draws Hangul, which Source Sans 3 and Noto Sans SC lack (ADR-0066).
it("draws Hangul in Noto Sans KR, the rest of its line as before", async () => {
  for (const style of ["Regular", "Bold", "Black", "Bold Italic"]) {
    const mixed = await drawnText("Hi 한", style);
    const latin = await drawnText("Hi", style);
    const notdef = await drawnText("Hi ก", style);
    const at = Math.floor((latin.box?.width ?? 0) + 20 + 10);
    expect(mixed.columns(0, at), style).toBe(latin.columns(0, at));
    expect(mixed.columns(at, 400), style).not.toBe(notdef.columns(at, 400));
    expect(mixed.columns(at, 400), style).not.toBe(latin.columns(at, 400));
  }
  const hangul = async (style: string) => (await drawnText("한", style)).columns(0, 400);
  expect(await hangul("Italic")).toBe(await hangul("Regular"));
  expect(await hangul("Bold Italic")).toBe(await hangul("Bold"));
  expect(await hangul("Black")).toBe(await hangul("Bold"));
  expect(await hangul("Bold")).not.toBe(await hangul("Regular"));
}, 30_000);

// 直 has distinct Simplified Chinese and Korean forms, so the face it draws in shows.
it("draws each character of a line mixing Han and Hangul in its own face", async () => {
  const [sc, kr] = [await drawnText("直"), await drawnText("直", "Regular", "Noto Sans KR")];
  expect(sc.columns(0, 110)).not.toBe(kr.columns(0, 110));
  const mixed = await drawnText("直한");
  expect(mixed.columns(0, 110)).toBe(sc.columns(0, 110));
  expect(mixed.columns(110, 400)).not.toBe((await drawnText("直ก")).columns(110, 400));
}, 30_000);

it("has font files for every bundled family, and only those (ADR-0066)", () => {
  expect([BUNDLED_FONT, ...Object.keys(LAZY_FONTS)].sort()).toEqual([...BUNDLED_FAMILIES].sort());
});

it("copies into resvg only the files of the families an SVG draws in", async () => {
  const sizes = async (content: string) => {
    const { doc, defaultLayerId: parentId } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 100, height: 40 }],
    });
    createNodes(doc, [{ type: "text", parentId, x: 0, y: 20, content }]);
    return (await renderFonts(renderSvg(doc))).fontBuffers.map((b) => b.byteLength);
  };
  const sourceSans3 = await sizes("Hi");
  expect(sourceSans3).toHaveLength(6);
  const [scRegular, scBold, krRegular, krBold] = [8331336, 8543168, 4644748, 4816044];
  expect(await sizes("Hi 한")).toEqual([...sourceSans3, krRegular, krBold]);
  expect(await sizes("Hi 小")).toEqual([...sourceSans3, scRegular, scBold]);
  expect(await sizes("小한")).toEqual([...sourceSans3, scRegular, scBold, krRegular, krBold]);
}, 30_000);

it("draws a text in Noto Sans SC in it, and what it lacks in Source Sans 3", async () => {
  const noto = await drawnText("Hi", "Regular", "Noto Sans SC");
  expect(noto.columns(0, 400)).not.toBe((await drawnText("Hi")).columns(0, 400));
  expect(noto.box?.width).toBeCloseTo(72.8 + 27.5);
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
  // Ranges; by #104, a ninth holding a Layer with a Stroke and a Group with a Stroke below Contents;
  // by #106, that Group gained a text and a Clipping Mask its paints reach; by #112, the Artboard
  // widened for a painted Group of turned, scaled Area Type; by #113, the edited Group left the
  // painted Layer and the Area Type grew to a sentence; by #107, the Artboard widened for a Group
  // whose gradient Fill runs across a rect and a turned text; by #50, a tenth Artboard holding a
  // Clipping Mask whose turned, translucent Clipping Path has a gradient Fill and two Strokes; by
  // #49, an eleventh holding a gradient clipped by turned, stroked, overflowing Area Type and a
  // fill clipped by turned Point Type with a turned, shifted character; by #51, a twelfth holding a
  // Layer clipped by a turned, stroked Path over a gradient, with a sublayer clipped by a text; by
  // #148, a thirteenth holding a plain, a filled and a mirrored spiral; by #159, a fourteenth
  // holding Chinese mixed with Latin in Regular and Bold (bundling Noto Sans SC moved no pixel); by
  // #160, a fifteenth holding a CJK Area Type wrapped between characters; by #164, a sixteenth
  // holding Korean Point Type in Regular and Bold and a Korean Area Type; by #67, a seventeenth
  // holding texts whose Character Ranges override stroke, tracking, font style, family and size. This export SVG names no
  // Noto chunk, so its Chinese and Korean draw as .notdef boxes; render's does not.
  // By #175, the texts that named the product say Kalamo, one clipping text says KAL, and the
  // namespace is kalamo.cc. By #58, an eighteenth holding Point Type and Area Type centred,
  // right-aligned and justified; by #196, its right-aligned Point Type tracks, beside a tracked
  // centred one; by #56, a nineteenth holding Area Type in a circle and in a concave frame. By
  // #199, CJK Area Type lines stack by leading alone, moving the CJK and Korean Area Types' later
  // lines up, and a twentieth Artboard holds Point Type and Area Type mixing Latin and CJK lines.
  expect(await hash(toSvg(doc, docRect(doc), { images }))).toBe(
    "bb9cda3f211bbdc835837657df6a2f6b778325f8958787c70aca5f66cc7cfa2f",
  );
  expect(await hash(toSvg(doc, scopeRect(doc, turned), { scope: turned, images }))).toBe(
    "24c1e7ad8db33f59933a1b355c879cb19bfdfd67d70b11427b196aa646ea4b60",
  );
});

/** The fixture Document, with the file of each of its Images. */
function fixtureDoc() {
  const file = parseDocument(fixture);
  const doc = {
    id: "d",
    version: 1 as const,
    rev: 0,
    ...file,
    nodes: new Map(file.nodes.map((n) => [n.id, n])),
  };
  return { doc, images: imageSource(file.images) };
}

it("draws each fixture Artboard by its scope as the whole Document draws it there (ADR-0054)", async () => {
  const { doc, images } = fixtureDoc();
  const all = fit(docRect(doc), 2);
  const whole = await svgToPixels(renderSvg(doc, all.rect, { scale: 2, images }), 2);
  expect(doc.artboards).toHaveLength(20);
  for (const a of doc.artboards) {
    const scope = { artboardId: a.id };
    const { rect, pixelSize } = fit(scopeRect(doc, scope), 2);
    const one = await svgToPixels(renderSvg(doc, rect, { scope, scale: 2, images }), 2);
    expect({ width: one.width, height: one.height }).toEqual(pixelSize);
    const [dx, dy] = [(rect.x - all.rect.x) * 2, (rect.y - all.rect.y) * 2];
    let worst = 0;
    for (let y = 0; y < one.height; y++) {
      for (let x = 0; x < one.width * 4; x++) {
        const got = one.pixels[y * one.width * 4 + x] ?? 0;
        const want = whole.pixels[(y + dy) * whole.width * 4 + dx * 4 + x] ?? 0;
        worst = Math.max(worst, Math.abs(got - want));
      }
    }
    // Only antialiasing may differ, which resvg's f32 geometry moves with the image's origin: by
    // up to 16/255 at the edges of "Containers", 2770 px from the whole Document's, as it does when
    // the same SVG is drawn from a rect grown to x = 0. A Node left out would differ by far more.
    expect(worst, a.name).toBeLessThanOrEqual(16);
  }
}, 30_000);

it("draws the fixture's Layer Clipping Mask inside its Clipping Path, its Stroke over it (ADR-0053)", async () => {
  const { doc, images } = fixtureDoc();
  const artboard = doc.artboards.find((a) => a.name === "Layer Clipping");
  const scope = { artboardId: artboard?.id ?? "" };
  const svg = renderSvg(doc, artboard?.frame, { scope, scale: 4, images });
  const { pixels, width } = await svgToPixels(svg, 4);
  // The Artboard's (1180, 130) is pixel 0; a Document point reads the pixel it starts.
  const at = (x: number, y: number) => {
    const i = (Math.floor((y - 130) * 4) * width + Math.floor((x - 1180) * 4)) * 4;
    return [...pixels.subarray(i, i + 4)];
  };
  // The gradient runs #FFB703 at (1180, 130) to #8338EC at (1300, 250).
  const gradient = (x: number, y: number) => {
    const t = (x - 1180 + y - 130 + 0.25) / 240;
    const [a, b] = [
      [255, 183, 3],
      [131, 56, 236],
    ];
    return a.map((v, i) => v + ((b[i] as number) - v) * t);
  };
  const near = (got: number[], rgb: number[]) =>
    got[3] === 255 && rgb.every((v, i) => Math.abs((got[i] as number) - v) <= 3);
  // Inside the clip; on the sublayer's red rect above the glyphs, where its text clip leaves it out.
  for (const [x, y] of [
    [1240, 170],
    [1250, 195],
  ] as const) {
    expect(near(at(x, y), gradient(x, y)), `${x}, ${y}`).toBe(true);
  }
  // In the I's stem, the sublayer's red rect.
  expect(near(at(1238, 225), [0xe6, 0x39, 0x46])).toBe(true);
  // The top edge's middle, turned 20° about (1240, 190), is (1255.39, 147.71), its outward normal
  // (0.342, -0.94): the Stroke's outer half, 0.8 out, and nothing 3 out.
  expect(at(1255.66, 146.96)).toEqual([0x26, 0x46, 0x53, 255]);
  expect(at(1256.42, 144.89)[3]).toBe(0);
  // Outside the clip, the gradient and the sublayer's red rect are gone.
  expect(at(1182, 132)[3]).toBe(0);
  expect(at(1186, 244)[3]).toBe(0);
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

it("clips by a text's Noto Sans SC glyphs, not by .notdef boxes (ADR-0052, ADR-0063)", async () => {
  const clipped = async (content: string) => {
    const { doc, defaultLayerId: parentId } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 120, height: 120, background: "#FFFFFF" }],
    });
    const [content_, clip] = createNodes(doc, [
      {
        type: "rect",
        parentId,
        x: 0,
        y: 0,
        width: 120,
        height: 120,
        appearance: { fills: [{ color: "#FF0000" }] },
      },
      { type: "text", parentId, x: 10, y: 100, content, fontSize: 100 },
    ]).nodes;
    if (!content_ || !clip) throw new Error("setup");
    makeMask(doc, { clipNodeId: clip.id, contentIds: [content_.id] });
    return ink(renderSvg(doc));
  };
  const [cjk, notdef] = [await clipped("小"), await clipped("ก")];
  // 小's vertical stroke runs down the middle of its em square, above where a .notdef box starts.
  const at = (drawn: [number, number][], x: number, y: number) =>
    drawn.some(([px, py]) => px === x && py === y);
  expect(at(cjk, 60, 30)).toBe(true);
  expect(at(notdef, 60, 30)).toBe(false);
});

it("clips by a text's Noto Sans KR glyphs, not by .notdef boxes (ADR-0052, ADR-0066)", async () => {
  const clipped = async (content: string) => {
    const { doc, defaultLayerId: parentId } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 120, height: 120, background: "#FFFFFF" }],
    });
    const [content_, clip] = createNodes(doc, [
      {
        type: "rect",
        parentId,
        x: 0,
        y: 0,
        width: 120,
        height: 120,
        appearance: { fills: [{ color: "#FF0000" }] },
      },
      { type: "text", parentId, x: 10, y: 100, content, fontSize: 100 },
    ]).nodes;
    if (!content_ || !clip) throw new Error("setup");
    makeMask(doc, { clipNodeId: clip.id, contentIds: [content_.id] });
    return ink(renderSvg(doc));
  };
  const [hangul, notdef] = [await clipped("한"), await clipped("ก")];
  // Source Sans 3's .notdef box is 660 units tall, so it reaches y = 34; 한's ㅎ rises above it.
  expect(notdef.every(([, y]) => y >= 33)).toBe(true);
  expect(hangul.some(([, y]) => y < 30)).toBe(true);
}, 30_000);

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

it("draws a linked Image's pixels, and a missing link as a thin grey crossed frame (ADR-0042)", async () => {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 100, height: 40, background: "#FFFFFF" }],
  });
  const src = "a".repeat(64);
  doc.images.set(src, { mime: "image/png", width: 2, height: 2 });
  createNodes(doc, [
    { type: "image", parentId, src, file: "red.png", x: 0, y: 0, width: 20, height: 20 },
    // Scaled 2x, so a stroke that scaled with it would be 2 px wide.
    { type: "image", parentId, file: "gone.png", x: 25, y: 5, width: 10, height: 10 },
  ]);
  const scaled = [...doc.nodes.values()].find((n) => n.type === "image" && !n.src);
  if (!scaled) throw new Error("setup");
  scaled.transform = [2, 0, 0, 2, 0, 0];
  const { pixels, width } = await svgToPixels(
    renderSvg(doc, docRect(doc), { images: () => RED_2x2_PNG }),
    1,
  );
  const at = (x: number, y: number) => [
    ...pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 3),
  ];
  expect(at(10, 10)).toEqual([255, 0, 0]);
  // The frame is 50..70 by 10..30. Its edge on x = 50, one pixel wide, half-covers two columns.
  expect([48, 49, 50, 51].map((x) => at(x, 20)[0])).toEqual([255, 204, 204, 255]);
  // Both diagonals cross at the centre; between them and the edges is blank.
  expect(at(60, 20)[0]).toBeLessThan(250);
  expect(at(60, 13)).toEqual([255, 255, 255]);
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
  // Reverse Path Direction and Add Anchor Points keep the outline: the rasteriser's coverage of an
  // edge pixel shifts with the segments' order and count (16 of 255 here), where an outline moved
  // by a tenth of a pixel shifts it by more than 24.
  pathOp(doc, { nodeIds: ids, op: "reverse" });
  pathOp(doc, { nodeIds: ids, op: "add_anchors" });
  const split = await svgToPixels(toSvg(doc, rect), 1);
  expect(split.pixels.every((v, i) => Math.abs(v - (after.pixels[i] ?? 0)) <= 24)).toBe(true);
});

it("draws a Group's Stroke above its children at contents 0 and behind them at 1 (ADR-0043)", async () => {
  const pixel = async (contents: number, x: number, y: number) => {
    const { doc, defaultLayerId } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 80, height: 60, background: "#FFFFFF" }],
    });
    const blue = { fills: [{ color: "#0000FF" }] };
    createNodes(doc, [
      {
        type: "group",
        parentId: defaultLayerId,
        appearance: { strokes: [{ color: "#FF0000", width: 6 }], contents },
        children: [
          { type: "rect", x: 10, y: 10, width: 40, height: 40, appearance: blue },
          { type: "rect", x: 30, y: 10, width: 40, height: 40, appearance: blue },
        ],
      },
    ]);
    const { pixels, width } = await svgToPixels(toSvg(doc, docRect(doc)), 1);
    const i = (y * width + x) * 4;
    return [...pixels.subarray(i, i + 3)];
  };
  const red = [255, 0, 0];
  const blue = [0, 0, 255];
  // The left rect's right edge, inside the right rect: the Stroke shows only when above.
  expect(await pixel(0, 50, 30)).toEqual(red);
  expect(await pixel(1, 50, 30)).toEqual(blue);
  // Outside both, the outer half of the Stroke shows either way.
  expect(await pixel(0, 8, 30)).toEqual(red);
  expect(await pixel(1, 8, 30)).toEqual(red);
});

it.each(COMPOSITING)("composes as one image: $name (ADR-0044)", async (c) => {
  const { doc, defaultLayerId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100, background: "#FFFFFF" }],
  });
  createNodes(doc, c.nodes.map((n) => ({ ...n, parentId: defaultLayerId })) as never);
  const named = (name: string) => [...doc.nodes.values()].find((n) => n.name === name) as Node;
  for (const m of c.masks ?? []) {
    const { group } = makeMask(doc, {
      clipNodeId: named(m.clip).id,
      contentIds: m.content.map((k) => named(k).id),
    });
    doc.nodes.set(group.id, { ...group, name: m.name });
  }
  for (const [k, t] of Object.entries(c.transforms ?? {})) {
    transformNodes(doc, { nodeIds: [named(k).id], ...t } as never);
  }
  for (const [k, patch] of Object.entries(c.patches)) {
    const node = k === "Layer" ? doc.nodes.get(defaultLayerId) : named(k);
    Object.assign(node as Node, patch);
  }
  const { pixels, width } = await svgToPixels(toSvg(doc, docRect(doc)), 1);
  // Pixel [x, y] covers x..x+1, so a Document point reads its own pixel.
  for (const { x, y, rgb } of c.probes) {
    const i = (y * width + x) * 4;
    expect([x, y, ...pixels.subarray(i, i + 3)]).toSatisfy(
      ([, , ...got]: number[]) => near(got, rgb),
      `${x}, ${y} near ${rgb.map(Math.round)}`,
    );
  }
});
