import { expect, it } from "vitest";
import { SOURCE_SANS_3 } from "./source-sans-3.ts";
import {
  type FontStyle,
  fileGlyphWarnings,
  fontWarnings,
  glyphs,
  glyphWarnings,
  layoutText,
  overflowWarnings,
  textBox,
} from "./text.ts";

// Read straight from SourceSans3-Regular.ttf, not from the generated table: unitsPerEm 1000,
// hhea ascender 1000 and descender -326; advances H 652, i 246, space 200, .notdef 653.
const at12 = (units: number) => (units * 12) / 1000;

it("measures a line by its advance widths, from the ascender to the descender", () => {
  const box = textBox({ x: 10, y: 50, content: "Hi", fontSize: 12 });
  expect(box.x).toBe(10);
  expect(box.y).toBeCloseTo(50 - at12(1000));
  expect(box.width).toBeCloseTo(at12(652 + 246));
  expect(box.height).toBeCloseTo(at12(1000 + 326));
});

it("grows by each added character's advance, and counts .notdef for one the font lacks", () => {
  const width = (content: string) => textBox({ x: 0, y: 0, content, fontSize: 12 }).width;
  expect(width("Hi Hi") - width("Hi")).toBeCloseTo(at12(200 + 652 + 246));
  expect(width("中")).toBeCloseTo(at12(653));
});

it("carries the font's vertical metrics", () => {
  const { unitsPerEm, ascender, descender } = SOURCE_SANS_3;
  expect([unitsPerEm, ascender, descender]).toEqual([1000, 1000, -326]);
});

// Read straight from the other five TTFs: advances of H, and Bold's .notdef.
it("carries each bundled face's advances", () => {
  const { faces } = SOURCE_SANS_3;
  expect(
    [
      faces.Regular,
      faces.Italic,
      faces.Bold,
      faces["Bold Italic"],
      faces.Black,
      faces["Black Italic"],
    ].map((f) => f.advances[72]),
  ).toEqual([652, 622, 674, 652, 682, 664]);
  expect(faces.Bold.notdef).toBe(690);
});

it("measures each style in the bundled face CSS matches it to (ADR-0028)", () => {
  const width = (fontStyle?: FontStyle) =>
    textBox({ x: 0, y: 0, content: "Hi", fontSize: 12, fontStyle }).width;
  expect(width("Bold")).toBeCloseTo(at12(674 + 276));
  expect(width("Semibold")).toBeCloseTo(width("Bold"));
  expect(width("Medium")).toBeCloseTo(at12(652 + 246));
  expect(width(undefined)).toBeCloseTo(at12(652 + 246));
  expect(width("ExtraBold Italic")).toBeCloseTo(at12(664 + 276));
});

it("wraps Area Type by the advances of its style", () => {
  const lines = (fontStyle: FontStyle) =>
    layoutText({
      kind: "area",
      x: 0,
      y: 0,
      width: 24.5,
      height: 100,
      content: "Hi Hi",
      fontSize: 12,
      fontStyle,
    }).lines.length;
  expect([lines("Regular"), lines("Bold")]).toEqual([1, 2]);
});

it("warns for a style Zibel does not bundle, naming the face it renders in", () => {
  const text = (id: string, fontFamily: string, fontStyle: string) =>
    ({ id, type: "text", fontFamily, fontStyle }) as Parameters<typeof fontWarnings>[0][number];
  expect(
    fontWarnings([
      text("a", "Source Sans 3", "Semibold"),
      text("b", "Helvetica", "Bold"),
      text("c", "Source Sans 3", "Black Italic"),
    ]).map((w) => w.message),
  ).toEqual([
    "Source Sans 3 Semibold is not bundled, so it renders in Source Sans 3 Bold; the name is kept.",
    "Helvetica Bold is not bundled, so it renders in Source Sans 3 Bold; the name is kept.",
  ]);
});

it("warns once for each text in a font Zibel does not bundle", () => {
  const text = (id: string, fontFamily: string) =>
    ({ id, type: "text", fontFamily }) as Parameters<typeof fontWarnings>[0][number];
  expect(
    fontWarnings([
      text("a", "Source Sans 3"),
      text("b", "Helvetica"),
      { id: "c", type: "rect" } as never,
    ]),
  ).toEqual([
    {
      code: "FONT_MISSING",
      nodeId: "b",
      message: "Helvetica is not bundled, so it renders in Source Sans 3; the name is kept.",
    },
  ]);
});

const typed = (id: string, content: string, fontStyle?: FontStyle) =>
  ({ id, type: "text", fontFamily: "Source Sans 3", content, fontStyle }) as Parameters<
    typeof glyphWarnings
  >[0][number];

