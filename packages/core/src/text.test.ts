import { describe, expect, it } from "vitest";
import { edgesOf, frameSpans } from "./frame.ts";
import { lineBreakUnits } from "./line-break.ts";
import { NOTO_SANS_KR } from "./noto-sans-kr.ts";
import { NOTO_SANS_SC } from "./noto-sans-sc.ts";
import { parsePath, pathBounds } from "./path.ts";
import { SOURCE_SANS_3 } from "./source-sans-3.ts";
import {
  canonicalRanges,
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

it("warns for a style Kalamo does not bundle, naming the face it renders in", () => {
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

it("warns once for each text in a font Kalamo does not bundle", () => {
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

it("warns once for each missing face a text's ranges name (ADR-0068)", () => {
  const text = {
    id: "a",
    type: "text",
    fontFamily: "Source Sans 3",
    fontStyle: "Bold",
    ranges: [
      { start: 0, end: 1, fontStyle: "Semibold" },
      { start: 1, end: 2, fontStyle: "Regular" },
      { start: 2, end: 3, fontStyle: "Semibold", rotation: 5 },
    ],
  } as unknown as Parameters<typeof fontWarnings>[0][number];
  expect(fontWarnings([text])).toEqual([
    {
      code: "FONT_MISSING",
      nodeId: "a",
      message:
        "Source Sans 3 Semibold is not bundled, so it renders in Source Sans 3 Bold; the name is kept.",
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

it("overflows a word wider than a frame narrower than four line boxes, and everything after it, as Inkscape does", () => {
  const text = "Supercalifragilistic word  two   spaces";
  expect(area(text, { width: 50, height: 100 })).toEqual({ lines: [], overflow: text });
});

// Inkscape 1.2.2's lines for `probe.mjs`'s `break` cases (results.tsv): 20 pt Source Sans 3, whose
// H is 13.04 wide, in frames from (20, 40), each 300 tall (ADR-0084).
describe("a unit wider than its span (ADR-0084)", () => {
  const H = "HHH";
  const WIDE = `${H} ${H} ${"H".repeat(40)} ${H} ${H}`;
  const hs = (n: number) => "H".repeat(n);
  const rect = (
    width: number,
    content = WIDE,
    extra: Partial<Parameters<typeof layoutText>[0]> = {},
  ) => ({
    kind: "area" as const,
    x: 20,
    y: 40,
    width,
    height: 300,
    content,
    fontSize: 20,
    ...extra,
  });
  const shaped = (d: string, content: string, leading?: number) => {
    const b = pathBounds(parsePath(d, "d")) as NonNullable<ReturnType<typeof pathBounds>>;
    return { kind: "area" as const, ...b, frame: d, content, fontSize: 20, leading };
  };
  const texts = (t: Parameters<typeof layoutText>[0]) => layoutText(t).lines.map((l) => l.text);

  it("breaks it between characters, each piece the widest that fits, the words after it on the last", () => {
    for (const leading of [undefined, 30]) {
      const { lines, overflow } = layoutText(rect(180, WIDE, { leading }));
      expect(lines.map((l) => l.text)).toEqual([
        `${H} ${H} `,
        hs(13),
        hs(13),
        hs(13),
        `H ${H} ${H}`,
      ]);
      expect(lines.map((l) => +l.y.toFixed(2))).toEqual(
        leading ? [60.08, 90.08, 120.08, 150.08, 180.08] : [57.08, 81.08, 105.08, 129.08, 153.08],
      );
      expect(overflow).toBe("");
    }
  });

  it("keeps a broken unit's hard return on its last piece, the next paragraph on the line after", () => {
    expect(texts(rect(180, `${hs(20)}\nabc`))).toEqual([hs(13), `${hs(7)}\n`, "abc"]);
  });

  it("breaks it only in a span at least four line boxes wide, else overflows it", () => {
    // Four boxes are 96 at Auto and 120 at leading 30.
    expect(layoutText(rect(95))).toMatchObject({
      lines: [{ text: `${H} ${H} ` }],
      overflow: WIDE.slice(8),
    });
    expect(texts(rect(97))).toEqual([`${H} ${H} `, ...Array(5).fill(hs(7)), "HHHHH ", `${H} ${H}`]);
    expect(layoutText(rect(119, WIDE, { leading: 30 })).overflow).toBe(WIDE.slice(8));
    expect(texts(rect(121, WIDE, { leading: 30 }))).toEqual([
      `${H} ${H} `,
      ...Array(4).fill(hs(9)),
      `HHHH ${H} `,
      H,
    ]);
  });

  it("breaks it in a wide enough span though a band below fits it, and carries it down past a narrower one", () => {
    // A 15-H word, 195.6 wide, fits the 300-wide body below y 120, not the arm above it.
    const arm = (w: number) =>
      `M 20 40 L ${20 + w} 40 L ${20 + w} 120 L 320 120 L 320 340 L 20 340 Z`;
    const mid = `${hs(15)} ${H} ${H}`;
    expect(texts(shaped(arm(110), mid))).toEqual([hs(8), `${hs(7)} `, `${H} ${H}`]);
    expect(layoutText(shaped(arm(110), mid, 30)).lines).toEqual([
      expect.objectContaining({ text: mid, y: expect.closeTo(150.08, 2) }),
    ]);
    expect(texts(shaped(arm(90), mid))).toEqual([mid]);
    expect(texts(shaped(arm(120), mid, 30))).toEqual([hs(9), `${hs(6)} `, `${H} ${H}`]);
  });

  it("breaks it in each span of a shaped band, the first in the span after the band's other words", () => {
    const U = "M 20 40 L 140 40 L 140 120 L 200 120 L 200 40 L 320 40 L 320 340 L 20 340 Z";
    const lines = layoutText(shaped(U, WIDE)).lines;
    expect(lines.map((l) => [l.x, +l.y.toFixed(2), l.text])).toEqual([
      [20, 57.08, `${H} ${H} `],
      [200, 57.08, hs(9)],
      [20, 81.08, hs(9)],
      [200, 81.08, hs(9)],
      [20, 105.08, hs(9)],
      [200, 105.08, `HHHH ${H} `],
      [20, 129.08, H],
    ]);
    const triangle = "M 20 40 L 320 40 L 170 340 Z";
    expect(texts(shaped(triangle, WIDE))).toEqual([`${H} ${H} `, hs(19), hs(17), `HHHH ${H} ${H}`]);
  });

  it("measures a piece with the tracking between its characters, not after the last", () => {
    // 2 px of tracking: twelve tracked H's are 178.48, thirteen 193.52.
    expect(texts(rect(180, WIDE, { tracking: 100 }))).toEqual([
      `${H} ${H} `,
      hs(12),
      hs(12),
      hs(12),
      `HHHH ${H} ${H}`,
    ]);
  });

  it("breaks a CJK unit and a word in the CJK family the same way", () => {
    // 字 and eleven 」, which never break before, each 20 wide in Noto Sans SC.
    expect(texts(rect(180, `${H} 字${"」".repeat(11)} ${H}`))).toEqual([
      `${H} `,
      `字${"」".repeat(8)}`,
      `」」」 ${H}`,
    ]);
    expect(texts(rect(180, WIDE, { fontFamily: "Noto Sans SC" }))).toEqual([
      `${H} ${H} `,
      hs(12),
      hs(12),
      hs(12),
      `HHHH ${H} ${H}`,
    ]);
  });

  it("never breaks inside a grapheme cluster", () => {
    // 👍🏽 is one cluster of two code points, each a 13.06 .notdef: three fit 97, not three and a half.
    const thumbs = "👍🏽".repeat(8);
    const lines = texts(rect(97, thumbs));
    expect(lines).toEqual(["👍🏽👍🏽👍🏽", "👍🏽👍🏽👍🏽", "👍🏽👍🏽"]);
  });

  it("hides a unit of which not one cluster fits a span wide enough to break in", () => {
    // At leading 2 four line boxes are 8: a 10-wide span passes, but no H fits it.
    expect(layoutText(rect(10, "HHHHH", { leading: 2 }))).toEqual({ lines: [], overflow: "HHHHH" });
  });

  it("sizes a piece's line by its characters, and breaks no more once a larger rest outgrows the span", () => {
    // The word's last 20 H's are 40 pt, 26.08 wide each.
    const content = `${H} ${H} ${hs(40)} ${H} ${H}`;
    const ranges = [{ start: 28, end: 48, fontSize: 40 }];
    // At Auto the first piece's line is a 20 pt line; the rest's 48 pt box needs 192, and 180
    // overflows it, as Inkscape does.
    const auto = layoutText(rect(180, content, { ranges }));
    expect(auto.lines.map((l) => [+l.y.toFixed(2), l.text])).toEqual([
      [57.08, `${H} ${H} `],
      [81.08, hs(13)],
    ]);
    expect(auto.overflow).toBe(content.slice(21));
    // At leading 30 the 40 pt box is 35.09 tall, and 180 breaks it.
    expect(texts(rect(180, content, { ranges, leading: 30 }))).toEqual([
      `${H} ${H} `,
      hs(13),
      hs(10),
      hs(6),
      hs(6),
      `HHHHH ${H} `,
      H,
    ]);
  });

  it("warns TEXT_OVERFLOW only when the pieces run past the frame's bottom", () => {
    const node = (height: number) =>
      ({ id: "t", type: "text", ...rect(180), height }) as Parameters<
        typeof overflowWarnings
      >[0][number];
    expect(overflowWarnings([node(300)])).toEqual([]);
    expect(overflowWarnings([node(60)])).toEqual([
      expect.objectContaining({ code: "TEXT_OVERFLOW", nodeId: "t" }),
    ]);
  });
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
  expect(area(content, { width: 60, height: 84.95 }).lines).toHaveLength(5);
});

// Illustrator stacks by leading alone, whatever family a line draws in (ADR-0080), as Inkscape 1.2.2
// does once each fallback run's line-height shrinks its box inside Source Sans 3's.
it("stacks Area Type lines by leading alone, CJK in a fallback family included (ADR-0080)", () => {
  const baselines = (content: string, extra: Partial<Parameters<typeof layoutText>[0]> = {}) =>
    layoutText({
      kind: "area",
      x: 0,
      y: 20,
      width: 100,
      height: 200,
      content,
      fontSize: 12,
      ...extra,
    }).lines.map((l) => l.y - 20);
  const steps = (ys: number[]) => ys.slice(1).map((y, i) => y - (ys[i] as number));
  // The first baseline is ADR-0022's: (leading - size) / 2 + size · 1000 / 1326.
  const first = 1.2 + (12 * 1000) / 1326;
  const auto = baselines("Hi\n中文\nHi\n\n中文");
  expect(auto[0]).toBeCloseTo(first, 9);
  expect(steps(auto)).toEqual([14.4, 14.4, 14.4, 14.4].map((s) => expect.closeTo(s, 9)));
  expect(baselines("中文\nHi")[0]).toBeCloseTo(first, 9);
  const set = baselines("Hi\n中文\nHi", { leading: 20 });
  expect(set[0]).toBeCloseTo(4 + (12 * 1000) / 1326, 9);
  expect(steps(set)).toEqual([20, 20].map((s) => expect.closeTo(s, 9)));
  // A 24 pt range on the CJK line: that line's Auto leading is 28.8, the next line's 14.4.
  const larger = baselines("Hi\n中文\nHi", { ranges: [{ start: 3, end: 5, fontSize: 24 }] });
  expect(steps(larger)).toEqual([28.8, 14.4].map((s) => expect.closeTo(s, 9)));
  // Noto Sans KR stacks the same way (ADR-0066).
  expect(baselines("Hi\n한국\nHi\n\n한국")).toEqual(auto);
  // A line shows while 90% of its leading lies in the frame, as a Latin line does.
  for (const [content, height, shown] of [
    ["中文", 12.959, 0],
    ["中文", 12.96, 1],
    ["Hi\n中文", 27.359, 1],
    ["Hi\n中文", 27.36, 2],
    ["中文\nHi", 27.36, 2],
  ] as const) {
    expect(area(content, { width: 100, height }).lines).toHaveLength(shown);
  }
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

it("stores a range stroke parsed, the later range winning, and lays out without it (ADR-0068)", () => {
  expect(
    canonicalRanges(
      [
        { start: 0, end: 3, stroke: "#FF0000", fill: "#0000FF" },
        { start: 1, end: 2, stroke: "#00FF0080" },
      ],
      "ranges",
      {},
    ),
  ).toEqual([
    { start: 0, end: 1, fill: "#0000FF", stroke: "#FF0000" },
    { start: 1, end: 2, fill: "#0000FF", stroke: "#00FF0080" },
    { start: 2, end: 3, fill: "#0000FF", stroke: "#FF0000" },
  ]);
  expect(() => canonicalRanges([{ start: 0, end: 1, stroke: "red" }], "ranges", {})).toThrow(
    expect.objectContaining({ data: expect.objectContaining({ path: "ranges[0].stroke" }) }),
  );
  const hi = { x: 0, y: 0, content: "Hi", fontSize: 10 };
  const stroked = { ...hi, ranges: [{ start: 0, end: 2, stroke: "#FF0000" }] };
  expect(textBox(stroked)).toEqual(textBox(hi));
  expect(glyphs(stroked).map((g) => g.stroke)).toEqual(["#FF0000", "#FF0000"]);
});

it("stores a range's tracking unless it equals the Node's, the later range winning (ADR-0068)", () => {
  const ranges = [
    { start: 0, end: 4, tracking: 200 },
    { start: 1, end: 2, tracking: 50 },
    { start: 2, end: 3, tracking: 0 },
  ];
  expect(canonicalRanges(ranges, "ranges", { tracking: 50 })).toEqual([
    { start: 0, end: 1, tracking: 200 },
    { start: 2, end: 3, tracking: 0 },
    { start: 3, end: 4, tracking: 200 },
  ]);
  expect(canonicalRanges(ranges, "ranges", {})).toEqual([
    { start: 0, end: 1, tracking: 200 },
    { start: 1, end: 2, tracking: 50 },
    { start: 3, end: 4, tracking: 200 },
  ]);
});

it("tracks each character by its range's tracking, the last one's not counted (ADR-0068)", () => {
  // "Hi" at 12 pt: H tracks 500 / 1000 em = 6 pt, i's tracking is past the end.
  const hi = { x: 10, y: 50, content: "Hi", fontSize: 12, tracking: 100 };
  const tracked = { ...hi, ranges: [{ start: 0, end: 2, tracking: 500 }] };
  expect(textBox(tracked).width).toBeCloseTo(at12(652 + 246) + 6);
  expect(glyphs(tracked).map((g) => g.x)).toEqual([10, expect.closeTo(10 + at12(652) + 6, 9)]);
  // At 40 pt, "HH" is 52.16 wide; a range tracking of 500 on the first H adds 20.
  const hh = (width: number, ranges?: { start: number; end: number; tracking: number }[]) =>
    layoutText({
      kind: "area",
      x: 0,
      y: 0,
      width,
      height: 100,
      content: "HH HH",
      fontSize: 40,
      ranges,
    }).lines.map((l) => l.text);
  expect(hh(53)).toEqual(["HH ", "HH"]);
  expect(hh(53, [{ start: 0, end: 1, tracking: 500 }])).toEqual([]);
  expect(hh(75, [{ start: 3, end: 4, tracking: 500 }])).toEqual(["HH ", "HH"]);
  expect(hh(70, [{ start: 3, end: 4, tracking: 500 }])).toEqual(["HH "]);
});

it("measures a range's characters in its style's face, its style dropped if the Node's (ADR-0068)", () => {
  const { Regular, Bold } = SOURCE_SANS_3.faces;
  const H = "H".codePointAt(0) as unknown as keyof typeof Bold.advances;
  const hh = { x: 0, y: 0, content: "HH", fontSize: 12 };
  const bold = { ...hh, ranges: [{ start: 1, end: 2, fontStyle: "Bold" as const }] };
  expect(textBox(bold).width).toBeCloseTo(at12(Regular.advances[H] + Bold.advances[H]));
  expect(glyphs(bold).map((g) => g.width)).toEqual([
    expect.closeTo(at12(Regular.advances[H]), 9),
    expect.closeTo(at12(Bold.advances[H]), 9),
  ]);
  const ranges = [
    { start: 0, end: 2, fontStyle: "Bold" as const },
    { start: 1, end: 2, fontStyle: "Italic" as const },
  ];
  expect(canonicalRanges(ranges, "ranges", { fontStyle: "Bold" })).toEqual([
    { start: 1, end: 2, fontStyle: "Italic" },
  ]);
  expect(canonicalRanges(ranges, "ranges", {})).toEqual([
    { start: 0, end: 1, fontStyle: "Bold" },
    { start: 1, end: 2, fontStyle: "Italic" },
  ]);
});

it("draws a range's characters in its family's fallback order, its family kept as written (ADR-0068)", () => {
  const hi = { x: 0, y: 0, content: "Hi", fontSize: 1000 };
  const ranged = (fontFamily: string) => ({ ...hi, ranges: [{ start: 0, end: 2, fontFamily }] });
  // In Noto Sans SC's own Latin, as a text in it measures; an unbundled name in Source Sans 3.
  expect(textBox(ranged("Noto Sans SC")).width).toBeCloseTo(728 + 275);
  expect(textBox(ranged("Helvetica"))).toEqual(textBox(hi));
  expect(glyphs(ranged("Helvetica"))[0]).toMatchObject({ fontFamily: "Helvetica" });
  const text = (fontFamily: string) =>
    ({ id: "a", type: "text", fontFamily: "Source Sans 3", ...ranged(fontFamily) }) as never;
  expect(fontWarnings([text("Noto Sans SC")])).toEqual([]);
  expect(fontWarnings([text("Helvetica")]).map((w) => w.message)).toEqual([
    "Helvetica is not bundled, so it renders in Source Sans 3; the name is kept.",
  ]);
  expect(
    canonicalRanges(
      [
        { start: 0, end: 2, fontFamily: "Helvetica" },
        { start: 1, end: 2, fontFamily: "Noto Sans SC" },
      ],
      "ranges",
      { fontFamily: "Noto Sans SC" },
    ),
  ).toEqual([{ start: 0, end: 1, fontFamily: "Helvetica" }]);
});

it("stacks an Area Type line of a range's family as a line of the text's own (ADR-0068, ADR-0080)", () => {
  const frame = { kind: "area" as const, x: 0, y: 0, width: 200, height: 100, fontSize: 10 };
  const lines = (ranges?: { start: number; end: number; fontFamily: string }[]) =>
    layoutText({ ...frame, content: "ab\ncd\nef", ranges }).lines.map((l) => l.y);
  const latin = lines();
  expect(lines([{ start: 3, end: 4, fontFamily: "Noto Sans SC" }])).toEqual(latin);
});

it("measures a range's characters at its size, its tracking in their em (ADR-0068)", () => {
  const hi = { x: 0, y: 0, content: "Hi", fontSize: 12, tracking: 100 };
  const big = { ...hi, ranges: [{ start: 0, end: 1, fontSize: 24 }] };
  // H at 24 pt, and its tracking of 100 in its own em: 2.4.
  expect(glyphs(big).map((g) => [g.x, g.width])).toEqual([
    [0, expect.closeTo((652 * 24) / 1000, 9)],
    [expect.closeTo((652 * 24) / 1000 + 2.4, 9), expect.closeTo(at12(246), 9)],
  ]);
  const ranges = [
    { start: 0, end: 2, fontSize: 24 },
    { start: 1, end: 2, fontSize: 12 },
  ];
  expect(canonicalRanges(ranges, "ranges", { fontSize: 12 })).toEqual([
    { start: 0, end: 1, fontSize: 24 },
  ]);
});

// 12 pt Source Sans 3 with one 24 pt B, Auto or a 14.4 pt leading (ADR-0068).
const mixed = (content: string, leading?: number, kind?: "area") =>
  layoutText({
    ...(kind ? { kind, width: 300, height: 200 } : {}),
    x: 10,
    y: kind ? 40 : 50,
    content,
    fontSize: 12,
    leading,
    ranges: [{ start: content.indexOf("B"), end: content.indexOf("B") + 1, fontSize: 24 }],
  }).lines.map((l) => l.y);
const near = (ys: number[]) => ys.map((y) => expect.closeTo(y, 6));
/** Source Sans 3's ascent in its em box (ADR-0064). */
const A = 1000 / 1326;

it("puts a Point Type line holding a larger size 120% of it below the one before (ADR-0068)", () => {
  // Illustrator's Auto leading is a line's own: 28.8 for the line holding 24 pt, 14.4 for the rest.
  expect(mixed("HH\nHBH\nHH")).toEqual(near([50, 78.8, 93.2]));
  expect(mixed("HBH\nHH\nHH")).toEqual(near([50, 64.4, 78.8]));
  // An explicit leading stays fixed.
  expect(mixed("HH\nHBH\nHH", 14.4)).toEqual(near([50, 64.4, 78.8]));
  // A range size on a hard return sets its empty line's leading.
  const empty = layoutText({
    x: 0,
    y: 0,
    content: "H\n\nH",
    fontSize: 10,
    ranges: [{ start: 2, end: 3, fontSize: 20 }],
  });
  expect(empty.lines.map((l) => l.y)).toEqual(near([0, 24, 36]));
  // A text whose ranges set no size lays out as before, CJK one leading apart too.
  expect(
    layoutText({ x: 10, y: 50, content: "HH\nH你\nHH", fontSize: 12 }).lines.map((l) => l.y),
  ).toEqual(near([50, 64.4, 78.8]));
  // Its box grows to the 24 pt ascender.
  const box = textBox({
    x: 10,
    y: 50,
    content: "HB",
    fontSize: 12,
    ranges: [{ start: 1, end: 2, fontSize: 24 }],
  });
  expect(box.y).toBeCloseTo(50 - 24);
  expect(box.height).toBeCloseTo(24 + (326 * 24) / 1000);
});

it("stacks Area Type lines by each line's largest size, as Illustrator does (ADR-0068)", () => {
  // The first baseline is one line-box ascent below the top at that line's size (ADR-0022): half
  // of 1.2 × 24 − 24 above the ascent.
  const [a12, a24] = [1.2 + 12 * A, 2.4 + 24 * A];
  expect(mixed("HH\nHBH\nHH", undefined, "area")).toEqual(
    near([40 + a12, 40 + a12 + 28.8, 40 + a12 + 43.2]),
  );
  expect(mixed("HBH\nHH\nHH", undefined, "area")).toEqual(
    near([40 + a24, 40 + a24 + 14.4, 40 + a24 + 28.8]),
  );
  const a24at14 = -4.8 + 24 * A;
  expect(mixed("HH\nHBH\nHH", 14.4, "area")).toEqual(near([40 + a12, 54.4 + a12, 68.8 + a12]));
  expect(mixed("HBH\nHH\nHH", 14.4, "area")).toEqual(
    near([40 + a24at14, 54.4 + a24at14, 68.8 + a24at14]),
  );
  // Wrapping moves a larger word to the next line, and its leading with it: 20 pt × 1.2 = 24.
  const wrapped = layoutText({
    kind: "area",
    x: 0,
    y: 0,
    width: 100,
    height: 200,
    content: "Area Type with a LARGE word in the middle",
    fontSize: 11,
    ranges: [{ start: 17, end: 22, fontSize: 20 }],
  }).lines.map((l) => [l.text, l.y]);
  const a11 = 1.1 + 11 * A;
  expect(wrapped).toEqual([
    ["Area Type with a ", expect.closeTo(a11, 6)],
    ["LARGE word in ", expect.closeTo(a11 + 24, 6)],
    ["the middle", expect.closeTo(a11 + 37.2, 6)],
  ]);
});

it("shows an Area Type line holding a larger size while its band fits (ADR-0068, #203)", () => {
  const shown = (content: string, height: number, size = 24, leading?: number) =>
    layoutText({
      kind: "area",
      x: 0,
      y: 0,
      width: 300,
      height,
      content,
      fontSize: 12,
      leading,
      ranges: [{ start: content.indexOf("B"), end: content.indexOf("B") + 1, fontSize: size }],
    }).lines.length;
  const a12 = 1.2 + 12 * A;
  // The text's own 12 pt strut reaches 1.2 + 12 · (1 − A) below a baseline, Auto or 14.4.
  const strut = 1.2 + 12 * (1 - A);
  // A line shows while its band, its box reaching at least the strut's bottom less a tenth of
  // it, fits: with Auto, 90% of its leading below its top.
  const bandBottom = (baseline: number, size: number, leading = 1.2 * size) => {
    const half = (leading - size) / 2;
    const [ascent, descent] = [half + size * A, Math.max(half + size * (1 - A), strut)];
    return baseline + descent - 0.1 * (ascent + descent);
  };
  for (const [size, leading] of [[24], [14], [24, 14.4]] as [number, number?][]) {
    const h = bandBottom(a12 + (leading ?? 1.2 * size), size, leading);
    expect([
      shown("HH\nHBH", h + 0.01, size, leading),
      shown("HH\nHBH", h - 0.01, size, leading),
    ]).toEqual([2, 1]);
  }
  // With Auto the first line shows while 90% of its 28.8 box does. Under the 14.4 leading a 24 pt
  // box reaches 1.1 below its baseline and the strut 4.15, so the band ends 15.705 below the top,
  // not 12.96, as Inkscape 1.2.2 measures it (#203).
  expect([shown("HBH", 25.93), shown("HBH", 25.91)]).toEqual([1, 0]);
  expect([shown("HBH", 15.71, 24, 14.4), shown("HBH", 15.7, 24, 14.4)]).toEqual([1, 0]);
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
  expect(["😀", "ก", "ب"].map((ch) => hasGlyph(t, ch))).toEqual([false, false, false]);
  expect(hasGlyph(t, "한")).toBe(true);
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

describe("alignment (ADR-0077)", () => {
  /** A line's width as alignment measures it: without trailing spaces and the tracking after. */
  const inked = (t: Parameters<typeof glyphs>[0], line: number) => {
    const { lines } = layoutText(t);
    const l = lines[line] as (typeof lines)[number];
    const chars = [...l.text.replace(/\s+$/, "")];
    const g = glyphs(t).slice(glyphIndex(t, line), glyphIndex(t, line) + chars.length);
    const last = g.at(-1);
    return last ? last.x + last.width - l.x : 0;
  };
  const glyphIndex = (t: Parameters<typeof glyphs>[0], line: number) =>
    layoutText(t)
      .lines.slice(0, line)
      .reduce((n, l) => n + [...l.text].length, 0);
  const point = { x: 100, y: 50, content: "Hi\nHHH \ni", fontSize: 12, tracking: 50 };

  it("aligns each Point Type line about x by its width, trailing spaces and tracking left out", () => {
    const left = layoutText(point).lines;
    const center = layoutText({ ...point, alignment: "center" }).lines;
    const right = layoutText({ ...point, alignment: "right" }).lines;
    left.forEach((l, i) => {
      const w = inked(point, i);
      expect(center[i]?.x).toBeCloseTo(100 - w / 2, 9);
      expect(right[i]?.x).toBeCloseTo(100 - w, 9);
      expect([center[i]?.y, right[i]?.y]).toEqual([l.y, l.y]);
    });
    expect(layoutText({ ...point, alignment: "justify" })).toEqual(layoutText(point));
  });

  it("bounds aligned Point Type by the union of its shifted lines", () => {
    const box = textBox({ ...point, alignment: "right" });
    const lines = layoutText({ ...point, alignment: "right" }).lines;
    expect(box.x).toBeCloseTo(Math.min(...lines.map((l) => l.x)), 9);
    // The widest ink ends at x; the second line's trailing space hangs past it.
    expect(box.x + box.width).toBeGreaterThan(100);
    expect(textBox({ ...point, alignment: "justify" })).toEqual(textBox(point));
    const center = textBox({ ...point, content: "HH", alignment: "center" });
    expect(center.x + center.width / 2).toBeCloseTo(100, 9);
  });

  const frame = { kind: "area" as const, x: 20, y: 20, width: 150, height: 200, fontSize: 12 };
  const prose =
    "The quick brown fox jumps over the lazy dog and keeps running far away.\nA second paragraph of several words, then a long one that wraps. End\nsupercalifragilistic\n";

  it("aligns each Area Type line in the frame by its width without trailing spaces", () => {
    const t = { ...frame, content: prose };
    const left = layoutText(t);
    for (const alignment of ["center", "right"] as const) {
      const out = layoutText({ ...t, alignment });
      expect(out.overflow).toBe(left.overflow);
      expect(out.lines.map((l) => [l.text, l.y])).toEqual(left.lines.map((l) => [l.text, l.y]));
      out.lines.forEach((l, i) => {
        const w = inked(t, i);
        expect(l.x).toBeCloseTo(alignment === "center" ? 20 + (150 - w) / 2 : 170 - w, 9);
      });
    }
  });

  it("justifies each line but a paragraph's last to the frame's width, on word spaces only", () => {
    const t = { ...frame, content: prose, alignment: "justify" as const };
    const { lines, overflow } = layoutText(t);
    const plain = layoutText({ ...t, alignment: undefined });
    expect([lines.map((l) => l.text), overflow]).toEqual([
      plain.lines.map((l) => l.text),
      plain.overflow,
    ]);
    const g = glyphs(t);
    const ends = lines.map((l, i) => {
      const chars = [...l.text.replace(/\s+$/, "")];
      const at = glyphIndex(t, i);
      const last = g[at + chars.length - 1] as (typeof g)[number];
      return last.x + last.width;
    });
    lines.forEach((l, i) => {
      const final = l.text.endsWith("\n") || i === lines.length - 1;
      const oneWord = !l.text.trim().includes(" ");
      if (final || oneWord) {
        expect(l.wordSpacing).toBeUndefined();
        expect(ends[i]).toBeCloseTo(20 + inked(t, i), 9);
      } else expect(Math.abs((ends[i] as number) - 170)).toBeLessThan(1e-6);
    });
    // Only the spaces widen: a word's characters keep their spacing.
    const plainGlyphs = glyphs({ ...t, alignment: undefined });
    const first = [...(lines[0] as { text: string }).text];
    let shift = 0;
    first.forEach((ch, k) => {
      expect((g[k] as { x: number }).x - (plainGlyphs[k] as { x: number }).x).toBeCloseTo(shift, 9);
      if (ch === " " && k < first.length - 1) shift += lines[0]?.wordSpacing ?? 0;
    });
    // The first line widens, the paragraph ending at \n and the one-word line do not.
    expect(lines[0]?.wordSpacing).toBeGreaterThan(0);
    expect(lines.some((l) => l.text === "supercalifragilistic\n" && !l.wordSpacing)).toBe(true);
  });

  it("leaves a soft-wrapped one-word line of a paragraph left, the lines around it justified", () => {
    const t = {
      ...frame,
      width: 70,
      content: "Lorem ipsum consectetur sit amet dolor",
      alignment: "justify" as const,
    };
    const { lines } = layoutText(t);
    const i = lines.findIndex((l) => l.text === "consectetur ");
    // Neither the paragraph's last line nor one ending at a return: only its one word keeps it left.
    expect(i).toBeGreaterThan(0);
    expect(i).toBeLessThan(lines.length - 1);
    expect(lines[i]?.wordSpacing).toBeUndefined();
    expect(lines[i]?.x).toBe(20);
    expect(lines[0]?.wordSpacing).toBeGreaterThan(0);
  });

  it("gives a centred text's characters their line's offset, rotated cells inside the box", () => {
    const t = {
      ...point,
      content: "Hello\nHi",
      alignment: "center" as const,
      ranges: [{ start: 6, end: 7, rotation: 90, baselineShift: 3 }],
    };
    const shifted = glyphs(t);
    const plain = glyphs({ ...t, alignment: undefined });
    const lines = layoutText(t).lines;
    shifted.forEach((g, k) => {
      // Point Type lays out no glyph for the hard return: the second line starts at glyph 5.
      const line = k < 5 ? 0 : 1;
      expect(g.x - (plain[k] as { x: number }).x).toBeCloseTo((lines[line]?.x ?? 0) - 100, 9);
    });
    const box = textBox(t);
    const h = shifted[5] as (typeof shifted)[number];
    // Turned 90° clockwise about its origin, the raised H's ascender points right: its cell reaches
    // 12 + 3 pt right of the origin and one advance below it, and the box holds it.
    expect(box.x + box.width).toBeGreaterThanOrEqual(h.x + 15 - 1e-9);
    expect(box.y + box.height).toBeGreaterThanOrEqual(h.y + h.width - 1e-9);
  });
});

describe("Area Type in a closed path (ADR-0078)", () => {
  /** The band around a 12 pt line's baseline at line-height 1.2, as ADR-0078 measured it. */
  const [BAND_ABOVE, BAND_BELOW] = [8.8098, 2.7102];
  /** Area Type in the frame `d`, its bounds derived as core stores them. */
  const inFrame = (d: string, content: string, fontSize = 12) => {
    const b = pathBounds(parsePath(d, "d")) as NonNullable<ReturnType<typeof pathBounds>>;
    return { kind: "area" as const, ...b, frame: d, content, fontSize };
  };
  const rows = (t: ReturnType<typeof inFrame>) =>
    layoutText(t).lines.map((l) => [
      Math.round(l.x * 1000) / 1000,
      Math.round(l.y * 1e4) / 1e4,
      l.text,
    ]);

  it("bands each line by its line box less a tenth of the leading, as Inkscape 1.2.2 measures", () => {
    // Left edges slanting right and left: a line starts where the edge is at its band's bottom
    // (x = bottom / 2) or top (x = 200 − top / 2). Inkscape: 6.48 and 199.28 at baseline 10.2498.
    const words = Array(40).fill("iii").join(" ");
    const [right] = layoutText(inFrame("M 0 0 L 700 0 L 700 400 L 200 400 Z", words)).lines;
    const [left] = layoutText(inFrame("M 200 0 L 700 0 L 700 400 L 0 400 Z", words)).lines;
    expect(right?.y).toBeCloseTo(10.2498, 4);
    expect(right?.x).toBeCloseTo(6.48, 6);
    expect(left?.x).toBeCloseTo(199.28, 6);
  });

  it("skips a band whose spans fit no word, one leading down, as Inkscape does", () => {
    // A 5 pt wide notch above y 33.3: Inkscape's first line is at 53.4498, the fourth band.
    const words = Array(60).fill("iii").join(" ");
    const [first] = layoutText(
      inFrame("M 0 0 L 5 0 L 5 33.3 L 300 33.3 L 300 200 L 0 200 Z", words),
    ).lines;
    expect(first).toMatchObject({ x: 0 });
    expect(first?.y).toBeCloseTo(53.4498, 4);
  });

  const prose =
    "The quick brown fox jumps over the lazy dog, and keeps running far away into the woods where nobody can see it any more. A second sentence follows with more words to fill the frame.";

  it("fills both spans of a concave frame's band, left to right, each its own line", () => {
    // Inkscape 1.2.2 draws these words on these bands, the right span from x 200 (measured glyph by
    // glyph); a hard return on a one-span band starts the next band.
    const U = "M 0 0 L 100 0 L 100 60 L 200 60 L 200 0 L 300 0 L 300 120 L 0 120 Z";
    expect(rows(inFrame(U, `${prose}\nNew paragraph here.`))).toEqual([
      [0, 10.2498, "The quick brown "],
      [200, 10.2498, "fox jumps over the "],
      [0, 24.6498, "lazy dog, and keeps "],
      [200, 24.6498, "running far away "],
      [0, 39.0498, "into the woods "],
      [200, 39.0498, "where nobody can "],
      [0, 53.4498, "see it any more. A "],
      [200, 53.4498, "second sentence "],
      [0, 67.8498, "follows with more "],
      [200, 67.8498, "words to fill the "],
      [0, 82.2498, "frame.\n"],
      [0, 96.6498, "New paragraph here."],
    ]);
    // Each arm band has the two 100 pt spans Inkscape filled; below the arms, one 300 pt span.
    const spans = (y: number) => frameSpans(edgesOf(U), y - BAND_ABOVE, y + BAND_BELOW);
    for (const y of [10.2498, 24.6498, 39.0498, 53.4498, 67.8498]) {
      expect(spans(y)).toEqual([
        { x: 0, width: 100 },
        { x: 200, width: 100 },
      ]);
    }
    expect(spans(82.2498)).toEqual([{ x: 0, width: 300 }]);
  });

  it("starts the next paragraph in the next span of the same band", () => {
    const U = "M 0 0 L 100 0 L 100 60 L 200 60 L 200 0 L 300 0 L 300 120 L 0 120 Z";
    const lines = layoutText(inFrame(U, "Left words\nRight words", 9)).lines;
    expect(lines.map((l) => [l.x, l.text])).toEqual([
      [0, "Left words\n"],
      [200, "Right words"],
    ]);
    expect(lines[1]?.y).toBe(lines[0]?.y);
  });

  it("wraps in a circle as Inkscape 1.2.2 does, each line's start within its curve flattening", () => {
    const circle =
      "M 120 20 C 175.228 20 220 64.772 220 120 C 220 175.228 175.228 220 120 220 C 64.772 220 20 175.228 20 120 C 20 64.772 64.772 20 120 20 Z";
    // Inkscape's saved line starts, and each line's text. Its coarser flattening of the curves puts
    // a start up to 0.56 pt inside Kalamo's, near the top where the circle is flattest.
    const inkscape: [number, number, string][] = [
      [103.719, 30.2498, "The "],
      [66.128, 44.6498, "quick brown fox "],
      [48.425, 59.0498, "jumps over the lazy dog, and "],
      [36.744, 73.4498, "keeps running far away into the "],
      [28.84, 87.8498, "woods where nobody can see it any "],
      [23.679, 102.2498, "more. A second sentence follows with "],
      [20.811, 116.6498, "more words to fill the frame."],
    ];
    const got = rows(inFrame(circle, prose));
    expect(got.map(([, y, t]) => [y, t])).toEqual(inkscape.map(([, y, t]) => [y, t]));
    got.forEach(([x], i) => {
      expect(Math.abs((x as number) - (inkscape[i]?.[0] as number))).toBeLessThan(0.6);
    });
    // Each band's one span is centred on the circle, so Inkscape's start gives its width.
    for (const [x, y] of inkscape) {
      const [span, ...more] = frameSpans(edgesOf(circle), y - BAND_ABOVE, y + BAND_BELOW);
      expect(more).toEqual([]);
      expect(Math.abs((span?.width as number) - (240 - 2 * x))).toBeLessThan(1.2);
    }
  });

  it("overflows what fits no band above the frame's bottom, and warns", () => {
    const t = inFrame("M 0 0 L 60 0 L 60 30 L 0 30 Z", prose);
    const { lines, overflow } = layoutText(t);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.map((l) => l.text).join("") + overflow).toBe(prose);
    expect(overflow.length).toBeGreaterThan(0);
  });

  describe("each band sized by its own line (#200)", () => {
    // The frames and texts of docs/research/09-shaped-bands/probe.mjs, whose Inkscape 1.2.2
    // numbers are quoted: 20 pt Source Sans 3, words of H's, some at 40 pt or in Noto Sans SC.
    const SLANT = "M 20 40 L 200 40 L 200 340 L 120 340 Z";
    const U = "M 20 40 L 140 40 L 140 120 L 200 120 L 200 40 L 320 40 L 320 340 L 20 340 Z";
    const NECK = "M 20 40 L 50 40 L 50 100 L 320 100 L 320 340 L 20 340 Z";
    type Word = string | { w: string; size: number };
    const H = "HHH";
    const big = (w = H) => ({ w, size: 40 });
    /** Paragraphs of words as a text in `frame`, each sized word a Character Range. */
    const mixed = (frame: string, paragraphs: Word[][], leading?: number) => {
      let content = "";
      const ranges: { start: number; end: number; fontSize: number }[] = [];
      paragraphs.forEach((words, p) => {
        words.forEach((w, i) => {
          if (i || p) content += i ? " " : "\n";
          const start = [...content].length;
          if (typeof w !== "string")
            ranges.push({ start, end: start + [...w.w].length, fontSize: w.size });
          content += typeof w === "string" ? w : w.w;
        });
      });
      return { ...inFrame(frame, content, 20), leading, ranges };
    };
    const lines = (t: ReturnType<typeof mixed>) =>
      layoutText(t).lines.map((l) => [
        Math.round(l.x * 100) / 100,
        Math.round(l.y * 100) / 100,
        l.text,
      ]);

    it("steps a line holding a larger Character Range by its own leading, under Auto and a set one", () => {
      // The 40 pt word ends the first line's band and takes the next: Inkscape draws both
      // baselines, 74.17 and 122.17, and the second line from 50.4.
      const words = [H, H, H, big(), ...Array(8).fill(H)];
      const auto = layoutText(mixed(SLANT, [words])).lines;
      expect(auto.slice(0, 2).map((l) => [+l.x.toFixed(2), +l.y.toFixed(2)])).toEqual([
        [34.4, 74.17],
        [50.4, 122.17],
      ]);
      expect((auto[1]?.y as number) - (auto[0]?.y as number)).toBeCloseTo(48, 9);
      // Its em box's top clears the line above's em box: one size's band would overlap it.
      const ascent = 1000 / 1326;
      expect((auto[1]?.y as number) - 40 * ascent).toBeGreaterThan(
        (auto[0]?.y as number) + 20 * (1 - ascent),
      );
      // And the next line one 24 pt leading below it.
      expect((auto[2]?.y as number) - (auto[1]?.y as number)).toBeCloseTo(24, 9);
      const set = layoutText(mixed(SLANT, [words], 30)).lines;
      expect(set.slice(0, 3).map((l) => +l.y.toFixed(2))).toEqual([65.17, 95.17, 125.17]);
      // Under either leading the first band's box, sized by the 40 pt word it tried, runs one
      // leading down from the frame's top at 40, and the 40 pt line's box, half its leading above
      // and below its em box, starts where it ends: they do not overlap. With one size's bands, at
      // 30 the 40 pt box reached 5.08 into the 20 pt box above.
      for (const [lines, leading] of [
        [auto, 48],
        [set, 30],
      ] as const) {
        const top = (lines[1]?.y as number) - (leading - 40) / 2 - 40 * ascent;
        expect(top).toBeCloseTo(40 + leading, 9);
      }
    });

    it("keeps ADR-0080's step for a CJK line, as a rectangle frame does, beside a larger range", () => {
      const cjk = [H, "字", H, H, H, "字", H, H, H, H, "字", H];
      // Inkscape draws both arms' lines on these baselines, the Node's leading apart.
      expect([...new Set(layoutText(mixed(U, [cjk])).lines.map((l) => +l.y.toFixed(2)))]).toEqual([
        57.08, 81.08, 105.08,
      ]);
      expect([
        ...new Set(layoutText(mixed(U, [cjk], 30)).lines.map((l) => +l.y.toFixed(2))),
      ]).toEqual([60.08, 90.08, 120.08]);
      // A 30 pt CJK run on the first band: Inkscape 65.62, 89.62, 113.62.
      const larger = mixed(U, [[H, "字", H, H, H, { w: "字", size: 30 }, H, H, H, H, "字", H]]);
      expect([...new Set(layoutText(larger).lines.map((l) => +l.y.toFixed(2)))]).toEqual([
        65.62, 89.62, 113.62,
      ]);
      // On the slanted frame each band has one line; a rectangle frame holding the same lines,
      // each ended by a hard return in place of its last space, stacks them the same.
      for (const leading of [undefined, 30]) {
        const t = mixed(SLANT, [larger.content.split(" ")], leading);
        const shapedLines = layoutText({ ...t, ranges: larger.ranges }).lines;
        const rect = layoutText({
          ...t,
          frame: undefined,
          width: 1000,
          ranges: larger.ranges,
          content: shapedLines.map((l) => l.text.replace(/ $/, "\n")).join(""),
        }).lines;
        expect(rect.map((l) => l.y)).toEqual(shapedLines.map((l) => l.y));
      }
    });

    it("sizes a band by every word it tries, so a larger word it cannot fit narrows it", () => {
      // Four 20 pt words fit the first band; the 40 pt fifth does not, but sizes the band, whose
      // deeper bottom leaves room for three. Inkscape: three words from 34.4 at 74.17, then the
      // fourth and the 40 pt word from 50.4 at 122.17.
      expect(lines(mixed(SLANT, [Array(13).fill(H)]))[0]).toEqual([
        27.2,
        57.08,
        "HHH HHH HHH HHH ",
      ]);
      expect(lines(mixed(SLANT, [[H, H, H, H, big(), ...Array(8).fill(H)]])).slice(0, 2)).toEqual([
        [34.4, 74.17, "HHH HHH HHH "],
        [50.4, 122.17, "HHH HHH "],
      ]);
      // In a triangle, the taller band's span starts where the edge is at its deeper bottom:
      // Inkscape draws five words from 41.6 at 74.17, where six 20 pt words fill from 30.8.
      const TRIANGLE = "M 20 40 L 320 40 L 170 340 Z";
      expect(lines(mixed(TRIANGLE, [Array(14).fill(H)]))[0]).toEqual([
        30.8,
        57.08,
        "HHH HHH HHH HHH HHH HHH ",
      ]);
      expect(lines(mixed(TRIANGLE, [[H, H, H, H, big(), ...Array(9).fill(H)]]))[0]).toEqual([
        41.6,
        74.17,
        "HHH HHH HHH HHH HHH ",
      ]);
      // Under a set leading the band holds the text's own strut, which reaches below a 40 pt
      // box: Inkscape starts that line at 30.52 too.
      expect(lines(mixed(SLANT, [[H, H, big(), ...Array(9).fill(H)]], 30))[0]).toEqual([
        30.52,
        65.17,
        "HHH HHH HHH ",
      ]);
    });

    it("skips bands too narrow for a tall line one of its leadings apart, and overflows by them", () => {
      // A 30 pt neck above y 100: the 40 pt heading's bands at 74.17 and 122.17 are too narrow,
      // and it shows at 170.17, as Inkscape draws it; the 20 pt lines follow a leading apart.
      const heading = [[big(), big("HH")], Array(12).fill(H)];
      expect(lines(mixed(NECK, heading)).slice(0, 2)).toEqual([
        [20, 170.17, "HHH HH\n"],
        [20, 194.17, "HHH HHH HHH HHH HHH HHH HHH "],
      ]);
      // Cut at y 140, the neck frame shows the text at one size, from its band at 129.08, but no
      // band of the heading's starts above the bottom.
      const cut = "M 20 40 L 50 40 L 50 100 L 320 100 L 320 140 L 20 140 Z";
      const one = layoutText({ ...mixed(cut, heading), ranges: [] });
      expect(one.lines[0]?.y).toBeCloseTo(129.08, 2);
      const t = mixed(cut, heading);
      expect(layoutText(t)).toEqual({ lines: [], overflow: t.content });
      const node = { id: "t", type: "text", ...t } as Parameters<
        typeof overflowWarnings
      >[0][number];
      expect(overflowWarnings([node])).toEqual([
        expect.objectContaining({ code: "TEXT_OVERFLOW", nodeId: "t" }),
      ]);
    });
  });

  it("aligns each line in its own span", () => {
    const U = "M 0 0 L 100 0 L 100 60 L 200 60 L 200 0 L 300 0 L 300 120 L 0 120 Z";
    const lines = layoutText({ ...inFrame(U, "a b"), alignment: "right" }).lines;
    const g = glyphs({ ...inFrame(U, "a b"), alignment: "right" });
    const last = g.at(-1) as { x: number; width: number };
    expect(lines).toHaveLength(1);
    expect(last.x + last.width).toBeCloseTo(100, 9);
  });
});
