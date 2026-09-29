import { parseColor } from "./color.ts";
import { lineBreakUnits } from "./line-break.ts";
import { NOTO_SANS_SC } from "./noto-sans-sc.ts";
import type { CharacterRange, Node, Rect, Warning } from "./schema.ts";
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

/** A face's advance by code point in font units, undefined where it has no glyph, and its `.notdef`'s. */
type Face = { advance: (codePoint: number) => number | undefined; notdef: number };

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
    return [style, { advance: (c: number) => advances[c], notdef: f.notdef }];
  }),
) as Record<BundledStyle, Face>;
const notoSansSC = Object.fromEntries(
  Object.entries(NOTO_SANS_SC.faces).map(([style, f]) => [
    style,
    { advance: (c: number) => runAdvance(f.runs, c), notdef: f.notdef },
  ]),
) as Record<NotoStyle, Face>;

/** A family's ascender as a share of its em box: ascender to descender scaled to one em, as Inkscape. */
const emAscent = ({ ascender, descender }: { ascender: number; descender: number }) =>
  ascender / (ascender - descender);

/**
 * The bundled families, each with the style names of its faces and the face a style draws in, by
 * CSS matching (ADR-0028, ADR-0063). Noto Sans SC has Regular and Bold only, and no italic: weights
 * to 500 draw in Regular, heavier in Bold, and an italic draws upright.
 */
const FAMILIES = {
  "Source Sans 3": {
    face: (style?: FontStyle) => bundledStyle(style),
    faces: sourceSans3,
    ascent: emAscent(SOURCE_SANS_3),
  },
  "Noto Sans SC": {
    face: (style?: FontStyle): NotoStyle => (fontFace(style).weight <= 500 ? "Regular" : "Bold"),
    faces: notoSansSC,
    ascent: emAscent(NOTO_SANS_SC),
  },
} as const;
export type BundledFamily = keyof typeof FAMILIES;

/** The one family every family Zibel lacks renders in (ADR-0013). */
export const BUNDLED_FONT = "Source Sans 3";

/** What picks a text's faces: its family, Source Sans 3 if none, and style. */
type TextFont = { fontFamily?: string | undefined; fontStyle?: FontStyle | undefined };

const isBundled = (family: string): family is BundledFamily => Object.hasOwn(FAMILIES, family);

/**
 * The bundled families a text draws in, in fallback order (ADR-0063): its own family if bundled,
 * else Source Sans 3, then the other bundled families. Each character draws in the first that has
 * its glyph, as a browser's font fallback picks, and else as the first's `.notdef`.
 */
