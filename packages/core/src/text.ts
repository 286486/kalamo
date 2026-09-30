import { parseColor } from "./color.ts";
import { edgesOf, frameSpans, type Span } from "./frame.ts";
import { lineBreakUnits } from "./line-break.ts";
import { NOTO_SANS_KR } from "./noto-sans-kr.ts";
import { NOTO_SANS_SC } from "./noto-sans-sc.ts";
import { formatNumber, parsePath, round3, type Segment } from "./path.ts";
import type { Alignment, CharacterRange, Node, Rect, Warning } from "./schema.ts";
import { SOURCE_SANS_3 } from "./source-sans-3.ts";

/** Illustrator's weight names and their CSS `font-weight` (ADR-0028). */
export const FONT_WEIGHTS = {
  Thin: 100,
  ExtraLight: 200,
  Light: 300,
  Regular: 400,
  Medium: 500,
  Semibold: 600,
  Bold: 700,
  ExtraBold: 800,
  Black: 900,
} as const;
type WeightName = keyof typeof FONT_WEIGHTS;
/** A style name: a weight name, optionally followed by " Italic"; "Italic" alone is Regular Italic. */
export type FontStyle = WeightName | "Italic" | `${Exclude<WeightName, "Regular">} Italic`;
type BundledStyle = keyof typeof SOURCE_SANS_3.faces;
type NotoStyle = keyof typeof NOTO_SANS_SC.faces;

const italicOf = (name: WeightName): FontStyle =>
  name === "Regular" ? "Italic" : `${name} Italic`;
export const FONT_STYLES = (Object.keys(FONT_WEIGHTS) as WeightName[]).flatMap((w) => [
  w,
  italicOf(w),
]) as [FontStyle, ...FontStyle[]];

/** A style's CSS weight and italic. A text stored before ADR-0028 has no style and is Regular. */
export function fontFace(style: FontStyle = "Regular") {
  const italic = style.endsWith("Italic");
  const name = (style.replace(/ ?Italic$/, "") || "Regular") as WeightName;
  return { weight: FONT_WEIGHTS[name], italic };
}

/** The style name of a CSS weight, one of 100 to 900, and italic. */
export function fontStyleName(weight: number, italic: boolean): FontStyle {
  const name = (Object.keys(FONT_WEIGHTS) as WeightName[]).find((w) => FONT_WEIGHTS[w] === weight);
  if (!name) throw new Error(`No weight name for ${weight}.`);
  return italic ? italicOf(name) : name;
}

/** The bundled face a style draws in, by CSS font matching as resvg and browsers do (ADR-0028). */
export function bundledStyle(style?: FontStyle): BundledStyle {
  const { weight, italic } = fontFace(style);
  // ponytail: CSS matching over the bundled weights 400, 700 and 900 only; generalise it when a face
  // of another weight ships.
  return fontStyleName(weight <= 500 ? 400 : weight <= 700 ? 700 : 900, italic) as BundledStyle;
}

/**
 * A face's advance by code point in font units, undefined where it has no glyph, and its `.notdef`'s
 * advance and outline, y up.
 */
type Face = {
  advance: (codePoint: number) => number | undefined;
  notdef: number;
  notdefOutline: Segment[];
};

/** The advance of `codePoint` in sorted runs of `[first, count, advance]`, by binary search. */
function runAdvance(runs: [number, number, number][], codePoint: number) {
  let [lo, hi] = [0, runs.length - 1];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [first, count, advance] = runs[mid] as [number, number, number];
    if (codePoint < first) hi = mid - 1;
    else if (codePoint >= first + count) lo = mid + 1;
    else return advance;
  }
}

const sourceSans3 = Object.fromEntries(
  Object.entries(SOURCE_SANS_3.faces).map(([style, f]) => {
    const advances: Record<number, number> = f.advances;
    return [
      style,
      {
        advance: (c: number) => advances[c],
        notdef: f.notdef,
        notdefOutline: parsePath(f.notdefPath, "notdefPath"),
      },
    ];
  }),
) as Record<BundledStyle, Face>;
/** A Noto family's faces, their advances looked up in its runs. */
const notoFaces = (table: typeof NOTO_SANS_SC) =>
  Object.fromEntries(
    Object.entries(table.faces).map(([style, f]) => [
      style,
      {
        advance: (c: number) => runAdvance(f.runs, c),
        notdef: f.notdef,
        notdefOutline: parsePath(f.notdefPath, "notdefPath"),
      },
    ]),
  ) as Record<NotoStyle, Face>;
/** Noto's Regular and Bold by CSS matching: weights to 500 draw in Regular, heavier in Bold. */
const notoFace = (style?: FontStyle): NotoStyle =>
  fontFace(style).weight <= 500 ? "Regular" : "Bold";

/** A family's ascender as a share of its em box: ascender to descender scaled to one em, as Inkscape. */
const emAscent = ({ ascender, descender }: { ascender: number; descender: number }) =>
  ascender / (ascender - descender);

/**
 * The bundled families in fallback order after a text's own (ADR-0063, ADR-0066), each with the
 * style names of its faces, the face a style draws in by CSS matching (ADR-0028), and the scripts it
 * draws. The Noto families have Regular and Bold only, and no italic, so an italic draws upright.
 */
