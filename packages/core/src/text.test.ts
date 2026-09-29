import { expect, it } from "vitest";
import { lineBreakUnits } from "./line-break.ts";
import { NOTO_SANS_KR } from "./noto-sans-kr.ts";
import { NOTO_SANS_SC } from "./noto-sans-sc.ts";
import { SOURCE_SANS_3 } from "./source-sans-3.ts";
import {
  drawnFamily,
  type FontStyle,
  fileGlyphWarnings,
  fontFamilies,
  fontWarnings,
  glyphs,
  glyphWarnings,
  hasGlyph,
  layoutText,
  notdefBox,
  overflowWarnings,
  textBox,
} from "./text.ts";

// Read straight from SourceSans3-Regular.ttf, not from the generated table: unitsPerEm 1000,
// typographic ascender 1000 and descender -326; advances H 652, i 246, space 200, .notdef 653.
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
  expect(width("ก")).toBeCloseTo(at12(653));
});

// Read straight from NotoSansSC-Regular.otf and -Bold.otf: 小 and 。 1000 in both, H 728 and 757,
// i 275 and 304 (ADR-0063).
it("measures a character Source Sans 3 lacks by Noto Sans SC's advance (ADR-0063)", () => {
  const box = textBox({ x: 0, y: 0, content: "Hi 小动物。", fontSize: 10 });
  expect(box.width).toBeCloseTo(((652 + 246 + 200) * 10) / 1000 + 4 * 10);
  expect(glyphWarnings([typed("a", "小动物")])).toEqual([]);
  expect(glyphWarnings([typed("a", "กข")]).map((w) => w.code)).toEqual(["MISSING_GLYPHS"]);
});

// The two Noto tables agree on every character Source Sans 3 lacks, so the face a style picks
// shows in the Latin of a text set in Noto Sans SC.
it("measures in the Noto Sans SC face CSS matches the style to, upright for italic", () => {
  const width = (fontStyle: FontStyle, content = "Hi") =>
    textBox({ x: 0, y: 0, content, fontSize: 1000, fontFamily: "Noto Sans SC", fontStyle }).width;
  expect(width("Bold")).toBeCloseTo(757 + 304);
  expect(width("Black")).toBeCloseTo(757 + 304);
  expect(width("Semibold Italic")).toBeCloseTo(757 + 304);
  expect(width("Italic")).toBeCloseTo(728 + 275);
  expect(width("Medium")).toBeCloseTo(728 + 275);
  const cjk = (fontStyle: FontStyle) =>
    textBox({ x: 0, y: 0, content: "小", fontSize: 10, fontStyle }).width;
  expect([cjk("Bold"), cjk("Black"), cjk("Italic"), cjk("Black Italic")]).toEqual([10, 10, 10, 10]);
});

it("draws and measures a text in Noto Sans SC in it, without FONT_MISSING", () => {
  const noto = { x: 0, y: 0, content: "Hi", fontSize: 1000, fontFamily: "Noto Sans SC" };
  expect(textBox(noto).width).toBeCloseTo(728 + 275);
  const text = (fontStyle: FontStyle) => ({ id: "a", type: "text", ...noto, fontStyle }) as never;
  expect(fontWarnings([text("Regular"), text("Bold")])).toEqual([]);
  expect(fontWarnings([text("Black")]).map((w) => w.message)).toEqual([
    "Noto Sans SC Black is not bundled, so it renders in Noto Sans SC Bold; the name is kept.",
  ]);
  expect(fontFamilies(noto)).toEqual(["Noto Sans SC", "Source Sans 3", "Noto Sans KR"]);
  expect(drawnFamily(noto, "H")).toBe("Noto Sans SC");
  expect(drawnFamily(noto, "\u{1F600}")).toBe("Noto Sans SC");
  expect(fontFamilies({ fontFamily: "Helvetica" })).toEqual([
    "Source Sans 3",
    "Noto Sans SC",
    "Noto Sans KR",
  ]);
  expect(drawnFamily({ fontFamily: "Helvetica" }, "H")).toBe("Source Sans 3");
  expect(drawnFamily({ fontFamily: "Helvetica" }, "小")).toBe("Noto Sans SC");
  expect(drawnFamily({ fontFamily: "Helvetica" }, "한")).toBe("Noto Sans KR");
});

// Read straight from NotoSansKR-Regular.otf and -Bold.otf: 한, 국 and 어 920 in both, H 728 and
// 757, i 275 and 304, space 224 and 227, ‘ 278 (Noto Sans SC's is 1000) (ADR-0066).
it("measures Hangul by Noto Sans KR's advance, after Source Sans 3 and Noto Sans SC (ADR-0066)", () => {
  const width = (content: string, fontStyle?: FontStyle) =>
    textBox({ x: 0, y: 0, content, fontSize: 1000, fontStyle }).width;
  expect(width("Hi 한국어")).toBeCloseTo(652 + 246 + 200 + 3 * 920);
  expect(glyphWarnings([typed("a", "Hi 한국어")])).toEqual([]);
  expect(drawnFamily({}, "小")).toBe("Noto Sans SC");
  expect(drawnFamily({}, "漢")).toBe("Noto Sans SC");
  expect(width("小")).toBe(1000);
  expect(glyphWarnings([typed("a", "한\u{1F600}")]).map((w) => w.message)).toEqual([
    expect.stringContaining("has glyphs for \u{1F600};"),
  ]);
  for (const style of ["Bold", "Black", "Italic", "Black Italic"] as const)
    expect(width("한", style)).toBe(920);
});