it("warns MISSING_GLYPHS once per text, naming each missing character once", () => {
  expect(
    glyphWarnings([
      typed("a", "Hi 小动物小"),
      typed("b", "Hi\nthere"),
      { id: "c", type: "rect" } as never,
    ]),
  ).toEqual([
    {
      code: "MISSING_GLYPHS",
      nodeId: "a",
      message:
        "Source Sans 3 has no glyphs for 小, 动, 物; they render as .notdef boxes and measure as its width.",
    },
  ]);
});

it("names at most 20 missing characters and counts the rest", () => {
  const content = String.fromCodePoint(...Array.from({ length: 23 }, (_, i) => 0x4e00 + i));
  const [w] = glyphWarnings([typed("a", content)]);
  expect(w?.message).toMatch(/^Source Sans 3 has no glyphs for 一, 丁, .*, 专 and 3 more; /);
  expect(w?.message.split(", ")).toHaveLength(20);
});

it("gives every bundled face the same code points, so any style warns as Regular does", () => {
  const faces = Object.values(SOURCE_SANS_3.faces).map((f) => Object.keys(f.advances).join());
  expect(new Set(faces).size).toBe(1);
  const styles: FontStyle[] = ["Regular", "Bold", "Black Italic", "Semibold"];
  const messages = styles.map((s) => glyphWarnings([typed("a", "é 小 ✓", s)])[0]?.message);
  expect(new Set(messages).size).toBe(1);
  expect(messages[0]).toContain("小");
});

it("warns once for a file, naming the union of its texts' missing characters", () => {
  expect(fileGlyphWarnings([typed("a", "ok"), typed("b", "小动"), typed("c", "动物")])).toEqual([
    {
      code: "MISSING_GLYPHS",
      nodeId: "b",
      message:
        "Source Sans 3 has no glyphs for 小, 动, 物; they render as .notdef boxes and measure as its width.",
    },
  ]);
  expect(fileGlyphWarnings([typed("a", "ok")])).toEqual([]);
});

// Area Type as Inkscape 1.2.2 lays it out in the bundled font, measured headless (ADR-0022): the
// first baseline sits (leading − fontSize) / 2 + fontSize · 1000 / 1326 below the frame's top.
const area = (content: string, frame: { width: number; height: number }, leading?: number) =>
  layoutText({ kind: "area", x: 150, y: 20, ...frame, content, fontSize: 12, leading });

it("breaks Point Type at hard returns only, one leading apart, 120% of fontSize when Auto", () => {
  const auto = layoutText({ x: 10, y: 50, content: "a b\n\nc", fontSize: 12 });
  expect(auto.lines.map((l) => [l.text, l.x, l.y])).toEqual([
    ["a b", 10, 50],
    ["", 10, 64.4],
    ["c", 10, 78.8],
  ]);
  expect(auto.overflow).toBe("");
  const set = layoutText({ x: 10, y: 50, content: "a\nb", fontSize: 12, leading: 15 });
  expect(set.lines.map((l) => l.y)).toEqual([50, 65]);
});

it("measures multi-line Point Type from the first ascender to the last descender, as wide as its widest line", () => {
  const box = textBox({ x: 10, y: 50, content: "i\nHi", fontSize: 12, leading: 15 });
  expect(box.y).toBeCloseTo(50 - at12(1000));
  expect(box.width).toBeCloseTo(at12(652 + 246));
  expect(box.height).toBeCloseTo(15 + at12(1000 + 326));
});

it("wraps Area Type at spaces where Inkscape does, trailing spaces and returns kept on the line", () => {
  const { lines, overflow } = area(
    "The quick brown fox jumps over the lazy dog again and again.\nNew para",
    { width: 100, height: 80 },
  );
  expect(lines.map((l) => l.text)).toEqual([
    "The quick brown ",
    "fox jumps over the ",
    "lazy dog again and ",
    "again.\n",
    "New para",
  ]);
  expect(lines.every((l) => l.x === 150)).toBe(true);
  expect(lines[0]?.y).toBeCloseTo(30.249774, 5);
  expect(lines[4]?.y).toBeCloseTo(30.249774 + 4 * 14.4, 5);
  expect(overflow).toBe("");
});

it("keeps empty paragraphs, and no line for a final return", () => {
  const { lines } = area("a\n\nb\n", { width: 100, height: 100 }, 15);
  expect(lines.map((l) => l.text)).toEqual(["a\n", "\n", "b\n"]);
  expect(lines.map((l) => l.y - 20)).toEqual(
    [10.549774, 25.549774, 40.549774].map((y) => expect.closeTo(y, 5)),
  );
});