const FAMILIES = {
  "Source Sans 3": {
    face: (style?: FontStyle) => bundledStyle(style),
    faces: sourceSans3,
    ascent: emAscent(SOURCE_SANS_3),
    draws: "Latin, Greek, and Cyrillic",
  },
  "Noto Sans SC": {
    face: notoFace,
    faces: notoFaces(NOTO_SANS_SC),
    ascent: emAscent(NOTO_SANS_SC),
    draws: "Chinese and Japanese",
  },
  "Noto Sans KR": {
    face: notoFace,
    faces: notoFaces(NOTO_SANS_KR),
    ascent: emAscent(NOTO_SANS_KR),
    draws: "Korean",
  },
} as const;
export type BundledFamily = keyof typeof FAMILIES;
/** The bundled families, the one list of them (ADR-0066). */
export const BUNDLED_FAMILIES = Object.keys(FAMILIES) as [BundledFamily, ...BundledFamily[]];

/** The one family every family Kalamo lacks renders in (ADR-0013). */
export const BUNDLED_FONT = "Source Sans 3";

const list = (items: string[], type: "conjunction" | "disjunction") =>
  new Intl.ListFormat("en", { style: "long", type }).format(items);
/** The bundled families and what each draws, for tool and schema descriptions. */
export const BUNDLED_FAMILIES_NOTE = `${list(
  BUNDLED_FAMILIES.map((f) => `${f} (${FAMILIES[f].draws})`),
  "conjunction",
)} are bundled; each character draws in the text's own family if bundled and it has the glyph, else in the first of them that has it`;

/** What picks a text's faces: its family, Source Sans 3 if none, and style. */
export type TextFont = { fontFamily?: string | undefined; fontStyle?: FontStyle | undefined };

const isBundled = (family: string): family is BundledFamily => Object.hasOwn(FAMILIES, family);

/**
 * The bundled families a text draws in, in fallback order (ADR-0063): its own family if bundled,
 * else Source Sans 3, then the other bundled families. Each character draws in the first that has
 * its glyph, as a browser's font fallback picks, and else as the first's `.notdef`.
 */
export function fontFamilies(text: TextFont): [BundledFamily, ...BundledFamily[]] {
  const { fontFamily = BUNDLED_FONT } = text;
  const own = isBundled(fontFamily) ? fontFamily : BUNDLED_FONT;
  return [own, ...BUNDLED_FAMILIES.filter((f) => f !== own)];
}

type DrawnFace = { family: BundledFamily; face: Face };

/** A text's faces in fallback order, each with its family. */
const facesOf = (text: TextFont) =>
  fontFamilies(text).map((family) => {
    const { face, faces } = FAMILIES[family];
    return { family, face: (faces as Record<string, Face>)[face(text.fontStyle)] as Face };
  }) as [DrawnFace, ...DrawnFace[]];

/** The face a character draws in: the first in fallback order that has it, else the first's `.notdef`. */
function faceFor(faces: [DrawnFace, ...DrawnFace[]], char: string) {
  const c = char.codePointAt(0) as number;
  return faces.find((f) => f.face.advance(c) !== undefined) ?? faces[0];
}

/** Whether a face a text draws in has a character's glyph; a hard return needs none (ADR-0062, ADR-0065). */
export function hasGlyph(text: TextFont, char: string): boolean {
  const c = char.codePointAt(0) as number;
  return char === "\n" || facesOf(text).some((f) => f.face.advance(c) !== undefined);
}

/**
 * The `.notdef` box a character no bundled face has draws as, from its origin `x, y` on the
 * baseline: the outline of the first face in the text's fallback order, as resvg draws it
 * (ADR-0063, ADR-0065).
 */
export function notdefBox(text: TextFont & { fontSize: number }, x: number, y: number): Segment[] {
  const s = text.fontSize / SOURCE_SANS_3.unitsPerEm;
  return facesOf(text)[0].face.notdefOutline.map(({ cmd, args }) => ({
    cmd,
    args: args.map((v, i) => (i % 2 ? y - v * s : x + v * s)),
  }));
}

/** The bundled family a character of a text draws in (ADR-0063). */
export const drawnFamily = (text: TextFont, char: string): BundledFamily =>
  faceFor(facesOf(text), char).family;

/**
 * The `line-height` a run of a text drawn in `family` at `size` takes in SVG, so that Inkscape 1.2.2,
 * which stacks lines as CSS inline boxes, stacks its line by leading alone (ADR-0080): the run's box
 * shrunk by twice what its family's em-box ascent differs from the text's first family's, so it lies
 * inside the box a first-family run of its size and leading has. Rounded down, since a box a
 * thousandth taller needs its whole leading in the frame. Undefined for the first family's box.
 * ponytail: a set leading under twice the difference, about a quarter of the run's size for CJK in
 * Source Sans 3, floors at 0, since CSS has no negative line-height; its box then rises above the
 * strut and Inkscape lowers that line (ADR-0080). Kalamo's own layout is unaffected.
 */
export function runLineHeight(
  text: TextFont & { leading?: number },
  family: BundledFamily,
  size: number,
): string | undefined {
  const shrink = 2 * Math.abs(FAMILIES[family].ascent - FAMILIES[fontFamilies(text)[0]].ascent);
  if (!shrink) return undefined;
  const floor = (v: number) => formatNumber(Math.max(0, Math.floor(v * 1000) / 1000));
  return text.leading === undefined
    ? floor(1.2 - shrink)
    : `${floor(text.leading - shrink * size)}px`;
}