it("draws and measures a text in Noto Sans KR in it, Latin and Hanja included, without FONT_MISSING", () => {
  const kr = { x: 0, y: 0, content: "Hi", fontSize: 1000, fontFamily: "Noto Sans KR" };
  const width = (fontStyle: FontStyle, content = "Hi") =>
    textBox({ ...kr, content, fontStyle }).width;
  expect(width("Regular")).toBeCloseTo(728 + 275);
  expect(width("Italic")).toBeCloseTo(728 + 275);
  expect(width("Bold")).toBeCloseTo(757 + 304);
  expect(width("Black")).toBeCloseTo(757 + 304);
  expect(width("Regular", "\u2018")).toBe(278);
  const text = (fontStyle: FontStyle) => ({ id: "a", type: "text", ...kr, fontStyle }) as never;
  expect(fontWarnings([text("Regular"), text("Bold")])).toEqual([]);
  expect(fontFamilies(kr)).toEqual(["Noto Sans KR", "Source Sans 3", "Noto Sans SC"]);
  expect([..."H漢한"].map((c) => drawnFamily(kr, c))).toEqual(Array(3).fill("Noto Sans KR"));
});

it("gives both faces of each Noto family the same code points", () => {
  const points = ({ runs }: (typeof NOTO_SANS_SC.faces)["Regular"]) =>
    runs.flatMap(([c, n]) => Array.from({ length: n }, (_, i) => c + i)).join();
  for (const { faces } of [NOTO_SANS_SC, NOTO_SANS_KR])
    expect(points(faces.Bold)).toBe(points(faces.Regular));
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
      typed("a", "Hi 小กขคก"),
      typed("b", "Hi\nthere"),
      { id: "c", type: "rect" } as never,
    ]),
  ).toEqual([
    {
      code: "MISSING_GLYPHS",
      nodeId: "a",
      message:
        "None of Source Sans 3, Noto Sans SC, or Noto Sans KR has glyphs for ก, ข, ค; they render as .notdef boxes and measure as the box's width.",
    },
  ]);
});

it("names at most 20 missing characters and counts the rest", () => {
  const content = String.fromCodePoint(...Array.from({ length: 23 }, (_, i) => 0x0e01 + i));
  const [w] = glyphWarnings([typed("a", content)]);
  expect(w?.message).toMatch(/^None of .* has glyphs for ก, ข, .*, ด and 3 more; /);
  expect(w?.message.split(" for ")[1]?.split(", ")).toHaveLength(20);
});

it("gives every bundled face the same code points, so any style warns as Regular does", () => {
  const faces = Object.values(SOURCE_SANS_3.faces).map((f) => Object.keys(f.advances).join());
  expect(new Set(faces).size).toBe(1);
  const styles: FontStyle[] = ["Regular", "Bold", "Black Italic", "Semibold"];
  const messages = styles.map((s) => glyphWarnings([typed("a", "é 小 ก", s)])[0]?.message);
  expect(new Set(messages).size).toBe(1);
  expect(messages[0]).toContain("for ก;");
});