export function fontFamilies(text: TextFont): [BundledFamily, ...BundledFamily[]] {
  const { fontFamily = BUNDLED_FONT } = text;
  const own = isBundled(fontFamily) ? fontFamily : BUNDLED_FONT;
  return [own, ...(Object.keys(FAMILIES) as BundledFamily[]).filter((f) => f !== own)];
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

/** The bundled family a character of a text draws in (ADR-0063). */
export const drawnFamily = (text: TextFont, char: string): BundledFamily =>
  faceFor(facesOf(text), char).family;

/** A text's advance of a character in font units, in the face it draws in. */
function advancer(text: TextFont): (char: string) => number {
  const faces = facesOf(text);
  return (char) => {
    const { face } = faceFor(faces, char);
    return face.advance(char.codePointAt(0) as number) ?? face.notdef;
  };
}

type Overrides = Omit<CharacterRange, "start" | "end">;
/** A Character Range as written, its fill not parsed yet. */
type RangeInput = Omit<CharacterRange, "fill"> & { fill?: unknown };

/**
 * Character Ranges in canonical form (ADR-0029): colours parsed, a later range winning attribute by
 * attribute, a shift or rotation of 0 clearing, then sorted runs that do not overlap, adjacent equal
 * runs merged and runs without overrides dropped. None left is `undefined`.
 */
export function canonicalRanges(
  ranges: RangeInput[] | undefined,
  path: string,
): CharacterRange[] | undefined {
  // ponytail: per-character expansion, O(Σ range lengths); sweep the boundaries if it shows in a
  // profile.
  const chars: Overrides[] = [];
  ranges?.forEach((r, i) => {
    const fill = r.fill === undefined ? undefined : parseColor(r.fill, `${path}[${i}].fill`);
    for (let c = r.start; c < r.end; c++) {
      const o = { ...chars[c] };
      if (fill !== undefined) o.fill = fill;
      for (const k of ["baselineShift", "rotation"] as const) {
        if (r[k] === 0) delete o[k];
        else if (r[k] !== undefined) o[k] = r[k];
      }
      chars[c] = o;
    }
  });
  const out: CharacterRange[] = [];
  for (let c = 0; c < chars.length; c++) {
    const o = chars[c] ?? {};
    if (Object.keys(o).length === 0) continue;
    const last = out.at(-1);
    if (
      last?.end === c &&
      last.fill === o.fill &&
      last.baselineShift === o.baselineShift &&
      last.rotation === o.rotation
    ) {
      last.end++;
    } else {
      out.push({ start: c, end: c + 1, ...o });
    }
  }
  return out.length ? out : undefined;
}

/** Character Ranges without their fills, canonical, as a Clipping Path keeps them (ADR-0052). */
export const unfilledRanges = (ranges: CharacterRange[] | undefined) =>
  canonicalRanges(
    ranges?.map(({ fill: _, ...r }) => r),
    "ranges",
  );

/** What lays out a text: its kind, anchor or frame, content and character attributes. */
interface TextLayout extends TextFont {
  kind?: "point" | "area";
  x: number;
  y: number;
  /** Area Type's frame; the schema requires both on Area Type (ADR-0022). */
  width?: number;
  height?: number;
  content: string;
  fontSize: number;
  leading?: number | undefined;
  tracking?: number | undefined;
  ranges?: CharacterRange[] | undefined;
}

/** One laid-out line: its characters, where its baseline starts, and its first character's index. */
export interface TextLine {
  text: string;
  x: number;
  y: number;
  /** The code-point index in `content` of the line's first character. */
  start: number;
}

/**
 * A line's width in pt: its advance sum plus the tracking between its characters, but not after
 * the last (ADR-0029). An empty line is 0 wide.
 */
function lineWidth(
  text: string,
  advance: (char: string) => number,
  fontSize: number,
  tracking = 0,
) {
  // ponytail: advance sum, no shaping or kerning; HarfBuzz (F-TEXT-09, M1) replaces this with
  // shaped glyph positions.
  let units = 0;
  let count = 0;
  for (const ch of text) {
    units += advance(ch);
    count++;
  }
  const { unitsPerEm } = SOURCE_SANS_3;
  return (units * fontSize) / unitsPerEm + (Math.max(0, count - 1) * tracking * fontSize) / 1000;
}

/**
 * A text's lines (ADR-0022). Point Type breaks at hard returns, one leading apart from the baseline
 * origin `x, y`. Area Type wraps in its frame as Inkscape 1.2 draws it, at spaces and between CJK
 * characters (ADR-0064): each line keeps its trailing spaces and hard return, so its lines and
 * `overflow`, the text that does not fit, join back into `content`.
 */
export function layoutText(text: TextLayout): { lines: TextLine[]; overflow: string } {
  const { x, y, content, fontSize, tracking } = text;
  const leading = text.leading ?? 1.2 * fontSize;
  const advance = advancer(text);
  let start = 0;
  const line = (t: string, lineY: number) => {
    const l = { text: t, x, y: lineY, start };
    start += [...t].length;
    return l;
  };
  if (text.kind !== "area") {
    const lines = content.split("\n").map((t, i) => {
      const l = line(t, y + i * leading);
      start++;
      return l;
    });
    return { lines, overflow: "" };
  }
  const { width = 0, height = 0 } = text;
  // Trailing spaces and the return hang past the frame's edge.
  const fits = (l: string) => lineWidth(l.trimEnd(), advance, fontSize, tracking) <= width;
  // CSS inline boxes, as Inkscape stacks them (ADR-0064): half the leading above and below each
  // family's em box, and a line as tall as the union of its first family's box, the strut, and the
  // boxes of the families its characters draw in. Latin alone is one leading tall.
  const faces = facesOf(text);
  const halfLeading = (leading - fontSize) / 2;
  const box = (family: BundledFamily) => ({
    ascent: halfLeading + fontSize * FAMILIES[family].ascent,
    descent: halfLeading + fontSize * (1 - FAMILIES[family].ascent),
  });
  const strut = box(faces[0].family);
  const lineBox = (l: string) => {
    const b = { ...strut };
    for (const ch of l.trimEnd()) {
      const { ascent, descent } = box(faceFor(faces, ch).family);
      b.ascent = Math.max(b.ascent, ascent);
      b.descent = Math.max(b.descent, descent);
    }
    return b;
  };
  const lines: TextLine[] = [];
  let top = 0;
  let used = 0;
  // ponytail: Inkscape's thresholds, measured rather than specified: the first line shows while 90%
  // of its height lies in the frame, a later one while 90% of the leading does, or all of it if the
  // line is taller than the strut; and a unit wider than the frame overflows with all that follows.
  const push = (l: string) => {
    const { ascent, descent } = lineBox(l);
    let shows = 0.9 * leading;
    if (!lines.length) shows = 0.9 * (ascent + descent);
    else if (ascent > strut.ascent) shows = leading;
    if (top + shows > height + 1e-9 * leading) return false;
    lines.push(line(l, y + top + ascent));
    top += ascent + descent;
    used += l.length;
    return true;
  };
  wrap: for (const paragraph of content.split(/(?<=\n)/)) {
    let l = "";
    for (const unit of lineBreakUnits(paragraph)) {
      if (l && !fits(l + unit)) {
        if (!push(l)) break wrap;
        l = "";
      }
      if (!fits(unit)) break wrap;
      l += unit;
    }
    if (!push(l)) break;
  }
  return { lines, overflow: content.slice(used) };
}

/** A laid-out character: its origin on the unshifted baseline, advance width and overrides. */
export interface Glyph extends Omit<CharacterRange, "start" | "end"> {
  char: string;
  x: number;
  y: number;
  width: number;
}

/**
 * Every character of a text's shown lines, a line's hard return included, each one tracking past the
 * one before, with the overrides of the Character Range that holds it (ADR-0029).
 */
export function glyphs(text: TextLayout): Glyph[] {
  const advance = advancer(text);
  const s = text.fontSize / SOURCE_SANS_3.unitsPerEm;
  const tracking = ((text.tracking ?? 0) * text.fontSize) / 1000;
  const ranges = text.ranges ?? [];
  let j = 0;
  return layoutText(text).lines.flatMap((line) => {
    let x = line.x;
    return [...line.text].map((char, k) => {
      const c = line.start + k;
      while ((ranges[j]?.end ?? Infinity) <= c) j++;
      const width = advance(char) * s;
      const glyph: Glyph = { char, x, y: line.y, width };
      const r = ranges[j];
      if (r && r.start <= c) {
        const { start: _, end: __, ...overrides } = r;
        Object.assign(glyph, overrides);
      }
      x += width + tracking;
      return glyph;
    });
  });
}

/**
 * A text's box: Area Type's frame. Point Type's is the union of its lines, each from `x` for its
 * width, at least 0, and from the ascender to the descender (ADR-0013, ADR-0022), and of every
 * character's cell: its advance width from its origin, ascender to descender, raised by its baseline
 * shift and turned clockwise about the origin by its rotation (ADR-0029).
 */
export function textBox(text: TextLayout): Rect {
  if (text.kind === "area") {
    return { x: text.x, y: text.y, width: text.width ?? 0, height: text.height ?? 0 };
  }
  const { unitsPerEm, ascender, descender } = SOURCE_SANS_3;
  const s = text.fontSize / unitsPerEm;
  const advance = advancer(text);
  let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (x: number, y: number) => {
    [left, top] = [Math.min(left, x), Math.min(top, y)];
    [right, bottom] = [Math.max(right, x), Math.max(bottom, y)];
  };
  for (const l of layoutText(text).lines) {
    add(l.x, l.y - ascender * s);
    add(
      l.x + Math.max(0, lineWidth(l.text, advance, text.fontSize, text.tracking)),
      l.y - descender * s,
    );
  }
  for (const g of glyphs(text)) {
    const a = ((g.rotation ?? 0) * Math.PI) / 180;
    const [cos, sin] = [Math.cos(a), Math.sin(a)];
    const shift = g.baselineShift ?? 0;
    for (const dx of [0, g.width]) {
      for (const dy of [-ascender * s - shift, -descender * s - shift]) {
        add(g.x + cos * dx - sin * dy, g.y + sin * dx + cos * dy);
      }
    }
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

const faceName = (family: string, style: FontStyle) =>
  style === "Regular" ? family : `${family} ${style}`;

/**
 * A `FONT_MISSING` warning for each text whose family or style is not bundled (ADR-0017, ADR-0028).
 * The family and style decide, not the faces other characters fall back to (ADR-0063).
 */
export function fontWarnings(nodes: Node[]): Warning[] {
  return nodes.flatMap((n) => {
    if (n.type !== "text") return [];
    const style = n.fontStyle ?? "Regular";
    const [family] = fontFamilies(n);
    const drawn = FAMILIES[family].face(style);
    return n.fontFamily !== family || drawn !== style
      ? [
          {
            code: "FONT_MISSING",
            nodeId: n.id,
            message: `${faceName(n.fontFamily, style)} is not bundled, so it renders in ${faceName(family, drawn)}; the name is kept.`,
          },
        ]
      : [];
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
  const faces = facesOf(text);
  return [...new Set(text.content)].filter((ch) => {
    const c = ch.codePointAt(0) as number;
    return ch !== "\n" && faces.every((f) => f.face.advance(c) === undefined);
  });
}

const MISSING_GLYPHS_NAMED = 20;
const missingGlyphsWarning = (nodeId: string, chars: string[]): Warning => {
  const more = chars.length - MISSING_GLYPHS_NAMED;
  const named =
    chars.slice(0, MISSING_GLYPHS_NAMED).join(", ") + (more > 0 ? ` and ${more} more` : "");
  return {
    code: "MISSING_GLYPHS",
    nodeId,
    message: `Neither Source Sans 3 nor Noto Sans SC has glyphs for ${named}; they render as .notdef boxes and measure as the box's width.`,
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