type Overrides = Omit<CharacterRange, "start" | "end">;
/** A Character Range as written, its colours not parsed yet. */
type RangeInput = Omit<CharacterRange, "fill" | "stroke"> & { fill?: unknown; stroke?: unknown };
/** The overrides a range can hold, which runs must all share to merge. */
const OVERRIDES = [
  "fill",
  "stroke",
  "baselineShift",
  "rotation",
  "tracking",
  "fontStyle",
  "fontFamily",
  "fontSize",
] as const;
/** A text's own character attributes, the values a range override is none at (ADR-0068). */
export type OwnAttributes = TextFont & {
  fontSize?: number | undefined;
  tracking?: number | undefined;
};

/**
 * Character Ranges in canonical form (ADR-0029, ADR-0068): colours parsed, a later range winning
 * attribute by attribute, a shift or rotation of 0 and a value equal to `text`'s own clearing, then
 * sorted runs that do not overlap, adjacent equal runs merged and runs without overrides dropped.
 * None left is `undefined`.
 */
export function canonicalRanges(
  ranges: RangeInput[] | undefined,
  path: string,
  text: OwnAttributes,
): CharacterRange[] | undefined {
  const own = {
    tracking: text.tracking ?? 0,
    fontStyle: text.fontStyle ?? "Regular",
    fontFamily: text.fontFamily ?? BUNDLED_FONT,
    fontSize: text.fontSize ?? 12,
  };
  // ponytail: per-character expansion, O(Σ range lengths); sweep the boundaries if it shows in a
  // profile.
  const chars: Overrides[] = [];
  ranges?.forEach((r, i) => {
    const colour = (k: "fill" | "stroke") =>
      r[k] === undefined ? undefined : parseColor(r[k], `${path}[${i}].${k}`);
    const [fill, stroke] = [colour("fill"), colour("stroke")];
    for (let c = r.start; c < r.end; c++) {
      const o = { ...chars[c] };
      if (fill !== undefined) o.fill = fill;
      if (stroke !== undefined) o.stroke = stroke;
      for (const k of ["baselineShift", "rotation"] as const) {
        if (r[k] === 0) delete o[k];
        else if (r[k] !== undefined) o[k] = r[k];
      }
      for (const k of ["tracking", "fontStyle", "fontFamily", "fontSize"] as const) {
        if (r[k] === own[k]) delete o[k];
        else if (r[k] !== undefined) Object.assign(o, { [k]: r[k] });
      }
      chars[c] = o;
    }
  });
  const out: CharacterRange[] = [];
  for (let c = 0; c < chars.length; c++) {
    const o = chars[c] ?? {};
    if (Object.keys(o).length === 0) continue;
    const last = out.at(-1);
    if (last?.end === c && OVERRIDES.every((k) => last[k] === o[k])) last.end++;
    else out.push({ start: c, end: c + 1, ...o });
  }
  return out.length ? out : undefined;
}

/**
 * A text's Character Ranges without their fills and strokes, canonical, as a Clipping Path keeps
 * them (ADR-0052, ADR-0068).
 */
export const unfilledRanges = (ranges: CharacterRange[] | undefined, text: OwnAttributes) =>
  canonicalRanges(
    ranges?.map(({ fill: _, stroke: __, ...r }) => r),
    "ranges",
    text,
  );

/** What lays out a text: its kind, anchor or frame, content and character attributes. */
interface TextLayout extends TextFont {
  kind?: "point" | "area";
  x: number;
  y: number;
  /** Area Type's frame; the schema requires both on Area Type (ADR-0022). */
  width?: number;
  height?: number;
  /** A shaped Area Type's frame, closed path data; `x, y, width, height` are its bounds. */
  frame?: string | undefined;
  content: string;
  fontSize: number;
  leading?: number | undefined;
  tracking?: number | undefined;
  alignment?: Alignment | undefined;
  ranges?: CharacterRange[] | undefined;
}

/**
 * One laid-out line: its characters, where its baseline starts, aligned (ADR-0077), and its first
 * character's index.
 */
export interface TextLine {
  text: string;
  x: number;
  y: number;
  /** The code-point index in `content` of the line's first character. */
  start: number;
  /** A justified line's extra space in pt after each space before its last word (ADR-0077). */
  wordSpacing?: number;
}

/**
 * A character of `content` on its own: its advance and the tracking after it in pt, the bundled
 * family it draws in and its size, and its overrides.
 */
interface Metric {
  char: string;
  advance: number;
  tracking: number;
  family: BundledFamily;
  size: number;
  overrides: Overrides | undefined;
}

/**
 * The font a character of a text draws in: the text's, with the overrides of the Character Range
 * that holds it (ADR-0068).
 */
const characterFont = (text: TextFont, overrides: Overrides | undefined): TextFont => ({
  fontFamily: overrides?.fontFamily ?? text.fontFamily,
  fontStyle: overrides?.fontStyle ?? text.fontStyle,
});

/** Each character of a text's content, with the overrides of the Character Range that holds it. */
function metrics(text: TextLayout): Metric[] {
  // The faces of each font the text's characters draw in, looked up once.
  const fonts = new Map<string, [DrawnFace, ...DrawnFace[]]>();
  const drawn = (font: TextFont, char: string) => {
    const key = `${font.fontFamily}\n${font.fontStyle}`;
    const faces = fonts.get(key) ?? facesOf(font);
    fonts.set(key, faces);
    const { family, face } = faceFor(faces, char);
    return { family, units: face.advance(char.codePointAt(0) as number) ?? face.notdef };
  };
  const ranges = text.ranges ?? [];
  const overrides = ranges.map(({ start: _, end: __, ...o }) => o);
  let j = 0;
  return [...text.content].map((char, c) => {
    while ((ranges[j]?.end ?? Infinity) <= c) j++;
    const o = (ranges[j]?.start ?? Infinity) <= c ? overrides[j] : undefined;
    // A character's advance and tracking scale with its own size (ADR-0068).
    const size = o?.fontSize ?? text.fontSize;
    const tracking = ((o?.tracking ?? text.tracking ?? 0) * size) / 1000;
    const { family, units } = drawn(characterFont(text, o), char);
    return {
      char,
      advance: (units * size) / SOURCE_SANS_3.unitsPerEm,
      tracking,
      family,
      size,
      overrides: o,
    };
  });
}