it("shows a line while 90% of its leading fits the frame, and holds the rest as overflow", () => {
  expect(area("one\ntwo\nthree\nfour", { width: 100, height: 40 })).toMatchObject({
    lines: [{ text: "one\n" }, { text: "two\n" }],
    overflow: "three\nfour",
  });
  expect(area("one\ntwo\nthree\nfour", { width: 100, height: 3 * 14.4 - 1.44 }).lines).toHaveLength(
    3,
  );
  expect(area("one\ntwo\nthree\nfour", { width: 100, height: 3 * 14.4 - 1.45 }).lines).toHaveLength(
    2,
  );
});

it("overflows a word wider than the frame and everything after it, as Inkscape does", () => {
  const text = "Supercalifragilistic word  two   spaces";
  expect(area(text, { width: 50, height: 100 })).toEqual({ lines: [], overflow: text });
});

it("measures Area Type as its frame", () => {
  const frame = { x: 150, y: 20, width: 100, height: 40 };
  expect(textBox({ kind: "area", ...frame, content: "one", fontSize: 12 })).toEqual(frame);
});

it("warns TEXT_OVERFLOW for each Area Type whose content does not all fit", () => {
  const text = (id: string, kind: "point" | "area", height: number) =>
    ({
      id,
      type: "text",
      kind,
      x: 0,
      y: 0,
      width: 100,
      height,
      content: "one\ntwo",
      fontSize: 12,
    }) as Parameters<typeof overflowWarnings>[0][number];
  expect(
    overflowWarnings([
      text("fits", "area", 40),
      text("over", "area", 20),
      text("point", "point", 1),
    ]),
  ).toEqual([
    {
      code: "TEXT_OVERFLOW",
      nodeId: "over",
      message:
        "3 characters do not fit the frame and are not drawn; enlarge the frame or shorten the content.",
    },
  ]);
});

// Tracking and Character Ranges (ADR-0029).
it("adds tracking between characters, not after the last", () => {
  expect(textBox({ x: 10, y: 50, content: "Hi", fontSize: 12, tracking: 100 }).width).toBeCloseTo(
    at12(652 + 246) + 1.2,
  );
});

it("wraps Area Type by the tracked width, as Inkscape 1.2.2 measures it (72.16)", () => {
  const hh = (width: number) =>
    layoutText({
      kind: "area",
      x: 0,
      y: 0,
      width,
      height: 100,
      content: "HH",
      fontSize: 40,
      tracking: 500,
    });
  expect(hh(75).lines.map((l) => l.text)).toEqual(["HH"]);
  expect(hh(70)).toMatchObject({ lines: [], overflow: "HH" });
});

it("keeps a negatively tracked box from a negative width, holding every character", () => {
  const box = textBox({ x: 0, y: 0, content: "ii", fontSize: 10, tracking: -1000 });
  expect(box.x).toBeCloseTo(2.46 - 10);
  expect(box.width).toBeCloseTo(10);
});

it("starts each line at its first character's code-point index", () => {
  expect(
    layoutText({ x: 0, y: 0, content: "ab\ncd", fontSize: 12 }).lines.map((l) => l.start),
  ).toEqual([0, 3]);
  expect(area("a😀\nb", { width: 100, height: 100 }).lines.map((l) => l.start)).toEqual([0, 3]);
});

it("places each character at its origin, with its range's overrides", () => {
  const close = (g: object) =>
    Object.fromEntries(
      Object.entries(g).map(([k, v]) => [k, typeof v === "number" ? expect.closeTo(v, 6) : v]),
    );
  expect(
    glyphs({
      x: 10,
      y: 50,
      content: "Hi",
      fontSize: 12,
      tracking: 100,
      ranges: [{ start: 1, end: 2, fill: "#FF0000", baselineShift: 2, rotation: 90 }],
    }),
  ).toEqual([
    close({ char: "H", x: 10, y: 50, width: 7.824 }),
    close({
      char: "i",
      x: 19.024,
      y: 50,
      width: 2.952,
      fill: "#FF0000",
      baselineShift: 2,
      rotation: 90,
    }),
  ]);
});

it("grows Point Type's box to hold a shifted or rotated character", () => {
  const box = (range: object) =>
    textBox({ x: 0, y: 0, content: "H", fontSize: 10, ranges: [{ start: 0, end: 1, ...range }] });
  const near = (r: object) => Object.values(r).map((v) => Math.round(v * 1e6) / 1e6);
  expect(near(box({ baselineShift: 5 }))).toEqual([0, -15, 6.52, 18.26]);
  expect(near(box({ rotation: 90 }))).toEqual([-3.26, -10, 13.26, 16.52]);
});

it("measures Area Type with ranges as its frame", () => {
  const frame = { x: 150, y: 20, width: 100, height: 40 };
  expect(
    textBox({
      kind: "area",
      ...frame,
      content: "one",
      fontSize: 12,
      ranges: [{ start: 0, end: 1, rotation: 90 }],
    }),
  ).toEqual(frame);
});