it("warns once for a file, naming the union of its texts' missing characters", () => {
  expect(fileGlyphWarnings([typed("a", "小"), typed("b", "กข"), typed("c", "ขค")])).toEqual([
    {
      code: "MISSING_GLYPHS",
      nodeId: "b",
      message:
        "None of Source Sans 3, Noto Sans SC, or Noto Sans KR has glyphs for ก, ข, ค; they render as .notdef boxes and measure as the box's width.",
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

// Break opportunities as Pango 1.50.12's pango_get_log_attrs gives them, which Inkscape 1.2.2 wraps at.
it("breaks CJK between characters, never before closing or small kana, never after opening (ADR-0064)", () => {
  expect(lineBreakUnits("他说：「你好。」（中文、日文）").join("|")).toBe(
    "他|说：|「你|好。」|（中|文、|日|文）",
  );
  expect(lineBreakUnits("ちょっとコーヒーを々々飲みましょう。").join("|")).toBe(
    "ちょっ|と|コー|ヒー|を々々|飲|み|ま|しょ|う。",
  );
  expect(lineBreakUnits("使用SVG格式").join("|")).toBe("使|用|SVG|格|式");
  expect(lineBreakUnits("한국어문장입니다").join("|")).toBe("한|국|어|문|장|입|니|다");
  expect(lineBreakUnits("价格是$5，涨了20%。").join("|")).toBe("价|格|是|$5，|涨|了|20%。");
  expect(lineBreakUnits("  one two\n").join("|")).toBe("  |one |two\n");
});

// Noto Sans SC draws each ideograph and CJK punctuation mark 1000 units wide, 12pt at fontSize 12.
it("wraps a CJK paragraph between characters, each line within the frame", () => {
  const content = "我们在同一张画布上编辑矢量图形。智能体和人一起工作，";
  const { lines, overflow } = area(content, { width: 60, height: 95 });
  expect(lines.map((l) => l.text)).toEqual([
    "我们在同一",
    "张画布上编",
    "辑矢量图",
    "形。智能体",
    "和人一起工",
    "作，",
  ]);
  expect(lines.every((l) => [...l.text].length * 12 <= 60)).toBe(true);
  expect(lines.map((l) => l.start)).toEqual([0, 5, 10, 14, 19, 24]);
  expect(overflow).toBe("");
  expect(area(content, { width: 60, height: 93.9 }).lines).toHaveLength(5);
});

// Inkscape 1.2.2 measured headless: Noto's typographic box, 880 above and 120 below, with half the
// leading, rises 1.76 above Source Sans 3's at 12 pt, so a line holding CJK is 1.76 taller, and a
// later line then shows only while all of its leading, not 90%, lies in the frame.
it("stacks Area Type lines by the em boxes of the families they draw in, as Inkscape (ADR-0064)", () => {
  const { lines } = area("Hi\n中文\nHi\n\n中文", { width: 100, height: 100 });
  expect(lines.map((l) => l.y - 20)).toEqual(
    [10.249774, 26.16, 40.56, 54.96, 70.870226].map((y) => expect.closeTo(y, 5)),
  );
  expect(area("中文", { width: 100, height: 14.319 }).lines).toHaveLength(0);
  expect(area("中文", { width: 100, height: 14.32 }).lines).toHaveLength(1);
  expect(area("Hi\n中文", { width: 100, height: 28.799 }).lines).toHaveLength(1);
  expect(area("Hi\n中文", { width: 100, height: 28.8 }).lines).toHaveLength(2);
  expect(area("中文\nHi", { width: 100, height: 28.87 }).lines).toHaveLength(1);
  expect(area("中文\nHi", { width: 100, height: 28.871 }).lines).toHaveLength(2);
  // Noto Sans KR's typographic box is Noto Sans SC's, 880 above and 120 below (ADR-0066).
  expect(area("Hi\n한국\nHi\n\n한국", { width: 100, height: 100 }).lines.map((l) => l.y)).toEqual(
    area("Hi\n中文\nHi\n\n中文", { width: 100, height: 100 }).lines.map((l) => l.y),
  );
  expect(area("한국", { width: 100, height: 14.319 }).lines).toHaveLength(0);
  expect(area("한국", { width: 100, height: 14.32 }).lines).toHaveLength(1);
});

it("never starts an Area Type line with closing punctuation, small kana or ー, nor ends one with opening", () => {
  const lines = (content: string, width: number) =>
    area(content, { width, height: 100 }).lines.map((l) => l.text);
  expect(lines("你好。世界、再见", 24)).toEqual(["你", "好。", "世", "界、", "再见"]);
  expect(lines("你（好）吗", 36)).toEqual(["你", "（好）", "吗"]);
  expect(lines("ちょっとコーヒー", 36)).toEqual(["ちょっ", "とコー", "ヒー"]);
  // Hangul measures by Noto Sans KR's advance, 920 units (ADR-0066).
  expect(lines("한국어문장", 24)).toEqual(["한국", "어문", "장"]);
});

it("keeps a punctuation-bound cluster together, overflowing only when it alone is wider", () => {
  expect(area("字「字」字", { width: 36, height: 100 }).lines.map((l) => l.text)).toEqual([
    "字",
    "「字」",
    "字",
  ]);
  expect(area("字「字」字", { width: 30, height: 100 })).toEqual({
    lines: [expect.objectContaining({ text: "字" })],
    overflow: "「字」字",
  });
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

it("has a glyph where a face in the fallback order has one, and a hard return always (ADR-0065)", () => {
  const t = { fontFamily: "Source Sans 3" };
  expect(["A", "小", "\n"].map((ch) => hasGlyph(t, ch))).toEqual([true, true, true]);
  expect(["😀", "ก", "ก"].map((ch) => hasGlyph(t, ch))).toEqual([false, false, false]);
});

it("places the first face's .notdef outline at an origin, y down, in the text's size (ADR-0065)", () => {
  // Source Sans 3 Regular's .notdef is a 89..565 by 0..660 box; Noto Sans SC's 100..900 by -120..880.
  const first = (fontFamily: string, fontStyle?: FontStyle) =>
    notdefBox({ fontFamily, fontStyle, fontSize: 12 }, 10, 50).slice(0, 3);
  expect(first("Source Sans 3")).toEqual([
    { cmd: "M", args: [10 + at12(89), 50] },
    { cmd: "L", args: [10 + at12(89), 50 - at12(660)] },
    { cmd: "L", args: [10 + at12(565), 50 - at12(660)] },
  ]);
  expect(first("Noto Sans SC")[0]).toEqual({ cmd: "M", args: [10 + at12(100), 50 + at12(120)] });
  expect(first("Source Sans 3", "Black Italic")[1]?.args[0]).toBeCloseTo(10 + at12(156), 9);
});