/**
 * The width in pt of the characters from `from` up to `to`: their advances plus the tracking
 * between them, but not after the last (ADR-0029). None is 0 wide.
 */
function span(m: Metric[], from: number, to: number) {
  // ponytail: advance sum, no shaping or kerning; HarfBuzz (F-TEXT-09, M1) replaces this with
  // shaped glyph positions.
  let width = 0;
  for (let i = from; i < to; i++) width += (m[i] as Metric).advance + (m[i] as Metric).tracking;
  return to > from ? width - (m[to - 1] as Metric).tracking : 0;
}

/**
 * A text's lines (ADR-0022). Point Type breaks at hard returns, from the baseline origin `x, y`, each
 * later line one of its own leadings below the one before (ADR-0068). Area Type wraps in its frame
 * as Inkscape 1.2 draws it, at spaces, between CJK characters (ADR-0064) and inside a unit wider
 * than its span (ADR-0084): each line keeps its trailing spaces and hard return, so its lines and
 * `overflow`, the text that does not fit, join back into `content`.
 */
export function layoutText(text: TextLayout): { lines: TextLine[]; overflow: string } {
  const { lines, overflow } = layout(text);
  return { lines, overflow };
}

/**
 * Whether a text's characters, laid out in `lines`, each need a position of their own: tracking, a
 * Character Range or a justified line's widened space moves or paints some character apart from a
 * line drawn whole in the text's font (ADR-0029, ADR-0068, ADR-0077).
 */
export const drawsPerCharacter = (text: TextLayout, lines: TextLine[]): boolean =>
  !!(text.tracking || text.ranges || lines.some((l) => l.wordSpacing));

/**
 * The bundled family each character of a text's content draws in, its hidden overflow included:
 * its Character Range's font, then the first bundled family that has its glyph (ADR-0063,
 * ADR-0068).
 */
export const characterFamilies = (text: TextLayout): BundledFamily[] =>
  metrics(text).map((c) => c.family);

/**
 * Where the trailing whitespace of `chars` from `from` up to `to` starts: the characters after it
 * hang past the frame's edge and past a line's alignment, and are never widened (ADR-0022,
 * ADR-0077). Whitespace is every character JavaScript's `/\s/` matches.
 */
function hangsFrom(chars: string[], from = 0, to = chars.length): number {
  while (to > from && /\s/.test(chars[to - 1] as string)) to--;
  return to;
}

/** Where a line's aligned start sits from its anchor, in its widths (ADR-0077). */
const ALIGN = { left: 0, center: 0.5, right: 1, justify: 0 } as const;

/** `layoutText`, with the metrics of every character of `content`, each line aligned (ADR-0077). */
function layout(text: TextLayout) {
  const out = unaligned(text);
  const { lines, overflow, m } = out;
  const { alignment = "left" } = text;
  const area = text.kind === "area";
  if (alignment === "left" || (alignment === "justify" && !area)) return { lines, overflow, m };
  lines.forEach((l, i) => {
    // Area Type aligns each line in its span (ADR-0078).
    const { x, width = 0 } = "spans" in out ? (out.spans[i] as Span) : text;
    // Trailing whitespace hangs past the edge, and so does the tracking after the last character,
    // as Inkscape 1.2.2 measures an aligned line (ADR-0077).
    const chars = [...l.text];
    const end = hangsFrom(chars);
    const w = span(m, l.start, l.start + end);
    const k = ALIGN[alignment];
    if (alignment !== "justify") l.x = area ? x + (width - w) * k : x - w * k;
    else {
      // A paragraph's last line, a line ending at a hard return or the last shown, stays left, as
      // does a line with no space between words to widen (Illustrator's Justify with last line
      // aligned left, word spacing only).
      const spaces = chars.slice(0, end).filter((c) => c === " ").length;
      const last = i === lines.length - 1 || chars.at(-1) === "\n";
      if (!last && spaces > 0 && w < width) l.wordSpacing = (width - w) / spaces;
    }
  });
  return { lines, overflow, m };
}

/**
 * Each line's box. A line's leading, as Illustrator's (ADR-0068): the Node's, or with Auto 120% of
 * the largest size among its characters, its hard return included; an empty last line's is the
 * Node's size. The box is the text's first family's em box at that size, with half the leading
 * above and below: the families a line's characters draw in never change it, as Illustrator stacks
 * by leading alone (ADR-0080).
 *
 * A line's band, from its baseline: its box less a tenth of its height at its top and bottom
 * (ADR-0078). Inkscape's line box also holds the text's own strut, which reaches lower than a
 * larger size's box under a set leading, and than a smaller size's with Auto, so the band reaches
 * at least the strut's bottom (#200, #203). The strut's ascent is not used: a band's top follows its
 * own size, as ADR-0080's first baseline does. A line shows while its band lies in the frame.
 *
 * The narrowest span a unit may break in, `minBreakWidth` (ADR-0084): four of Inkscape's line
 * boxes, the box and the strut's joined, ascent included.
 */
function lineBoxes(text: TextLayout, m: Metric[]) {
  const first = FAMILIES[fontFamilies(text)[0]].ascent;
  const lineBox = (from: number, to: number) => {
    let size = 0;
    for (let i = from; i < to; i++) size = Math.max(size, (m[i] as Metric).size);
    size ||= m[to]?.size ?? text.fontSize;
    const leading = text.leading ?? 1.2 * size;
    const half = (leading - size) / 2;
    return { size, leading, ascent: half + first * size, descent: half + (1 - first) * size };
  };
  // An empty range past the last character is the Node's own size.
  const strut = lineBox(m.length, m.length);
  const band = (baseline: number, b: ReturnType<typeof lineBox>) => {
    const descent = Math.max(b.descent, strut.descent);
    const cut = 0.1 * (b.ascent + descent);
    return { top: baseline - b.ascent + cut, bottom: baseline + descent - cut };
  };
  const minBreakWidth = (b: ReturnType<typeof lineBox>) =>
    4 * (Math.max(b.ascent, strut.ascent) + Math.max(b.descent, strut.descent));
  return { lineBox, band, minBreakWidth };
}

type LineBoxes = ReturnType<typeof lineBoxes>;
type LineBox = ReturnType<LineBoxes["lineBox"]>;

/**
 * Where Area Type puts a line's baseline below the one before, `prev`, from the frame's top. The
 * first is one line-box ascent below the frame's top; each later one is the line's leading below
 * the one before (ADR-0068, ADR-0080).
 */
function stack(prev: number | undefined, b: LineBox): number {
  return prev === undefined ? b.ascent : prev + b.leading;
}

/** An unbreakable unit's code-point range, and whether a hard return or the content ends it. */
type Unit = { from: number; to: number; ends: boolean };

/**
 * `content`'s unbreakable units (ADR-0064), paragraph by paragraph, each hard return in its
 * paragraph's last unit. Empty content is one empty unit, so it lays out one empty line.
 */
function unitsOf(content: string): Unit[] {
  const units: Unit[] = [];
  let at = 0;
  for (const paragraph of content.split(/(?<=\n)/)) {
    for (const unit of lineBreakUnits(paragraph)) {
      const from = at;
      at += [...unit].length;
      units.push({ from, to: at, ends: false });
    }
    const last = units.at(-1);
    if (last) last.ends = true;
  }
  if (!units.length) units.push({ from: 0, to: 0, ends: true });
  return units;
}

/** Where a broken unit may break (ADR-0084). */
const GRAPHEMES = new Intl.Segmenter();

/** The lines as ADR-0022 lays them out, each starting at `x`, and Area Type's spans. */
function unaligned(text: TextLayout) {
  const { x, y, content, fontSize } = text;
  const m = metrics(text);
  const chars = m.map((c) => c.char);
  const boxes = lineBoxes(text, m);
  const { lineBox } = boxes;
  let start = 0;
  const line = (t: string, lineY: number): TextLine => {
    const l = { text: t, x, y: lineY, start };
    start += [...t].length;
    return l;
  };
  if (text.kind !== "area") {
    // What the lines' leadings exceed the Node's by, so a text of one size keeps `y + i · leading`.
    const own = text.leading ?? 1.2 * fontSize;
    let extra = 0;
    const lines = content.split("\n").map((t, i) => {
      const n = [...t].length;
      if (i) extra += lineBox(start, Math.min(start + n + 1, m.length)).leading - own;
      const l = line(t, y + i * own + extra);
      start++;
      return l;
    });
    return { lines, overflow: "", m };
  }
  return { ...area(text, m, chars, boxes), m };
}

/**
 * Area Type's lines (ADR-0022, ADR-0078), as Inkscape 1.2.2 flows `shape-inside`. Each band is a
 * line's band (`lineBoxes`), stacked by `stack`, and its spans, left to right, take words greedily
 * with ADR-0022's width rules, each span its own line; a rectangle's band is one span, the frame's
 * width, while it lies in the frame (#203). A shaped band is sized by every character it tries, the
 * unit it could not fit included, and when one is larger it is sized again and refilled from its
 * first unit (#200). A rectangle's line is sized by the characters it holds, Illustrator's rule
 * (ADR-0068): its width does not follow its height, so that never moves a break. A span too narrow
 * for the next word is skipped, and so is a band with no span it fits, one of its leadings down; a
 * hard return ends the span, the next paragraph starting in the next one. A unit that starts a span
 * it does not fit, in a span at least `minBreakWidth` wide, is broken there between grapheme clusters
 * instead: the span takes its widest prefix, and the rest starts the next span (ADR-0084). A piece
 * sizes a shaped band up to the cluster that did not fit. What fits no band above the frame's
 * bottom overflows (ADR-0022). Each line's span, for alignment.
 */
function area(
  text: TextLayout,
  m: Metric[],
  chars: string[],
  { lineBox, band, minBreakWidth }: LineBoxes,
): { lines: TextLine[]; overflow: string; spans: Span[] } {
  const { x, y, content, width: frameWidth = 0, height = 0 } = text;
  const edges = text.frame ? edgesOf(text.frame) : undefined;
  const bottom = y + height;
  const units = unitsOf(content);
  const width = (from: number, to: number) => span(m, from, hangsFrom(chars, from, to));
  /**
   * Where the widest prefix of whole grapheme clusters from `from` up to `to` that is at most `w`
   * wide ends, `from` when none is, and where the cluster after it ends.
   */
  const prefix = (from: number, to: number, w: number) => {
    let [end, over] = [from, to];
    for (const { segment } of GRAPHEMES.segment(chars.slice(from, to).join(""))) {
      const next = end + [...segment].length;
      if (span(m, from, next) > w) {
        over = next;
        break;
      }
      end = next;
    }
    return { end, over };
  };
  /**
   * The lines greedy filling puts in `spans` from unit `u`, its characters from `at` on, where the
   * characters it tried end, and the unit and character it stopped at.
   */
  const fill = (spans: Span[], u: number, at: number, minBreak: number) => {
    const placed: { from: number; to: number; span: Span }[] = [];
    let s = 0;
    let from = at;
    let rest = at;
    let tried = at;
    for (; u < units.length; u++) {
      const unit = units[u] as Unit;
      rest = Math.max(unit.from, at);
      // A unit that ends the band unbroken sizes it whole; a piece narrows this, a fit resets it.
      tried = unit.to;
      const slot = spans[s];
      if (slot && from < rest && width(from, unit.to) > slot.width) {
        placed.push({ from, to: rest, span: slot });
        [from, s] = [rest, s + 1];
      }
      // The unit starts span s. A billionth's tolerance keeps Inkscape's `>=` where the widths are equal.
      for (let sp = spans[s]; sp && width(rest, unit.to) > sp.width; sp = spans[++s]) {
        if (sp.width < minBreak * (1 - 1e-9)) continue;
        const piece = prefix(rest, unit.to, sp.width);
        if (piece.end === rest) continue;
        placed.push({ from: rest, to: piece.end, span: sp });
        from = rest = piece.end;
        tried = piece.over;
      }
      const fits = spans[s];
      if (!fits) break;
      tried = unit.to;
      if (unit.ends) {
        // After a hard return the next paragraph starts in the next span, as Inkscape flows it.
        placed.push({ from, to: unit.to, span: fits });
        [from, s] = [unit.to, s + 1];
        if (!spans[s]) {
          u++;
          break;
        }
      }
    }
    return { placed, next: u, rest: Math.max(rest, units[u]?.from ?? rest), tried };
  };
  const lines: TextLine[] = [];
  const spans: Span[] = [];
  let prev: number | undefined;
  let u = 0;
  // The first character not laid out, inside unit u once a piece of it is.
  let at = 0;
  while (u < units.length) {
    const overflow = () => ({ lines, overflow: chars.slice(at).join(""), spans });
    // A line is sized from its first character up, so a piece is not sized by the rest of its unit.
    let box = lineBox(at, at);
    for (;;) {
      const next = stack(prev, box);
      const baseline = y + next;
      const { top, bottom: bandBottom } = band(baseline, box);
      if (edges && top > bottom) return overflow();
      const bandSpans = edges ? frameSpans(edges, top, bandBottom) : [{ x, width: frameWidth }];
      const { placed, next: after, rest, tried } = fill(bandSpans, u, at, minBreakWidth(box));
      const grown = lineBox(at, edges ? tried : (placed.at(-1)?.to ?? at));
      if (grown.size > box.size) {
        box = grown;
        continue;
      }
      // Every band of a rectangle is the same span, so a band whose first unit does not fit ends
      // the layout.
      if (!edges && !placed.length) return overflow();
      // A rectangle's line shows while its band, at the line's own size, lies in the frame: under
      // a set leading a larger size can end it higher. It may reach a billionth of its leading past.
      if (!edges && bandBottom > bottom + 1e-9 * box.leading) return overflow();
      for (const p of placed) {
        lines.push({
          text: chars.slice(p.from, p.to).join(""),
          x: p.span.x,
          y: baseline,
          start: p.from,
        });
        spans.push(p.span);
      }
      prev = next;
      [u, at] = [after, rest];
      break;
    }
  }
  return { lines, overflow: "", spans };
}

/**
 * A laid-out character: its origin on the unshifted baseline, advance width, the bundled family it
 * draws in, whether it starts a chunk, and its overrides.
 */
export interface Glyph extends Omit<CharacterRange, "start" | "end"> {
  char: string;
  x: number;
  y: number;
  width: number;
  family: BundledFamily;
  /**
   * Why a new text chunk starts at the character: `spacing` after a space before its line's last
   * word in a text with a justified line, which every writer positions (ADR-0077); `family` where
   * the family it draws in differs from the one before it on its line, the text's first family at a
   * line's start, a hard return starting none, which a renderer that picks one face per chunk needs
   * (ADR-0063).
   */
  chunk?: "spacing" | "family";
}

/**
 * Every character of a text's shown lines, a line's hard return included, each one tracking past the
 * one before by its own tracking, with the family it draws in, the chunk it starts and the overrides
 * of the Character Range that holds it (ADR-0029, ADR-0063, ADR-0068, ADR-0077).
 */
export function glyphs(text: TextLayout): Glyph[] {
  const { lines, m } = layout(text);
  const [first] = fontFamilies(text);
  const justified = lines.some((l) => l.wordSpacing);
  return lines.flatMap((line) => {
    let x = line.x;
    let drawn = first;
    let afterSpace = false;
    const chars = [...line.text];
    // In a justified text a chunk starts after each space before a line's last word, and a
    // justified line widens those spaces (ADR-0077).
    const words = hangsFrom(chars);
    return chars.map((char, k) => {
      const { advance, tracking, family, overrides } = m[line.start + k] as Metric;
      const glyph: Glyph = { char, x, y: line.y, width: advance, family, ...overrides };
      if (afterSpace) glyph.chunk = "spacing";
      else if (char !== "\n" && family !== drawn) glyph.chunk = "family";
      if (char !== "\n") drawn = family;
      x += advance + tracking;
      afterSpace = justified && char === " " && k < words;
      if (afterSpace && line.wordSpacing) x += line.wordSpacing;
      return glyph;
    });
  });
}

/**
 * A text's box: Area Type's frame. Point Type's is the union of its lines, each from its aligned
 * start for its width, at least 0, and from the ascender to the descender (ADR-0013, ADR-0022,
 * ADR-0077), and of every character's cell: its advance width from its origin, ascender to descender
 * at its own size, raised by its baseline shift and turned clockwise about the origin by its rotation
 * (ADR-0029, ADR-0068).
 */
export function textBox(text: TextLayout): Rect {
  if (text.kind === "area") {
    return { x: text.x, y: text.y, width: text.width ?? 0, height: text.height ?? 0 };
  }
  const { unitsPerEm, ascender, descender } = SOURCE_SANS_3;
  const s = text.fontSize / unitsPerEm;
  const { lines, m } = layout(text);
  let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (x: number, y: number) => {
    [left, top] = [Math.min(left, x), Math.min(top, y)];
    [right, bottom] = [Math.max(right, x), Math.max(bottom, y)];
  };
  for (const l of lines) {
    add(l.x, l.y - ascender * s);
    add(l.x + Math.max(0, span(m, l.start, l.start + [...l.text].length)), l.y - descender * s);
  }
  for (const g of glyphs(text)) {
    const a = ((g.rotation ?? 0) * Math.PI) / 180;
    const [cos, sin] = [Math.cos(a), Math.sin(a)];
    const shift = g.baselineShift ?? 0;
    const k = (g.fontSize ?? text.fontSize) / unitsPerEm;
    for (const dx of [0, g.width]) {
      for (const dy of [-ascender * k - shift, -descender * k - shift]) {
        add(g.x + cos * dx - sin * dy, g.y + sin * dx + cos * dy);
      }
    }
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Rounded up to a multiple of 1 / `per`, within the 3 decimals the file keeps (REQUIREMENTS §6.5),
 * so a frame never shrinks.
 */
function roundUp(n: number, per = 1000) {
  // Dividing by `per` can land just below n.
  const up = Math.ceil(n * per) / per;
  return up >= n ? up : round3(up + 1 / per);
}

/**
 * Convert to Area Type (ADR-0079): the rectangle frame Point Type's lines lay out in unchanged. It
 * is as wide as the widest line and each unit or prefix greedy wrapping checks, so nothing wraps,
 * and reaches the lowest line box's bottom as Area Type stacks them, so nothing overflows; its
 * first baseline is the old one, to the 3 decimals it keeps. Area Type lays out no line for an
 * empty last paragraph, so its height does not count.
 */
export function areaFrame(text: TextLayout): Rect {
  const { lines, m } = layout({ ...text, kind: "point" });
  const chars = m.map((c) => c.char);
  const { lineBox, band } = lineBoxes(text, m);
  const width = (from: number, to: number) => span(m, from, hangsFrom(chars, from, to));
  let [widest, height] = [0, 0];
  let prev: number | undefined;
  let ascent = 0;
  // Each Point Type line is a paragraph, its units in turn up to the one its hard return ends.
  const units = unitsOf(text.content);
  let u = 0;
  lines.forEach((l, i) => {
    for (; u < units.length; u++) {
      const unit = units[u] as Unit;
      widest = Math.max(widest, width(l.start, unit.to), width(unit.from, unit.to));
      if (unit.ends) {
        u++;
        break;
      }
    }
    if (i && i === lines.length - 1 && !l.text) return;
    const to = l.start + [...l.text].length;
    const b = lineBox(l.start, Math.min(to + 1, m.length));
    prev = stack(prev, b);
    if (!i) ascent = prev;
    // The line box's bottom, lines × leading at one size, or its band's where the strut reaches
    // lower, so the line shows.
    height = Math.max(height, prev + b.descent, band(prev, b).bottom);
  });
  // Every line empty or all spaces has no width; a frame needs one. A centred frame's width is an
  // even thousandth, so its middle, where the lines centre, is Point Type's x on the way back.
  const center = text.alignment === "center";
  widest = roundUp(widest || text.fontSize, center ? 500 : 1000);
  return {
    x: round3(text.x - widest * ALIGN[text.alignment ?? "left"]),
    y: round3(text.y - ascent),
    width: widest,
    height: roundUp(height),
  };
}

/**
 * Convert to Point Type (ADR-0079): Area Type's shown lines, each soft wrap a hard return in place
 * of the line's last whitespace, or inserted after a CJK break or a broken unit's piece (ADR-0084),
 * which shifts the ranges after it.
 * The overflow is discarded, and so is the hard return before it unless it is all that shows;
 * `discarded` counts what goes.
 * The first line keeps its baseline and aligned start. Undefined when no line shows.
 */
export function pointType(
  text: TextLayout,
):
  | { x: number; y: number; content: string; ranges: CharacterRange[]; discarded: number }
  | undefined {
  const { lines, overflow, m } = layout(text);
  const head = lines[0];
  if (!head) return undefined;
  let ranges = text.ranges ?? [];
  const out: string[] = [];
  let inserted = 0;
  lines.forEach((l, i) => {
    const t = [...l.text];
    const last = t.at(-1) as string;
    const soft = i < lines.length - 1 && last !== "\n";
    // Kept when it is all that shows, as Point Type needs content.
    if (i === lines.length - 1 && last === "\n" && overflow && out.length + t.length > 1) t.pop();
    else if (soft && /\s/.test(last)) t[t.length - 1] = "\n";
    else if (soft) {
      const p = out.length + t.length;
      ranges = ranges.map((r) => ({
        ...r,
        start: r.start >= p ? r.start + 1 : r.start,
        end: r.end > p ? r.end + 1 : r.end,
      }));
      t.push("\n");
      inserted++;
    }
    out.push(...t);
  });
  const w = span(m, head.start, head.start + hangsFrom([...head.text]));
  const k = ALIGN[text.alignment ?? "left"];
  return {
    x: round3(head.x + w * k),
    y: round3(head.y),
    content: out.join(""),
    ranges: ranges
      .map((r) => ({ ...r, end: Math.min(r.end, out.length) }))
      .filter((r) => r.start < r.end),
    discarded: [...text.content].length - out.length + inserted,
  };
}

const faceName = (family: string, style: FontStyle) =>
  style === "Regular" ? family : `${family} ${style}`;

/**
 * A `FONT_MISSING` warning for each face a text or one of its Character Ranges names whose family or
 * style is not bundled, one per distinct face (ADR-0017, ADR-0028, ADR-0068). The family and style
 * decide, not the faces other characters fall back to (ADR-0063).
 */
export function fontWarnings(nodes: Node[]): Warning[] {
  return nodes.flatMap((n) => {
    if (n.type !== "text") return [];
    const missing = new Set<string>();
    for (const font of [n, ...(n.ranges ?? []).map((r) => characterFont(n, r))]) {
      const { fontFamily = BUNDLED_FONT, fontStyle: style = "Regular" } = font;
      const [family] = fontFamilies(font);
      const drawn = FAMILIES[family].face(style);
      if (fontFamily !== family || drawn !== style) {
        missing.add(
          `${faceName(fontFamily, style)} is not bundled, so it renders in ${faceName(family, drawn)}; the name is kept.`,
        );
      }
    }
    return [...missing].map((message) => ({ code: "FONT_MISSING", nodeId: n.id, message }));
  });
}

/**
 * One `FONT_MISSING` warning per missing face, as Open and Place report it (ADR-0017): a file set in
 * one missing font says so once, on the first text in that face.
 */
export function fileFontWarnings(nodes: Node[]): Warning[] {
  const faces = new Map<string, Warning>();
  for (const w of fontWarnings(nodes)) if (!faces.has(w.message)) faces.set(w.message, w);
  return [...faces.values()];
}

/** The distinct characters of `content` no face a text draws in has, in order; `\n` is a hard return. */
function missingGlyphs(text: Extract<Node, { type: "text" }>): string[] {
  return [...new Set(text.content)].filter((ch) => !hasGlyph(text, ch));
}

const MISSING_GLYPHS_NAMED = 20;
const missingGlyphsWarning = (nodeId: string, chars: string[]): Warning => {
  const more = chars.length - MISSING_GLYPHS_NAMED;
  const named =
    chars.slice(0, MISSING_GLYPHS_NAMED).join(", ") + (more > 0 ? ` and ${more} more` : "");
  return {
    code: "MISSING_GLYPHS",
    nodeId,
    message: `None of ${list(BUNDLED_FAMILIES, "disjunction")} has glyphs for ${named}; they render as .notdef boxes and measure as the box's width.`,
  };
};

/**
 * A `MISSING_GLYPHS` warning for each text with characters none of the faces it draws in has
 * (ADR-0062, ADR-0063). The faces, not `fontFamily`, decide: every text draws in the bundled fonts.
 */
export function glyphWarnings(nodes: Node[]): Warning[] {
  return nodes.flatMap((n) => {
    const chars = n.type === "text" ? missingGlyphs(n) : [];
    return chars.length ? [missingGlyphsWarning(n.id, chars)] : [];
  });
}

/**
 * One `MISSING_GLYPHS` warning for a whole file, as Open and Place report it (ADR-0062): the union of
 * its texts' missing characters, on the first text that has one.
 */
export function fileGlyphWarnings(nodes: Node[]): Warning[] {
  let first: string | undefined;
  const chars = new Set<string>();
  for (const n of nodes) {
    if (n.type !== "text") continue;
    const missing = missingGlyphs(n);
    if (missing.length) first ??= n.id;
    for (const ch of missing) chars.add(ch);
  }
  return first ? [missingGlyphsWarning(first, [...chars])] : [];
}

/** The codes `fileTextWarnings` keeps once per file or face, so one stands for several texts. */
export const FILE_TEXT_WARNING_CODES = new Set(["FONT_MISSING", "MISSING_GLYPHS"]);

/** The text warnings Open and Place report once per file (`FONT_MISSING` once per face), in order. */
export const fileTextWarnings = (nodes: Node[]): Warning[] => [
  ...fileFontWarnings(nodes),
  ...fileGlyphWarnings(nodes),
];

/** A `TEXT_OVERFLOW` warning for each Area Type whose content does not all fit (ADR-0022). */
export function overflowWarnings(nodes: Node[]): Warning[] {
  return nodes.flatMap((n) => {
    const overflow = n.type === "text" ? layoutText(n).overflow : "";
    return overflow
      ? [
          {
            code: "TEXT_OVERFLOW",
            nodeId: n.id,
            message: `${[...overflow].length} characters do not fit the frame and are not drawn; enlarge the frame or shorten the content.`,
          },
        ]
      : [];
  });
}

/** Every text warning a write that creates or updates Nodes reports in its receipt. */
export const textWarnings = (nodes: Node[]): Warning[] => [
  ...fontWarnings(nodes),
  ...glyphWarnings(nodes),
  ...overflowWarnings(nodes),
];
