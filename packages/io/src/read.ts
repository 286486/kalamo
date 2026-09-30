import {
  type Alignment,
  type Appearance,
  type Artboard,
  applyTo,
  BlendMode,
  BUNDLED_FONT,
  type CharacterRange,
  type ContainerAppearance,
  canonicalRanges,
  cssColor,
  type Fill,
  fileProblem,
  fontStyleName,
  formatPath,
  frameShape,
  IDENTITY,
  IMAGE_ID,
  type ImageFile,
  type ImageInfo,
  invert,
  KalamoError,
  type Matrix,
  MIDPOINT_MAX,
  MIDPOINT_MIN,
  MIGRATIONS,
  mapGradient,
  multiply,
  type Node,
  newId,
  normalizePath,
  type OwnAttributes,
  parseDocument,
  parseNode,
  pathBounds,
  preserveAspectRatio,
  type Rect,
  type RenderScope,
  readImage,
  round,
  round3,
  type Segment,
  type Shape,
  scaleOf,
  shapedFrame,
  shapeSegments,
  textBox,
  transformSegments,
  unfilledRanges,
  union,
  type Warning,
  withAlpha,
} from "@kalamo/core";
import { DOMParser, type Element } from "@xmldom/xmldom";
import { generateKeyBetween } from "fractional-indexing";
import {
  alpha,
  arcOf,
  idOf,
  type KalamoAttr,
  MITER_LIMIT,
  NS,
  numbers,
  SVG_STROKE,
  scopeOf,
  spiralOf,
  starOf,
  xmlId,
} from "./dialect.ts";
import { asGradient, type Geometry, unmark, unroll } from "./gradient.ts";
import { computeStyle, type Rule, type Style, stylesheet } from "./style.ts";

/** A file read for Open: a Document's contents without its docId, and what did not come across. */
export interface OpenedFile {
  name: string;
  artboards: Artboard[];
  nodes: Node[];
  /** The file of every Image `src` names, by that key (ADR-0023). */
  images: Map<string, ImageFile>;
  warnings: Warning[];
  /** The Render Scope a Kalamo SVG export was written at, from `kalamo:scope`; absent at doc scope. */
  scope?: RenderScope;
  /** Each linked Image's `kalamo:src`, by Node id, until `resolveLinks` (ADR-0042). */
  links?: Map<string, Link>;
}

/**
 * The pixels a linked `<image>` names by `kalamo:src`, which the target Document may hold. `size` is
 * there when `width` or `height` was absent: the frame then takes the pixel size, so the Image's
 * frame is a placeholder until then.
 */
interface Link {
  src: string;
  size?: { scale: number; width: number | undefined; height: number | undefined };
}

const invalid = (message: string) =>
  new KalamoError({
    code: "INVALID_DOCUMENT",
    message,
    hint: "Pass the text of a well-formed SVG file, as Inkscape or kalamo_export writes it.",
    path: "content",
  });

/** pt per unit (CSS Values 4). px is one pt, as Illustrator opens SVG, not Inkscape's 0.75. */
const UNITS: Record<string, number> = {
  "": 1,
  px: 1,
  pt: 1,
  pc: 12,
  in: 72,
  cm: 72 / 2.54,
  mm: 72 / 25.4,
  q: 72 / 101.6,
};

/** A length in pt, or undefined when it is missing, relative (%, em) or not a length. */
export function length(value: string | null | undefined): number | undefined {
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*([a-z]*)\s*$/i.exec(value ?? "");
  const unit = UNITS[(m?.[2] ?? "").toLowerCase()];
  return m && unit !== undefined ? Number(m[1]) * unit : undefined;
}

const elements = (e: Element) =>
  [...(e.childNodes as unknown as Iterable<{ nodeType: number }>)].filter(
    (c): c is Element => c.nodeType === 1,
  );

/** An SVG transform list as one matrix, applied right to left as SVG does. */
export function parseTransform(list: string | null): Matrix {
  let m: Matrix = [...IDENTITY] as Matrix;
  for (const [, fn, args] of (list ?? "").matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const [a = 0, b, c] = numbers(args ?? "");
    const rad = (a * Math.PI) / 180;
    const step: Record<string, () => Matrix> = {
      matrix: () => {
        const m = numbers(args ?? "");
        return (m.length === 6 ? m : Array(6).fill(Number.NaN)) as Matrix;
      },
      translate: () => [1, 0, 0, 1, a, b ?? 0],
      scale: () => [a, 0, 0, b ?? a, 0, 0],
      rotate: () => {
        const [cos, sin] = [Math.cos(rad), Math.sin(rad)];
        const [cx, cy] = [b ?? 0, c ?? 0];
        return [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
      },
      skewX: () => [1, 0, Math.tan(rad), 1, 0, 0],
      skewY: () => [1, Math.tan(rad), 0, 1, 0, 0],
    };
    const make = step[fn ?? ""];
    if (make) m = multiply(m, make());
  }
  return m;
}

/** A writer's rounding, far below what an Illustrator control can enter (ADR-0043). */
const ROUNDING = 1e-6;

/** A matrix that flattens to a line or point, which draws nothing. */
const flat = ([a, b, c, d]: Matrix) => Math.abs(a * d - b * c) < 1e-12;

/** Rotation, uniform scale and reflection, up to a writer's rounding: a Stroke of one width draws them exactly (ADR-0043). */
const similar = ([a, b, c, d]: Matrix) => {
  const tolerance = ROUNDING * (a * a + b * b + c * c + d * d);
  return Math.abs(a * c + b * d) < tolerance && Math.abs(a * a + b * b - c * c - d * d) < tolerance;
};

/** The scale of a move and a uniform scale, up to a writer's rounding (ADR-0017); none for any other matrix. */
const uniformScale = (m: Matrix) => {
  const [a, b, c, d] = m;
  const s = Math.sqrt(Math.abs(a * d - b * c));
  const upright = Math.abs(b) < ROUNDING * s && Math.abs(c) < ROUNDING * s && a > 0 && d > 0;
  return upright && similar(m) ? s : undefined;
};

/** What a leaf that keeps its matrix scales and moves its parameters by. */
const UNBAKED = { k: 1, tx: 0, ty: 0 };

/** One character of a text and what its tspans give it (ADR-0029). */
interface Char {
  char: string;
  style: Style;
  /** The line tspan it sits in, if any, and that line's style: the text's, outside one. */
  line: { el?: Element; style: Style };
  /** The sum of the `baseline-shift` lengths around it, in its text's user units. */
  shift: number;
  /** The `rotate` lists of the elements around it, innermost first, each counting the characters it has given an angle. */
  lists: { angles: number[]; next: number }[];
  rotate?: number;
}

/**
 * Each character's rotation from the nearest `rotate` list, a list's angles indexing `chars`, the
 * characters SVG addresses, its last angle applying past its end (ADR-0029).
 */
function rotate(chars: Char[]) {
  for (const c of chars) {
    // Every list around a character counts it, an inner one's angle winning (SVG 1.1 §10.5).
    for (const l of c.lists) {
      const angle = l.angles[Math.min(l.next++, l.angles.length - 1)];
      c.rotate ??= angle;
    }
  }
}

/** What a nested tspan cannot set on part of a text yet (ADR-0029, ADR-0068). */
const PER_TEXT = [
  "stroke-width",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
];

/**
 * Point Type's alignment (ADR-0077): its `text-anchor` start, middle or end, and justify for
 * `text-align:justify` on a start anchor, as Inkscape writes it.
 */
function pointAlignment(style: Style): Alignment {
  const anchor = style["text-anchor"];
  if (anchor === "middle") return "center";
  if (anchor === "end") return "right";
  return style["text-align"] === "justify" ? "justify" : "left";
}

/** Area Type's alignment (ADR-0077): its `text-align`, else its `text-anchor`. */
function areaAlignment(style: Style): Alignment {
  const align = style["text-align"];
  if (align === "center") return "center";
  if (align === "end" || align === "right") return "right";
  if (align === "justify") return "justify";
  if (align === "start" || align === "left") return "left";
  return pointAlignment({ "text-anchor": style["text-anchor"] ?? "start" });
}

/** The shapes `shape-inside` flows Area Type in (ADR-0078). */
const FRAMES = new Set(["rect", "circle", "ellipse", "polygon", "polyline", "path"]);

/** The id in `url(#id)`, as `clip-path` and `shape-inside` name an element. */
const urlId = (value: string) => /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)$/.exec(value.trim())?.[1];

/**
 * `font-weight` as a CSS weight, 100 to 900 (ADR-0028). `bolder` and `lighter` resolve against 400
 * as CSS Fonts' table does, not against the inherited weight.
 */
function fontWeight(value = "normal") {
  const named: Record<string, number> = { normal: 400, bold: 700, bolder: 700, lighter: 100 };
  const n = named[value.trim().toLowerCase()] ?? Number.parseFloat(value);
  return Number.isFinite(n) ? Math.min(900, Math.max(100, Math.round(n / 100) * 100)) : 400;
}

/** The first family a style's `font-family` names, unquoted, or Source Sans 3 if none. */
const fontFamilyOf = (style: Style) =>
  style["font-family"]
    ?.split(",")[0]
    ?.trim()
    .replace(/^['"]|['"]$/g, "") || BUNDLED_FONT;

/** A style's `font-weight` and `font-style` as a style name (ADR-0028). */
const fontStyleOf = (style: Style) =>
  fontStyleName(
    fontWeight(style["font-weight"]),
    /^(italic|oblique)\b/i.test(style["font-style"] ?? ""),
  );

/**
 * `line-height` as leading in pt (ADR-0022): unitless 1.2, `normal` or none is Auto; another number
 * or percentage is that multiple of the font size; a length scales with the text.
 */
function lineHeight(value: string | undefined, fontSize: number, k: number) {
  const v = value?.trim() ?? "normal";
  const factor = /^[\d.]+$/.test(v)
    ? Number(v)
    : v.endsWith("%")
      ? Number(v.slice(0, -1)) / 100
      : NaN;
  const leading =
    v === "normal" || factor === 1.2
      ? undefined
      : factor
        ? factor * fontSize
        : (length(v) ?? 0) * k;
  return leading && leading > 0 ? round3(leading) : undefined;
}

/**
 * `letter-spacing` as tracking, in thousandths of `fontSize`, a font size in the same user units, so
 * a baked scale needs no scaling (ADR-0029). `normal` is 0.
 */
function trackingOf(style: Style, fontSize: number) {
  const spacing = style["letter-spacing"]?.trim() ?? "normal";
  const em =
    spacing === "normal"
      ? 0
      : /[\d.]em$/.test(spacing)
        ? Number.parseFloat(spacing)
        : (length(spacing) ?? 0) / fontSize;
  return round3(Math.min(10_000, Math.max(-1000, em * 1000)));
}

/**
 * A text without its Range Fills and Strokes, which a `<clipPath>`'s paint never gives it
 * (ADR-0052, ADR-0068).
 */
function unfilled(text: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!text) return text;
  const { ranges, ...rest } = text;
  const kept = unfilledRanges(ranges as CharacterRange[] | undefined, rest);
  return { ...rest, ...(kept && { ranges: kept }) };
}

/** Elements that draw, and those that only define or describe and are skipped without a word. */
const DRAWN = new Set([
  "g",
  "a",
  "switch",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "path",
  "text",
  "image",
]);
/** What a Clipping Path can be: a Live Shape, a Path or a text (ADR-0021, ADR-0052). */
const CLIP_SHAPES = new Set([
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "path",
  "text",
]);
const SILENT = new Set([
  "defs",
  "title",
  "desc",
  "metadata",
  "style",
  "symbol",
  "linearGradient",
  "radialGradient",
  "pattern",
  "clipPath",
  "mask",
  "filter",
  "marker",
]);

/** Where the walk is: the Node children go into, and the matrix from here to the Document. */
interface Context {
  /** A Layer or Group id; null at the root, where loose content goes into a Layer of its own. */
  parentId: string | null;
  /** The parent is the root or a Layer, so an Inkscape layer here is a Layer. */
  layerLevel: boolean;
  matrix: Matrix;
  style: Style;
  /** How many Layers and Groups enclose it. */
  depth: number;
}

/**
 * The deepest Layer and Group nesting Kalamo reads. Deeper files are refused: the walk, and core's
 * walks after it, recurse (REQUIREMENTS §6.7).
 */
export const MAX_DEPTH = 256;

/**
 * A held clip-path: its `<clipPath>`, the one shape or text drawn as its Clipping Path, and the
 * `<use>` that names that shape, which the Clipping Path stands for (ADR-0056).
 */
interface HeldClip {
  el: Element;
  shape: Element;
  use?: Element;
}

/**
 * One paint of a Clipping Path, from a `<g kalamo:paint>` copy (ADR-0051) or an Illustrator paint
 * `<use>` (ADR-0056): the copy read as a leaf, in `style` and `matrix`, and the style its opacity
 * and blend mode come from.
 */
interface ClipPaint {
  fill: boolean;
  looks: Style;
  copy: Element;
  style: Style;
  matrix: Matrix;
  /** An Illustrator `<use>`, which gives only its Fills before the content, its Strokes after. */
  fromUse?: boolean;
}

/** What a `<use>`, `<image>` or gradient links to: SVG 2's `href` before `xlink:href`. */
const hrefOf = (e: Element) =>
  (e.getAttribute("href") || e.getAttributeNS(NS.xlink, "href") || "").trim();

/** An element in the SVG namespace, or in none, that walk draws. */
const drawnSvg = (c: Element) =>
  (c.namespaceURI === NS.svg || c.namespaceURI === null) && DRAWN.has(c.localName ?? "");

/** A `<use>`'s `transform`, then `translate(x, y)`: where its copy's user space sits (SVG 1.1 §5.6). */
const placed = (use: Element): Matrix =>
  multiply(parseTransform(use.getAttribute("transform")), [
    1,
    0,
    0,
    1,
    length(use.getAttribute("x")) ?? 0,
    length(use.getAttribute("y")) ?? 0,
  ]);

/** Identity up to Illustrator's rounding: linear terms within 1e-6, translation within 1e-3 (ADR-0056). */
const nearIdentity = ([a, b, c, d, e, f]: Matrix) =>
  [a - 1, b, c, d - 1].every((v) => Math.abs(v) <= 1e-6) &&
  Math.abs(e) <= 1e-3 &&
  Math.abs(f) <= 1e-3;

const CLIP_USE_PAINT =
  "A <use> painting a Clipping Path out of Illustrator's order was dropped: its Fills come before the clipped content, its Strokes after it (ADR-0056).";

const CLIP_PAINT_ORPHAN =
  "A Clipping Path's <g kalamo:paint> outside a Clipping Mask was dropped: it paints the Clipping Path of the Group it sits in.";

/** A `<g kalamo:stack>`'s Appearance: every paint's Fills, then every paint's Strokes. */
const stacked = (paints: { look: Appearance }[]): Appearance => ({
  fills: paints.flatMap((p) => p.look.fills),
  strokes: paints.flatMap((p) => p.look.strokes),
});

const MISSING =
  "Some linked images came in as missing links, drawn as crossed frames: Kalamo fetches nothing, so it has no pixels for them. Place or embed the image files to see them.";
const UNSIZED =
  "An <image> was dropped: a linked image without width and height has no size until its file is read.";

/** Kalamo's attribute `name`, or the same one in the former name's namespace (ADR-0069). */
const kalamoAttr = (e: Element, name: KalamoAttr) =>
  e.getAttributeNS(NS.kalamo, name) ?? e.getAttributeNS(NS.legacy, name);
/** One paint of a container's Appearance, as export writes it (ADR-0043). */
const isPaint = (e: Element) => kalamoAttr(e, "paint") === "true";
/** A Clipping Path's Fills or Strokes, as export writes them (ADR-0051). */
const isClipPaint = (e: Element) => /^clip-(fill|stroke)$/.test(kalamoAttr(e, "paint") ?? "");
/** Opacity and blend mode from resolved style. */
const looksOf = (style: Style) => {
  const blend = BlendMode.safeParse(style["mix-blend-mode"]);
  return { opacity: alpha(style.opacity), blendMode: blend.success ? blend.data : "normal" };
};

/** The properties every Node has, for `holds`, which checks a Node's own without placing it. */
const PLACED = {
  id: "-",
  name: "",
  parentId: "-",
  index: "a0",
  visible: true,
  locked: false,
  opacity: 1,
  blendMode: "normal",
  transform: IDENTITY,
  tags: [],
  meta: {},
};

const CAPS = ["butt", "round", "square"];
const JOINS = ["miter", "round", "bevel"];

/** Everything one SVG file gives a Document, as the walk builds it. */
class Reader {
  readonly nodes: Node[] = [];
  readonly warnings = new Map<string, Warning>();
  /** Each embedded file, under the key its Images' `src` holds until `resolveImages`. */
  readonly images = new Map<string, ImageFile>();
  readonly links = new Map<string, Link>();
  private readonly keys = new Map<string, string>();
  private readonly last = new Map<string | null, string | null>();
  private readonly ids = new Set<string>();

  /** The Layer loose root content goes into, made at the first such element. */
  private loose: string | undefined;
  /** Children whose clip-path their Group took as its own Clipping Mask (ADR-0056). */
  private readonly unclipped = new WeakSet<Element>();

  constructor(
    private readonly rules: Rule[],
    private readonly byId: Map<string, Element>,
    private readonly artboards: Artboard[],
    private readonly viewport: { width: number; height: number },
  ) {}

  warn(code: string, key: string, message: string, nodeId?: string) {
    const id = `${code} ${key}`;
    if (!this.warnings.has(id)) this.warnings.set(id, { code, message, ...(nodeId && { nodeId }) });
  }

  /** The next sibling index under `parentId`, as createNodes gives them. */
  index(parentId: string | null) {
    const index = generateKeyBetween(this.last.get(parentId) ?? null, null);
    this.last.set(parentId, index);
    return index;
  }

  /** A `z-<ULID>` id comes back as that Node's; any other id is a new Node (ADR-0017). */
  private id(e: Element | null) {
    const kept = idOf(e?.getAttribute("id"));
    if (kept && this.ids.has(kept)) {
      this.warn(
        "DUPLICATE_ID",
        "",
        `Two elements have the id ${xmlId(kept)}; the second is a new Node.`,
      );
    }
    const id = kept && !this.ids.has(kept) ? kept : newId();
    this.ids.add(id);
    return id;
  }

  /** `kalamo:tags` and `kalamo:meta` as export writes them, or empty with a warning. */
  private tagsAndMeta(e: Element | null) {
    const read = (name: "tags" | "meta", ok: (v: unknown) => boolean) => {
      const raw = e && kalamoAttr(e, name);
      if (!raw) return undefined;
      try {
        const v = JSON.parse(raw);
        if (ok(v)) return v;
      } catch {}
      this.warn(
        "INVALID_TAGS_META",
        "",
        `kalamo:${name} is not the JSON export writes; it was dropped.`,
      );
      return undefined;
    };
    const tags = read("tags", (v) => Array.isArray(v) && v.every((t) => typeof t === "string"));
    const meta = read("meta", (v) => !!v && typeof v === "object" && !Array.isArray(v));
    return { tags: (tags ?? []) as string[], meta: (meta ?? {}) as Record<string, unknown> };
  }

  /** The properties every Node has, placed under `parentId`. */
  base(e: Element | null, parentId: string | null, name?: string, style: Style = {}) {
    return {
      id: this.id(e),
      name: name ?? e?.getAttributeNS(NS.inkscape, "label") ?? "",
      parentId,
      index: this.index(parentId),
      visible: style.display !== "none",
      // Inkscape writes "true", older files "1": any value locks.
      locked: e?.hasAttributeNS(NS.sodipodi, "insensitive") ?? false,
      ...looksOf(style),
      transform: [...IDENTITY] as Matrix,
      ...this.tagsAndMeta(e),
    };
  }

  add<T extends Node>(node: T): T {
    this.nodes.push(node);
    return node;
  }

  /** The parent for a Node found at `ctx`: at the root, the Layer for loose content. */
  parent(ctx: Context): string {
    if (ctx.parentId) return ctx.parentId;
    this.loose ??= this.add({ ...this.base(null, null, "Layer 1"), type: "layer" }).id;
    return this.loose;
  }

  walk(e: Element, ctx: Context) {
    if (e.namespaceURI !== NS.svg && e.namespaceURI !== null) return;
    if (SILENT.has(e.localName ?? "")) return;
    if (!DRAWN.has(e.localName ?? "")) {
      this.warn(
        "UNSUPPORTED_ELEMENT",
        e.localName ?? "",
        `<${e.localName}> is not supported yet and was dropped.`,
      );
      return;
    }
    // Its container reads it (containerAppearance); anywhere else it paints nothing Kalamo can hold.
    if (isPaint(e) || isClipPaint(e)) {
      this.warn(
        "UNSUPPORTED_ELEMENT",
        "kalamo:paint",
        isPaint(e)
          ? "A <g kalamo:paint> outside a Layer or Group was dropped: it is the paint of the container it sits in."
          : CLIP_PAINT_ORPHAN,
      );
      return;
    }
    const own = this.own(e);
    if (!own) return;
    const matrix = multiply(ctx.matrix, own);
    const computed = computeStyle(e, ctx.style, this.rules);
    const style = this.unclipped.has(e) ? { ...computed, "clip-path": "none" } : computed;
    const tag = e.localName;
    const stack = kalamoAttr(e, "stack") === "true";
    if (e.getAttributeNS(NS.sodipodi, "type") === "inkscape:box3d") {
      this.warn("BOX3D_AS_PATHS", "", "3D boxes import as a Group of their side Paths.");
    }
    if ((tag === "g" && !stack) || tag === "a" || tag === "switch") {
      if (ctx.depth >= MAX_DEPTH) {
        throw new KalamoError({
          code: "LIMIT_EXCEEDED",
          message: `Groups in the file nest deeper than ${MAX_DEPTH} levels.`,
          hint: "Ungroup the innermost levels in the editor that made the file, then try again.",
          path: "content",
        });
      }
      // A container's mask or filter is lost like a leaf's.
      this.unsupported(e, style);
      const layer = ctx.layerLevel && e.getAttributeNS(NS.inkscape, "groupmode") === "layer";
      // A Layer's or Group's <g kalamo:clipped> is not a Node: its children are the container's, and
      // its clip-path the container's Clipping Mask, written so its Clipping Path's Strokes draw
      // unclipped (ADR-0051, ADR-0053).
      const wrapped = (c: Element) => tag === "g" && kalamoAttr(c, "clipped") === "true";
      const named = (s: Style) =>
        s["clip-path"] && s["clip-path"] !== "none" ? [s["clip-path"]] : [];
      const inner = elements(e)
        .filter(wrapped)
        .flatMap((c) => named(computeStyle(c, style, this.rules)));
      const clips = [...named(style), ...inner];
      if ((clips.length > inner.length && inner.length > 0) || new Set(inner.map(urlId)).size > 1) {
        this.warn(
          "UNSUPPORTED_ATTRIBUTE",
          "clip-path",
          "A Layer or Group clipped by more than one clip-path keeps only the first.",
        );
      }
      const parentId = layer ? ctx.parentId : this.parent(ctx);
      // Kalamo supports no SVG extension, so a <switch> never renders a child that requires one, such
      // as Illustrator's private-data <foreignObject>.
      const kids = elements(e)
        .flatMap((c) => (wrapped(c) ? elements(c) : [c]))
        .filter((c) => tag !== "switch" || !c.hasAttribute("requiredExtensions"));
      const merged = tag === "g" && !layer && !clips.length ? this.merged(kids, style) : undefined;
      const clip = merged?.clip ?? this.clipOf(clips[0]);
      const clipPaints = kids.filter(isClipPaint);
      if (clipPaints.length > 0 && !clip) {
        this.warn("UNSUPPORTED_ELEMENT", "kalamo:paint", CLIP_PAINT_ORPHAN);
      }
      const appearance = this.containerAppearance(kids, matrix, style);
      const node = this.add({
        ...this.base(e, parentId, undefined, style),
        type: layer ? "layer" : "group",
        ...(appearance && { appearance }),
      });
      const paints = clip
        ? [
            ...clipPaints.flatMap((p) => this.clipPaint(p, style, matrix)),
            ...(merged?.paints ?? []).flatMap(({ use, fill }) =>
              this.usePaint(use, fill, clip, style, matrix),
            ),
          ]
        : [];
      for (const c of kids) {
        if (isPaint(c) || isClipPaint(c) || merged?.skipped.has(c)) continue;
        if (!merged && c === clip?.el) this.clipping(clip, node.id, matrix, paints);
        this.walk(c, { parentId: node.id, layerLevel: layer, matrix, style, depth: ctx.depth + 1 });
      }
      // Inkscape's Set Clip puts the clip in <defs>; Illustrator's Clipping Path is on top.
      if (clip && (merged || !kids.includes(clip.el))) {
        this.clipping(clip, node.id, matrix, paints);
      }
      return;
    }
    // An Artboard's background, or the export's background option: not artwork.
    const artboardId = kalamoAttr(e, "artboard");
    if (artboardId) {
      const artboard = this.artboards.find((a) => a.id === artboardId);
      const fill = this.color(style.fill ?? "black", style, style["fill-opacity"]);
      if (artboard && fill) artboard.background = fill;
      return;
    }
    if (kalamoAttr(e, "background")) return;
    let shape: Record<string, unknown> | null;
    let appearance: Appearance | undefined;
    let link: Link | undefined;
    if (tag === "image") {
      ({ shape, link } = this.image(e, matrix) ?? { shape: null });
    } else if (stack) {
      const paints = this.stack(e, style, matrix);
      shape = paints.find((p) => p.shape)?.shape ?? null;
      appearance = stacked(paints);
    } else if (tag === "text") {
      const text = this.text(e, style, matrix);
      shape = text?.shape ?? null;
      appearance = this.appearance(text?.style ?? style, e, matrix);
    } else {
      shape = this.shape(e, matrix, style);
      appearance = this.appearance(style, e, matrix);
    }
    if (!shape || !this.holds({ ...shape, ...(appearance && { appearance }) })) return;
    this.unsupported(e, style);
    // A clipped leaf, as Inkscape's Set Clip writes one, becomes a Clipping Mask of its own.
    const clip = this.clipOf(style["clip-path"]);
    const parentId = clip
      ? this.add({ ...this.base(null, this.parent(ctx)), type: "group" }).id
      : this.parent(ctx);
    const base = this.base(e, parentId, undefined, style);
    // visibility inherits, unlike display, so it hides a leaf rather than its Group.
    if (style.visibility === "hidden" || style.visibility === "collapse") base.visible = false;
    this.add({ ...base, ...shape, ...(appearance && { appearance }) } as Node);
    if (link) this.links.set(base.id, link);
    if (clip) this.clipping(clip, parentId, matrix);
  }

  /**
   * The paints of a `<g kalamo:stack>`, one Node painted several times: its geometry from the first
   * paint, its Fills, then its Strokes, in order (ADR-0017).
   */
  private stack(e: Element, style: Style, matrix: Matrix) {
    return elements(e).flatMap((c) => {
      const paint = this.own(c);
      if (!paint) return [];
      const s = computeStyle(c, style, this.rules);
      const m = multiply(matrix, paint);
      return [{ shape: this.shape(c, m, s), look: this.appearance(s, c, m) }];
    });
  }

  /**
   * `e`'s own transform. An unreadable one is ignored, as SVG does; one that flattens the element
   * to a line or point is null, as it draws nothing and a Node cannot carry it.
   */
  private own(e: Element): Matrix | null {
    const own = parseTransform(e.getAttribute("transform"));
    if (!own.every(Number.isFinite)) {
      this.warn("INVALID_TRANSFORM", "nan", "An unreadable transform was ignored.");
      return [...IDENTITY] as Matrix;
    }
    if (!flat(own)) return own;
    this.warn("INVALID_TRANSFORM", "flat", "An element scaled to nothing was dropped.");
    return null;
  }

  /**
   * Whether a Node can hold `own`, its properties past those every Node has, checked as the file
   * will be. When it cannot, such as a negative width or a font size of 0, it warns once per key
   * and the caller drops the element or paint.
   */
  private holds(own: Record<string, unknown>) {
    try {
      parseNode({ ...PLACED, ...own }, "element");
      return true;
    } catch (error) {
      if (!(error instanceof KalamoError)) throw error;
      this.warn(
        "INVALID_ELEMENT",
        error.data.path ?? "",
        `An element was dropped: ${error.data.message}`,
      );
      return false;
    }
  }

  /**
   * A Layer's or Group's Appearance from its direct `<g kalamo:paint>` children (ADR-0043): each one
   * Fill, else one Stroke, resolved like a leaf's paint; Contents is how many come before the first
   * other child. The outline copies inside are derived from the children and ignored.
   */
  private containerAppearance(kids: Element[], matrix: Matrix, style: Style) {
    // What walk reads: an element it drops without a Node does not end the paints below Contents.
    // A Clipping Path's paint is not one of the container's, and is not counted in Contents.
    const drawn = kids.filter((c) => drawnSvg(c) && !isClipPaint(c));
    const below = drawn.findIndex((c) => !isPaint(c));
    const appearance: ContainerAppearance = { fills: [], strokes: [], contents: 0 };
    drawn.forEach((c, i) => {
      if (!isPaint(c)) return;
      const s = computeStyle(c, style, this.rules);
      // Hidden in the editor, it draws nothing.
      if (s.display === "none") return;
      const own = this.own(c);
      if (!own) return;
      const m = multiply(matrix, own);
      // A container has no matrix, so its Strokes scale, and its gradients map into document
      // coordinates, as node_transform does them.
      const look = this.appearance(s, c, m, scaleOf(m));
      const fill = look.fills[0];
      const stroke = look.strokes[0];
      const paint = fill ?? stroke;
      if (!paint) return;
      const one = { fills: fill ? [fill] : [], strokes: fill ? [] : [paint], contents: 0 };
      if (!this.holds({ type: "group", appearance: one })) return;
      if (fill && appearance.strokes.length) {
        this.warn(
          "UNSUPPORTED_ATTRIBUTE",
          "paint order",
          "A Layer's or Group's Fill above one of its Strokes moved below every Stroke: a Fill cannot sit above a Stroke.",
        );
      }
      if (fill) appearance.fills.push(fill);
      else if (stroke) appearance.strokes.push(stroke);
      if (!fill && stroke && !similar(m)) {
        this.warn(
          "UNSUPPORTED_ATTRIBUTE",
          "container transform",
          "A skewed or unevenly scaled Layer or Group draws its Strokes at one width, as Illustrator does, so they differ from the file's drawing.",
        );
      }
      if (below < 0 || i < below) appearance.contents++;
    });
    return appearance.fills.length + appearance.strokes.length ? appearance : undefined;
  }

  /**
   * The clip a `clip-path` names when Kalamo can hold it as a Clipping Path (ADR-0021, ADR-0053):
   * one Live Shape, Path or text in the referencing element's user space, inline or through one
   * `<use>` of it (ADR-0056). Otherwise the content imports unclipped, with a warning.
   */
  private clipOf(value: string | undefined): HeldClip | undefined {
    if (!value || value === "none") return undefined;
    const id = urlId(value);
    const el = id === undefined ? undefined : this.byId.get(id);
    const inner = el ? elements(el).filter((c) => !SILENT.has(c.localName ?? "")) : [];
    const [only] = inner;
    const use = only?.localName === "use" ? only : undefined;
    // One step: a target that is itself a <use>, or the <clipPath>, is no shape.
    const shape = use ? this.target(use) : only;
    const plain = (v: string | null) => v === null || length(v) !== undefined;
    const holds =
      el?.localName === "clipPath" &&
      el.getAttribute("clipPathUnits") !== "objectBoundingBox" &&
      !el.getAttribute("clip-path") &&
      inner.length === 1 &&
      !!shape &&
      CLIP_SHAPES.has(shape.localName ?? "") &&
      // Type on a Path is not a Node yet.
      shape.getElementsByTagName("textPath").length === 0 &&
      (!use ||
        (!this.clipName(use) &&
          !this.clipName(shape) &&
          plain(use.getAttribute("x")) &&
          plain(use.getAttribute("y"))));
    if (holds) return { el, shape, ...(use && { use }) };
    this.warn(
      "UNSUPPORTED_ATTRIBUTE",
      "clip-path",
      "A clip-path Kalamo cannot hold (a missing reference, objectBoundingBox units, anything but one shape, path or text inside, or a <use> that does not point to one shape, path or text in this file) was dropped; the artwork imports unclipped.",
    );
    return undefined;
  }

  /** The `<clipPath>` id `c`'s own clip-path names, if any. */
  private clipName(c: Element, parent: Style = {}) {
    return urlId(computeStyle(c, parent, this.rules)["clip-path"] ?? "");
  }

  /** The element `e`'s href names by a same-file `#id`, if any. */
  private target(e: Element) {
    const href = hrefOf(e);
    return href.startsWith("#") ? this.byId.get(href.slice(1)) : undefined;
  }

  /**
   * Illustrator's Clip Group (ADR-0056): a `<g>` whose drawn children all name one holdable
   * `<clipPath>`, each at identity up to rounding, is clipped by it itself, and its children are
   * not. Through a `<use>` clip, a sibling `<use>` of the same shape at the same place paints the
   * Clipping Path: its Fills before the first child, its Strokes after the last. One between them
   * is dropped with a warning. Undefined when the children do not merge.
   */
  private merged(kids: Element[], style: Style) {
    const drawn = kids.filter((c) => drawnSvg(c) && !isPaint(c) && !isClipPaint(c));
    const names = drawn.map((c) => computeStyle(c, style, this.rules)["clip-path"] ?? "");
    const [name = ""] = names;
    const one = urlId(name);
    if (
      one === undefined ||
      names.some((n) => urlId(n) !== one) ||
      !drawn.every((c) => nearIdentity(parseTransform(c.getAttribute("transform"))))
    ) {
      return undefined;
    }
    const clip = this.clipOf(name);
    if (!clip) return undefined;
    for (const c of drawn) this.unclipped.add(c);
    const first = kids.indexOf(drawn[0] as Element);
    const last = kids.indexOf(drawn.at(-1) as Element);
    const at =
      clip.use && multiply(parseTransform(clip.el.getAttribute("transform")), placed(clip.use));
    const uses = kids.filter(
      (c) =>
        at &&
        c.localName === "use" &&
        (c.namespaceURI === NS.svg || c.namespaceURI === null) &&
        this.target(c) === clip.shape &&
        !this.clipName(c, style) &&
        placed(c).every((v, i) => Math.abs(v - (at[i] ?? 0)) <= ROUNDING),
    );
    const paints: { use: Element; fill: boolean }[] = [];
    for (const use of uses) {
      const i = kids.indexOf(use);
      if (i < first || i > last) paints.push({ use, fill: i < first });
      else this.warn("UNSUPPORTED_ATTRIBUTE", "clip-path paint", CLIP_USE_PAINT);
    }
    return { clip, paints, skipped: new Set(uses) };
  }

  /**
   * The Clipping Path of `parentId` from the one shape or text in `clip`, drawn in `matrix`'s
   * space. Its Appearance, opacity and blend mode come only from its Group's clip paint groups, each
   * read from its copy as a leaf's (ADR-0051): the element inside a <clipPath> is never drawn, and
   * Inkscape's Set Clip leaves the clipped object's old style on it. So a text's Range Fills come
   * from its Fill copy, by character index (ADR-0052).
   */
  private clipping(clip: HeldClip, parentId: string, matrix: Matrix, paints: ClipPaint[] = []) {
    const { el, shape: e, use } = clip;
    // A <use>'s shape is read as if copied in its place: it inherits from the <use> (ADR-0056).
    const outer = computeStyle(el, {}, this.rules);
    const style = computeStyle(e, use ? computeStyle(use, outer, this.rules) : outer, this.rules);
    const m = [
      parseTransform(el.getAttribute("transform")),
      ...(use ? [placed(use)] : []),
      parseTransform(e.getAttribute("transform")),
    ].reduce(multiply, matrix);
    // Inside a <clipPath> SVG reads clip-rule, never fill-rule.
    const shape =
      e.localName === "text"
        ? unfilled(this.text(e, style, m)?.shape)
        : this.shape(e, m, { ...style, "fill-rule": style["clip-rule"] ?? "nonzero" });
    if (!shape) {
      // ponytail: Kalamo clips a text of only spaces everything away, but import holds no such
      // text; keep it as a Clipping Path if files with one turn up.
      if (e.localName === "text") {
        this.warn(
          "UNSUPPORTED_ATTRIBUTE",
          "clip-path",
          "A clip-path whose text draws no character was dropped; the artwork imports unclipped.",
        );
      }
      return;
    }
    const appearance: Appearance = { fills: [], strokes: [] };
    let looks: Style | undefined;
    // The Range Fills of its Fill's copy and the Range Strokes of its Stroke's (ADR-0068).
    const rangePaints: { fill?: CharacterRange[]; stroke?: CharacterRange[] } = {};
    for (const { fill, looks: s, copy, style: cs, matrix: cm, fromUse } of paints) {
      const look =
        kalamoAttr(copy, "stack") === "true"
          ? stacked(this.stack(copy, cs, cm))
          : this.appearance(cs, copy, cm);
      if (fromUse && (fill ? look.strokes : look.fills).length) {
        this.warn("UNSUPPORTED_ATTRIBUTE", "clip-path paint", CLIP_USE_PAINT);
      }
      if (fill) appearance.fills.push(...look.fills);
      else appearance.strokes.push(...look.strokes);
      const t =
        copy.localName === "text" ? copy : elements(copy).find((c) => c.localName === "text");
      const list = fill ? "fill" : "stroke";
      if (e.localName === "text" && t && !rangePaints[list]) {
        const ts = t === copy ? cs : computeStyle(t, cs, this.rules);
        const ranges = this.text(t, ts, t === copy ? cm : multiply(cm, this.own(t) ?? IDENTITY))
          ?.shape.ranges as CharacterRange[] | undefined;
        rangePaints[list] = (ranges ?? []).flatMap(({ start, end, [list]: paint }) =>
          paint ? [{ start, end, [list]: paint }] : [],
        );
      }
      looks ??= s;
    }
    const painted = [...(rangePaints.fill ?? []), ...(rangePaints.stroke ?? [])];
    if (painted.length) {
      const ranges = canonicalRanges(
        [...((shape.ranges as CharacterRange[]) ?? []), ...painted],
        "ranges",
        shape,
      );
      Object.assign(shape, { ranges });
    }
    // SVG draws nothing through a hidden clip path, and a Clipping Path is never hidden.
    // One the Node cannot hold leaves the content unclipped.
    if (!this.holds({ ...shape, appearance, clipping: true })) return;
    const base = {
      ...this.base(use ?? e, parentId, undefined, style),
      visible: true,
      ...looksOf(looks ?? {}),
    };
    this.add({ ...base, ...shape, appearance, clipping: true } as Node);
  }

  /** A `<g kalamo:paint="clip-fill">` or `"clip-stroke"` as the paint its copy gives (ADR-0051). */
  private clipPaint(p: Element, style: Style, matrix: Matrix): ClipPaint[] {
    const s = computeStyle(p, style, this.rules);
    const own = this.own(p);
    const [copy] = elements(p).filter((c) => DRAWN.has(c.localName ?? ""));
    if (s.display === "none" || !own || !copy) return [];
    const at = this.own(copy);
    if (!at) return [];
    return [
      {
        fill: kalamoAttr(p, "paint") === "clip-fill",
        looks: s,
        copy,
        style: computeStyle(copy, s, this.rules),
        matrix: multiply(multiply(matrix, own), at),
      },
    ];
  }

  /** An Illustrator paint `<use>` as the paint of its shape copied in its place (ADR-0056). */
  private usePaint(
    u: Element,
    fill: boolean,
    clip: HeldClip,
    style: Style,
    matrix: Matrix,
  ): ClipPaint[] {
    const s = computeStyle(u, style, this.rules);
    const at = this.own(clip.shape);
    if (s.display === "none" || !at) return [];
    return [
      {
        fill,
        looks: s,
        copy: clip.shape,
        style: computeStyle(clip.shape, s, this.rules),
        matrix: multiply(multiply(matrix, placed(u)), at),
        fromUse: true,
      },
    ];
  }

  /** What a leaf's style asks for that Kalamo draws without: warned, then left out. */
  private unsupported(e: Element, style: Style) {
    for (const p of ["mask", "filter", "marker-start", "marker-mid", "marker-end"]) {
      if (style[p] && style[p] !== "none") {
        this.warn(
          "UNSUPPORTED_ATTRIBUTE",
          p,
          `${p} is not supported yet; the artwork imports without it.`,
        );
      }
    }
    if (e.hasAttributeNS(NS.inkscape, "path-effect")) {
      this.warn(
        "PATH_EFFECT_FLATTENED",
        "",
        "Live Path Effects import as the Path they draw; the effect is dropped.",
      );
    }
  }

  /**
   * A text element's characters, one per code point: its text and its tspans', not a `<title>` or
   * `<desc>` inside it. Baseline shifts add up down the tspans, as SVG draws them, and each
   * character holds the `rotate` lists around it for `rotate` (ADR-0029).
   */
  private chars(e: Element, style: Style, shift: number, line: Char["line"]): Char[] {
    const out: Char[] = [];
    for (const c of Array.from(e.childNodes)) {
      if (c.nodeType === 3 || c.nodeType === 4) {
        for (const char of c.nodeValue ?? "") out.push({ char, style, line, shift, lists: [] });
      } else if ((c as Element).localName === "tspan") {
        const t = c as Element;
        const s = computeStyle(t, style, this.rules);
        const isLine = e.localName === "text" && t.getAttributeNS(NS.sodipodi, "role") === "line";
        out.push(...this.chars(t, s, shift + this.shift(s), isLine ? { el: t, style: s } : line));
      }
    }
    const angles = numbers(e.getAttribute("rotate")).filter(Number.isFinite);
    if (angles.length) {
      const list = { angles, next: 0 };
      for (const c of out) c.lists.push(list);
    }
    return out;
  }

  /** A tspan's own `baseline-shift` as a length; super, sub and percentages warn and count 0. */
  private shift(s: Style) {
    const v = s["baseline-shift"];
    if (!v || v === "baseline") return 0;
    const shift = length(v);
    if (shift === undefined) {
      this.warn(
        "UNSUPPORTED_ATTRIBUTE",
        "baseline-shift",
        `baseline-shift ${v} is not supported yet, only a length; those characters import on the baseline.`,
      );
    }
    return shift ?? 0;
  }

  /**
   * A character's range fill or stroke: its solid paint where it differs from the text's own
   * (ADR-0029, ADR-0068).
   */
  private rangePaint(list: "fill" | "stroke", s: Style, own: Style): string | undefined {
    const unset = list === "fill" ? "black" : "none";
    const opacity = `${list}-opacity`;
    const [paint, ownPaint] = [s[list] ?? unset, own[list] ?? unset];
    if (paint === ownPaint && s[opacity] === own[opacity]) return undefined;
    if (paint.trim() === "none" && ownPaint.trim() === "none") return undefined;
    const color = this.color(paint, s, s[opacity]);
    const unpainted =
      ownPaint.trim() === "none" || (list === "stroke" && (length(own["stroke-width"]) ?? 1) <= 0);
    if (!color || unpainted) {
      const List = list === "fill" ? "Fill" : "Stroke";
      this.warn(
        "UNSUPPORTED_ATTRIBUTE",
        `tspan ${list}`,
        `A gradient or none as the ${list} of part of a text, or any ${list} on part of a text with no ${List}, is not supported yet; those characters import in the text's own paint.`,
      );
      return undefined;
    }
    return color === this.color(ownPaint, own, own[opacity]) ? undefined : color;
  }

  /**
   * The Character Ranges of a text's characters, `undefined` standing for a joining return, against
   * `text`'s own attributes and `own`, the style they come from (ADR-0029, ADR-0068).
   */
  private ranges(chars: (Char | undefined)[], own: Style, k: number, text: OwnAttributes) {
    const ranges = chars.flatMap((c, i) => {
      if (!c) return [];
      for (const p of PER_TEXT) {
        if (c.style[p] !== c.line.style[p]) {
          this.warn(
            "UNSUPPORTED_ATTRIBUTE",
            `tspan ${p}`,
            `${p} on part of a text is not supported yet; those characters import in the text's own.`,
          );
        }
      }
      const size = length(c.style["font-size"]);
      if (size === undefined && c.style["font-size"] !== own["font-size"]) {
        this.warn(
          "UNSUPPORTED_ATTRIBUTE",
          "tspan font-size",
          `font-size ${c.style["font-size"]} on part of a text is not supported yet, only a length, a percentage or em; those characters import in the text's own size.`,
        );
      }
      const fill = this.rangePaint("fill", c.style, own);
      const stroke = this.rangePaint("stroke", c.style, own);
      return [
        {
          start: i,
          end: i + 1,
          ...(fill && { fill }),
          ...(stroke && { stroke }),
          ...(c.shift && { baselineShift: round3(c.shift * k) }),
          ...(c.rotate && { rotation: round3(c.rotate % 360) }),
          ...(size !== undefined && { fontSize: round3(size * k) }),
          tracking: trackingOf(c.style, size ?? length(own["font-size"]) ?? 12),
          fontStyle: fontStyleOf(c.style),
          fontFamily: fontFamilyOf(c.style),
        },
      ];
    });
    return canonicalRanges(ranges, "ranges", text);
  }

  /**
   * A `<text>` as one text Node and the style its characters take (ADR-0022): Area Type when it
   * flows in a frame, else Point Type from Inkscape's line tspans or the whole text as one line.
   */
  private text(e: Element, style: Style, m: Matrix) {
    const bake = this.bake(e, m);
    const { k, tx, ty } = bake ?? UNBAKED;
    const tspans = elements(e).filter(
      (c) => c.localName === "tspan" && c.getAttributeNS(NS.sodipodi, "role") === "line",
    );
    const [line] = tspans;
    const own = line ? computeStyle(line, style, this.rules) : style;
    const fontSize = round3((length(own["font-size"]) ?? 12) * k);
    const leading = lineHeight(own["line-height"], fontSize, k);
    const fontStyle = fontStyleOf(own);
    const tracking = trackingOf(own, length(own["font-size"]) ?? 12);
    const text = {
      type: "text",
      fontFamily: fontFamilyOf(own),
      fontStyle,
      fontSize,
      ...(leading !== undefined && { leading }),
      ...(tracking && { tracking }),
      transform: bake ? [...IDENTITY] : round(m),
    };
    // Returns are kept where white-space keeps them; control characters and separators Kalamo cannot
    // lay out draw as spaces, as SVG draws them. Collapsed, a run of whitespace keeps its first
    // character, and with it that character's attributes.
    const pre = /^(pre|pre-wrap|pre-line|break-spaces)$/.test(style["white-space"] ?? "");
    const preserve = pre || e.getAttribute("xml:space") === "preserve";
    const control = pre ? /[^\P{Cc}\n]|[\u2028\u2029]/u : /[\p{Cc}\u2028\u2029]/u;
    const clean = (list: Char[]) => {
      const out: Char[] = [];
      list.forEach((c, i) => {
        if (c.char === "\r" && list[i + 1]?.char === "\n") return;
        const char = c.char === "\r" ? "\n" : c.char;
        const kept = { ...c, char: control.test(char) ? " " : char };
        const space = /\s/.test(kept.char);
        if (preserve) out.push(kept);
        else if (!space) out.push(kept);
        else if (out.length && !/\s/.test(out.at(-1)?.char ?? "")) out.push({ ...kept, char: " " });
      });
      if (!preserve && out.at(-1)?.char === " ") out.pop();
      return out;
    };
    const joined = (list: Char[]) => list.map((c) => c.char).join("");
    const all = this.chars(e, style, 0, { style });
    // A rotate list indexes the characters SVG addresses: preserved, every one; collapsed, those left.
    if (preserve) rotate(all);
    const frame = this.frame(style);
    // One alignment per text (ADR-0077): the first line's, a later line that differs warning once.
    const alignment = frame ? areaAlignment(style) : pointAlignment(own);
    if (!frame) {
      for (const t of tspans.slice(1)) {
        const other = computeStyle(t, style, this.rules);
        if (pointAlignment(other) === alignment) continue;
        const p = other["text-anchor"] !== own["text-anchor"] ? "text-anchor" : "text-align";
        this.warn(
          "UNSUPPORTED_ATTRIBUTE",
          p,
          `${p} differs between the lines of one text, which has one alignment; every line takes the first line's.`,
        );
        break;
      }
    }
    const aligned = alignment === "left" ? {} : { alignment };
    if (frame) {
      // The layout is recomputed from the characters; Inkscape's positioned lines are its fallback.
      // A shaped frame bakes as the text's parameters do, and its bounds follow (ADR-0078).
      const bounds =
        "segments" in frame
          ? shapedFrame(transformSegments(frame.segments, [k, 0, 0, k, tx, ty]), "shape-inside")
          : {
              x: round3(k * frame.rect.x + tx),
              y: round3(k * frame.rect.y + ty),
              width: round3(k * frame.rect.width),
              height: round3(k * frame.rect.height),
            };
      const chars = clean(all);
      if (!preserve) rotate(chars);
      const content = joined(chars);
      if (!content.trim()) return null;
      const ranges = this.ranges(chars, own, k, text);
      const shape = {
        ...text,
        kind: "area",
        ...bounds,
        content,
        ...aligned,
        ...(ranges && { ranges }),
      };
      return { shape, style };
    }
    const lines = tspans.length
      ? tspans.map((t) => clean(all.filter((c) => c.line.el === t)))
      : [clean(all)];
    if (!preserve) rotate(lines.flat());
    const content = lines.map(joined).join("\n");
    if (!content.trim()) return null;
    const first = (name: string) =>
      numbers(line?.getAttribute(name) ?? null)[0] ?? numbers(e.getAttribute(name))[0] ?? 0;
    const x = k * first("x") + tx;
    const ranges = this.ranges(
      lines.flatMap((l, i) => (i ? [undefined, ...l] : l)),
      own,
      k,
      text,
    );
    const y = round3(k * first("y") + ty);
    const shape = {
      ...text,
      kind: "point",
      x: round3(x),
      y,
      content,
      ...aligned,
      ...(ranges && { ranges }),
    };
    return { shape, style: own };
  }

  /**
   * The frame a text's `shape-inside` names, in the text's user space: an untransformed `<rect>` as
   * a rectangle (ADR-0022); any other rect, circle, ellipse, polygon, polyline ending where it starts,
   * or path closed with Z, as its outline through its own transform (ADR-0078). Undefined for Point
   * Type, and, with a warning, for a missing reference, an open shape, an evenodd shape whose holes
   * a nonzero frame would fill, a `<use>` or a list of shapes.
   */
  private frame(style: Style): { rect: Rect } | { segments: Segment[] } | undefined {
    const value = style["shape-inside"];
    if (!value || value === "none") return undefined;
    const id = urlId(value);
    const el = id === undefined ? undefined : this.byId.get(id);
    const size = (name: string) => length(el?.getAttribute(name) ?? null) ?? 0;
    const transform = el?.getAttribute("transform");
    if (el?.localName === "rect" && !transform && size("width") > 0 && size("height") > 0) {
      return { rect: { x: size("x"), y: size("y"), width: size("width"), height: size("height") } };
    }
    const shape =
      el && FRAMES.has(el.localName ?? "")
        ? this.shape(el, parseTransform(transform ?? null), {})
        : null;
    let segments = shape
      ? transformSegments(shapeSegments(shape as Shape), shape.transform as Matrix)
      : [];
    // A polyline cannot write Z: it is closed when it ends where it starts.
    const [first, last] = [segments[0]?.args, segments.at(-1)?.args.slice(-2)];
    if (el?.localName === "polyline" && first?.[0] === last?.[0] && first?.[1] === last?.[1]) {
      segments = [...segments, { cmd: "Z", args: [] }];
    }
    // An evenodd shape whose holes the nonzero frame would fill is refused (ADR-0078).
    const evenodd = el && computeStyle(el, {}, this.rules)["fill-rule"] === "evenodd";
    if (shape) {
      try {
        shapedFrame(segments, "shape-inside", "INVALID_INPUT", evenodd ? "evenodd" : "nonzero");
        return { segments };
      } catch (e) {
        if (!(e instanceof KalamoError)) throw e;
      }
    }
    this.warn(
      "UNSUPPORTED_ATTRIBUTE",
      "shape-inside",
      "shape-inside flows text only in one closed rect, circle, ellipse, polygon, polyline or path: naming nothing, an open shape, an evenodd shape with holes, a <use> or several shapes, it imports as Point Type.",
    );
    return undefined;
  }

  /**
   * Fills and Strokes from resolved style, SVG's defaults where it says nothing. Widths scale, and
   * gradients move, with `m` when the leaf bakes it into its parameters; a given `scale` scales
   * widths instead, and gradients always move, as a container's do.
   */
  private appearance(style: Style, e: Element, m: Matrix, scale?: number): Appearance {
    const bake = this.bake(e, m);
    const own = bake || scale !== undefined ? m : IDENTITY;
    const k = scale ?? bake?.k ?? 1;
    const fill = this.paint(style.fill ?? "black", style, style["fill-opacity"], e, own);
    const stroke = this.paint(style.stroke ?? "none", style, style["stroke-opacity"], e, own);
    const width = round3((length(style["stroke-width"]) ?? 1) * k);
    const join = JOINS.includes(style["stroke-linejoin"] ?? "")
      ? style["stroke-linejoin"]
      : SVG_STROKE.join;
    const limit = Number(style["stroke-miterlimit"]);
    let dash = (style["stroke-dasharray"] ?? "none")
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((v) => length(v) ?? Number.NaN);
    if (dash.some((v) => !(v >= 0)) || dash.every((v) => v === 0)) dash = [];
    // An odd list repeats to make it even (SVG 1.1 §11.4).
    if (dash.length % 2) dash = [...dash, ...dash];
    return {
      fills: fill ? [fill] : [],
      strokes:
        stroke && width > 0
          ? [
              {
                ...stroke,
                width,
                cap: (CAPS.includes(style["stroke-linecap"] ?? "")
                  ? style["stroke-linecap"]
                  : SVG_STROKE.cap) as "butt",
                join: join as "miter",
                miterLimit:
                  limit >= 1
                    ? Math.min(limit, 500)
                    : join === SVG_STROKE.join
                      ? SVG_STROKE.miterLimit
                      : MITER_LIMIT,
                dash: dash.map((v) => round3(v * k)),
              },
            ]
          : [],
    };
  }

  /** A colour value, `currentColor` included, with `opacity` folded into its alpha; null for none. */
  private color(value: string, style: Style, opacity: string | undefined): string | null {
    const hex =
      value.trim().toLowerCase() === "currentcolor"
        ? cssColor(style.color ?? "black")
        : cssColor(value);
    return hex && withAlpha(hex, alpha(opacity));
  }

  /**
   * A fill or stroke value as a paint, or null for none: a colour, or a gradient in the leaf's own
   * coordinates, which `own` maps the element's user space into (ADR-0026).
   */
  private paint(
    value: string,
    style: Style,
    opacity: string | undefined,
    e: Element,
    own: Matrix,
  ): Fill | null {
    const url = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)\s*(.*)$/.exec(value.trim());
    if (!url) {
      const hex = this.color(value, style, opacity);
      return hex ? { type: "solid", color: hex } : null;
    }
    // What SVG draws when the paint server cannot be used.
    const fallback = (): Fill | null => {
      const hex = this.color(url[2] || "none", style, opacity);
      return hex ? { type: "solid", color: hex } : null;
    };
    const chain = this.chain(url[1] ?? "");
    if (chain.length > 0) return this.gradient(chain, alpha(opacity), e, style, own, fallback);
    const paint = fallback();
    if (!paint)
      this.warn("UNSUPPORTED_PAINT", "", "Patterns and unknown paint servers are dropped.");
    return paint;
  }

  /** The gradient `id` names and those its `href` chain reaches, nearest first. */
  private chain(id: string): Element[] {
    const out: Element[] = [];
    let g = this.byId.get(id);
    while (g && /^(linear|radial)Gradient$/.test(g.localName ?? "") && !out.includes(g)) {
      out.push(g);
      g = this.target(g);
    }
    return out;
  }

  /**
   * A gradient paint from its `href` chain (ADR-0026): the stops from the nearest gradient that has
   * any, each attribute from the nearest that sets it; every transform folded into the geometry;
   * reflect and repeat unrolled; what SVG draws as one colour made solid.
   */
  private gradient(
    chain: Element[],
    opacity: number,
    e: Element,
    style: Style,
    own: Matrix,
    fallback: () => Fill | null,
  ): Fill | null {
    const attr = (name: string) =>
      chain.map((g) => g.getAttribute(name)).find((v) => v) || undefined;
    const holder = chain.find((g) => elements(g).some((c) => c.localName === "stop"));
    const inherited = holder ? computeStyle(holder, {}, this.rules) : {};
    let last = 0;
    const read = elements(holder ?? (chain[0] as Element))
      .filter((c) => c.localName === "stop")
      .map((stop) => {
        const s = computeStyle(stop, inherited, this.rules);
        const raw = stop.getAttribute("offset")?.trim() || "0";
        const offset = raw.endsWith("%") ? Number.parseFloat(raw) / 100 : Number(raw);
        // Offsets clamp to 0-1 and never decrease (SVG 1.1 §13.2.4).
        last = Math.max(last, Math.min(1, offset || 0));
        const hex = this.color(s["stop-color"] ?? "black", s, "1") ?? "#000000";
        const color = withAlpha(hex, alpha(s["stop-opacity"]) * opacity);
        const m = Number.parseFloat(kalamoAttr(stop, "midpoint") ?? "");
        const midpoint = Math.min(MIDPOINT_MAX, Math.max(MIDPOINT_MIN, m));
        const hasMidpoint = Number.isFinite(m) && midpoint !== 0.5;
        const marked = kalamoAttr(stop, "simulated") === "true";
        return { offset: last, color, ...(hasMidpoint && { midpoint }), marked };
      });
    const { stops, keptInserted } = unmark(read);
    if (keptInserted) {
      const id = holder?.getAttribute("id") ?? "";
      this.warn(
        "MIDPOINT_STOP_KEPT",
        id,
        "Stops Kalamo inserted to draw a midpoint were kept as Color Stops, since the gradient was edited.",
      );
    }
    const [first] = stops;
    const end = stops.at(-1);
    if (!first || !end) return null;
    const solid = (color: string): Fill => ({ type: "solid", color });
    if (stops.length === 1) return solid(first.color);
    const bbox = !attr("gradientUnits") || attr("gradientUnits") === "objectBoundingBox";
    const spread = attr("spreadMethod");
    const box = bbox || spread === "reflect" || spread === "repeat" ? this.bbox(e, style) : null;
    // SVG ignores a bounding-box gradient on a box without area.
    if (bbox && !(box && box.width > 0 && box.height > 0)) return fallback();
    // A percentage is of the box, or of the viewport for userSpaceOnUse; r's of its diagonal / √2.
    const { width: vw, height: vh } = bbox ? { width: 1, height: 1 } : this.viewport;
    const coordinate = (name: string, initial: string, axis: "x" | "y" | "r") => {
      const v = attr(name) ?? initial;
      if (!v.endsWith("%")) return (bbox ? Number(v) : length(v)) || 0;
      const of = axis === "x" ? vw : axis === "y" ? vh : Math.hypot(vw, vh) / Math.SQRT2;
      return (Number.parseFloat(v) / 100) * of;
    };
    let g: Geometry;
    if (chain[0]?.localName === "linearGradient") {
      const p1 = { x: coordinate("x1", "0%", "x"), y: coordinate("y1", "0%", "y") };
      const p2 = { x: coordinate("x2", "100%", "x"), y: coordinate("y2", "0%", "y") };
      if (p1.x === p2.x && p1.y === p2.y) return solid(end.color);
      g = { type: "linear", p1, p2 };
    } else {
      const c = { x: coordinate("cx", "50%", "x"), y: coordinate("cy", "50%", "y") };
      const r = coordinate("r", "50%", "r");
      if (!(r > 0)) return solid(end.color);
      if (Number(attr("fr") ?? 0)) {
        this.warn("UNSUPPORTED_ATTRIBUTE", "fr", "A radial gradient's fr is drawn as 0.");
      }
      let f = {
        x: attr("fx") ? coordinate("fx", "", "x") : c.x,
        y: attr("fy") ? coordinate("fy", "", "y") : c.y,
      };
      // A focus outside the circle moves onto it, as SVG 1.1 does.
      const out = Math.hypot(f.x - c.x, f.y - c.y) / r;
      if (out > 1) f = { x: c.x + (f.x - c.x) / out, y: c.y + (f.y - c.y) / out };
      g = { type: "radial", c, r, f };
    }
    let space = parseTransform(attr("gradientTransform") ?? null);
    if (bbox && box) space = multiply([box.width, 0, 0, box.height, box.x, box.y], space);
    const [a, b, c, d] = space;
    if (!(Math.abs(a * d - b * c) > 1e-12)) return fallback();
    let placed = stops;
    if ((spread === "reflect" || spread === "repeat") && box) {
      // The element's visible box, its Stroke included, in the gradient's own space.
      const grow =
        style.stroke && style.stroke !== "none" ? (length(style["stroke-width"]) ?? 1) / 2 : 0;
      const back = invert(space);
      const corners = [
        [box.x - grow, box.y - grow],
        [box.x + box.width + grow, box.y - grow],
        [box.x - grow, box.y + box.height + grow],
        [box.x + box.width + grow, box.y + box.height + grow],
      ].map(([x, y]) => {
        const [gx, gy] = applyTo(back, x as number, y as number);
        return { x: gx, y: gy };
      });
      ({ g, stops: placed } = unroll(g, stops, spread, corners));
    }
    return { type: "gradient", gradient: mapGradient(asGradient(g, placed), multiply(own, space)) };
  }

  /** An element's geometric bounding box in its user space, as objectBoundingBox measures it. */
  private bbox(e: Element, style: Style): Rect | null {
    if (e.localName === "g") {
      // A paint group's: its copies' boxes, each through its own transform.
      return union(
        elements(e).map((c) => {
          const box = this.bbox(c, computeStyle(c, style, this.rules));
          const m = parseTransform(c.getAttribute("transform"));
          return box && pathBounds(transformSegments(shapeSegments(frameShape(box)), m));
        }),
      );
    }
    const shape = this.shape(e, IDENTITY, style);
    if (!shape) return null;
    return shape.type === "text"
      ? textBox(shape as unknown as Parameters<typeof textBox>[0])
      : pathBounds(shapeSegments(shape as unknown as Shape));
  }

  /**
   * An Inkscape star or polygon that a Live Shape holds (ADR-0017, ADR-0024): its centre and its
   * parameters. Anything else reads as the Path its d draws.
   */
  private star(e: Element) {
    if (e.getAttributeNS(NS.sodipodi, "type") !== "star") return undefined;
    const at = (name: string) => Number(e.getAttributeNS(NS.sodipodi, name));
    const ink = (name: string) => Number(e.getAttributeNS(NS.inkscape, name) || 0);
    const params = { cx: at("cx"), cy: at("cy") };
    const shape = starOf({
      sides: at("sides"),
      r1: at("r1"),
      r2: at("r2"),
      arg1: at("arg1"),
      arg2: at("arg2"),
      flat: e.getAttributeNS(NS.inkscape, "flatsided") === "true",
      rounded: ink("rounded"),
      randomized: ink("randomized"),
    });
    const sides = shape.type === "polygon" ? shape.sides : shape.points;
    const valid =
      Number.isInteger(sides) &&
      sides >= 3 &&
      sides <= 1000 &&
      // The file's own angles: angle and twist are rounded, which turns NaN into 0.
      [params.cx, params.cy, at("arg1"), shape.type === "star" ? at("arg2") : 0].every(
        Number.isFinite,
      ) &&
      at("r1") >= 0 &&
      at("r2") >= 0 &&
      Math.abs(shape.rounded) <= 10 &&
      Math.abs(shape.randomized) <= 10 &&
      // A polygon keeps no r2, so it cannot jitter by an r2 larger than its radius.
      !(shape.type === "polygon" && shape.randomized && at("r2") > at("r1"));
    if (!valid) {
      this.warn(
        "STAR_AS_PATH",
        "",
        "A star with parameters Kalamo cannot hold imports as the Path its d draws.",
      );
      return undefined;
    }
    return { ...params, shape };
  }

  /**
   * An Inkscape arc that an ellipse holds (ADR-0025): its centre, radii, angles and arc type, as
   * Inkscape reads them, a missing number 0. Anything else reads as the Path its d draws.
   */
  private arc(e: Element) {
    if (e.getAttributeNS(NS.sodipodi, "type") !== "arc") return undefined;
    const at = (name: string) => Number(e.getAttributeNS(NS.sodipodi, name));
    const [cx = 0, cy = 0, rx = 0, ry = 0, start = 0, end = 0] = [
      "cx",
      "cy",
      "rx",
      "ry",
      "start",
      "end",
    ].map(at);
    if (![cx, cy, rx, ry, start, end].every(Number.isFinite) || !(rx >= 0 && ry >= 0)) {
      this.warn(
        "ARC_AS_PATH",
        "",
        "An arc with parameters Kalamo cannot hold imports as the Path its d draws.",
      );
      return undefined;
    }
    return {
      cx,
      cy,
      rx,
      ry,
      ...arcOf({
        start,
        end,
        type: e.getAttributeNS(NS.sodipodi, "arc-type") || null,
        open: e.getAttributeNS(NS.sodipodi, "open") === "true",
      }),
    };
  }

  /**
   * An Inkscape spiral that a Live Shape holds (ADR-0060): its parameters, a missing one Inkscape's
   * default. One Inkscape would clamp reads as the Path its d draws, which is what Inkscape draws.
   */
  private spiral(e: Element) {
    if (e.getAttributeNS(NS.sodipodi, "type") !== "spiral") return undefined;
    const at = (name: string, fallback: number) => {
      const v = e.getAttributeNS(NS.sodipodi, name);
      return v === null || v === "" ? fallback : Number(v);
    };
    const p = {
      cx: at("cx", 0),
      cy: at("cy", 0),
      radius: at("radius", 1),
      revolution: at("revolution", 3),
      expansion: at("expansion", 1),
      argument: at("argument", 0),
      t0: at("t0", 0),
    };
    const valid =
      Object.values(p).every(Number.isFinite) &&
      p.radius >= 0 &&
      p.revolution >= 0.05 &&
      p.revolution <= 1024 &&
      p.expansion >= 0 &&
      p.expansion <= 1000 &&
      p.t0 >= 0 &&
      p.t0 <= 0.999;
    if (!valid) {
      this.warn(
        "SPIRAL_AS_PATH",
        "",
        "A spiral with parameters Kalamo cannot hold imports as the Path its d draws.",
      );
      return undefined;
    }
    return spiralOf(p);
  }

  /**
   * The scale and move a leaf's matrix bakes into its parameters (ADR-0017), or none when it keeps
   * the matrix. A randomized star's never bakes: its jitter is seeded from its parameters, so
   * moving or scaling them re-rolls it (ADR-0024).
   */
  private bake(e: Element, m: Matrix) {
    if (e.localName === "path" && this.star(e)?.shape.randomized) return undefined;
    const k = uniformScale(m);
    return k === undefined ? undefined : { k, tx: m[4], ty: m[5] };
  }

  /**
   * An `<image>`'s parameters: its frame, baked as a rect's, and an embedded file under a key of
   * this read (ADR-0023), or a linked file's href and `kalamo:src` (ADR-0042). One Kalamo cannot hold
   * is dropped with a warning.
   */
  private image(e: Element, m: Matrix): { shape: Record<string, unknown>; link?: Link } | null {
    const href = hrefOf(e);
    const w = length(e.getAttribute("width"));
    const h = length(e.getAttribute("height"));
    const bake = this.bake(e, m);
    const { k, tx, ty } = bake ?? UNBAKED;
    const frame = (width: number, height: number) => ({
      type: "image",
      x: round3(k * (length(e.getAttribute("x")) ?? 0) + tx),
      y: round3(k * (length(e.getAttribute("y")) ?? 0) + ty),
      width: round3(k * width),
      height: round3(k * height),
      // Absent, SVG's default, not Kalamo's none.
      preserveAspectRatio:
        preserveAspectRatio(e.getAttribute("preserveAspectRatio") ?? "") ?? "xMidYMid meet",
      transform: bake ? [...IDENTITY] : round(m),
    });
    const drop = (message: string) => {
      this.warn("INVALID_IMAGE", "", `An <image> was dropped: ${message}`);
      return null;
    };
    if (!href.startsWith("data:")) {
      const problem = fileProblem(href);
      if (problem) return drop(problem);
      // SVG draws nothing for an image with no area.
      if ((w ?? 1) <= 0 || (h ?? 1) <= 0) return null;
      const src = kalamoAttr(e, "src") ?? "";
      const offered = IMAGE_ID.test(src);
      const sized = w !== undefined && h !== undefined;
      if (!sized && !offered) {
        this.warn("INVALID_IMAGE", "", UNSIZED);
        return null;
      }
      const shape = { ...frame(w ?? 1, h ?? 1), file: href };
      if (!this.holds(shape)) return null;
      // Missing until resolveLinks finds its pixels, so a read that skips it still warns.
      this.warn("IMAGE_LINK_MISSING", "", MISSING);
      if (!offered) return { shape };
      return { shape, link: { src, ...(!sized && { size: { scale: k, width: w, height: h } }) } };
    }
    let file: ImageFile;
    try {
      file = readImage(href, "src");
    } catch (err) {
      if (!(err instanceof KalamoError)) throw err;
      return drop(err.data.message);
    }
    const width = w ?? file.width;
    const height = h ?? file.height;
    if (!(width > 0 && height > 0)) return null;
    // Checked before its file is kept, which no Image would then use.
    if (!this.holds({ ...frame(width, height), src: "-" })) return null;
    let src = this.keys.get(href);
    if (src === undefined) {
      src = `pending:${this.keys.size}`;
      this.keys.set(href, src);
    }
    this.images.set(src, file);
    return { shape: { ...frame(width, height), src } };
  }

  /** A shape element's parameters in document coordinates, with the transform it keeps. */
  private shape(e: Element, m: Matrix, style: Style): Record<string, unknown> | null {
    if (e.localName === "text") return this.text(e, style, m)?.shape ?? null;
    const star = e.localName === "path" ? this.star(e) : undefined;
    const num = (name: string) => length(e.getAttribute(name)) ?? 0;
    const bake = this.bake(e, m);
    const { k, tx, ty } = bake ?? UNBAKED;
    const x = (v: number) => round3(k * v + tx);
    const y = (v: number) => round3(k * v + ty);
    const size = (v: number) => round3(k * v);
    const transform = bake ? [...IDENTITY] : round(m);
    const path = (segments: Segment[]) => ({
      type: "path",
      d: formatPath(bake ? transformSegments(segments, m) : segments),
      // Only a Path keeps it: a Live Shape's or a text's outline never crosses itself (ADR-0018).
      fillRule: style["fill-rule"] === "evenodd" ? "evenodd" : "nonzero",
      transform,
    });
    switch (e.localName) {
      case "rect": {
        const rx = length(e.getAttribute("rx")) ?? length(e.getAttribute("ry")) ?? 0;
        const ry = length(e.getAttribute("ry")) ?? rx;
        return {
          type: "rect",
          x: x(num("x")),
          y: y(num("y")),
          width: size(num("width")),
          height: size(num("height")),
          radius: size(Math.min(rx, ry)),
          transform,
        };
      }
      case "circle":
      case "ellipse": {
        const rx = e.localName === "circle" ? num("r") : num("rx");
        const ry = e.localName === "circle" ? num("r") : num("ry");
        return {
          type: "ellipse",
          x: x(num("cx") - rx),
          y: y(num("cy") - ry),
          width: size(2 * rx),
          height: size(2 * ry),
          transform,
        };
      }
      case "line":
        return {
          type: "line",
          x1: x(num("x1")),
          y1: y(num("y1")),
          x2: x(num("x2")),
          y2: y(num("y2")),
          transform,
        };
      case "polyline":
      case "polygon": {
        const p = numbers(e.getAttribute("points"));
        if (p.length < 4) return null;
        const segments: Segment[] = [];
        for (let i = 0; i + 1 < p.length; i += 2) {
          segments.push({ cmd: i ? "L" : "M", args: [p[i] as number, p[i + 1] as number] });
        }
        if (e.localName === "polygon") segments.push({ cmd: "Z", args: [] });
        return path(segments);
      }
      case "path": {
        const spiral = star ? undefined : this.spiral(e);
        if (spiral) {
          // revolution, expansion and t0 stay as written: 3 decimals of t0 would move the inner end.
          const { cx, cy, radius } = spiral;
          return { ...spiral, cx: x(cx), cy: y(cy), radius: size(radius), transform };
        }
        const arc = star ? undefined : this.arc(e);
        if (arc) {
          const { cx, cy, rx, ry, ...angles } = arc;
          return {
            type: "ellipse",
            x: x(cx - rx),
            y: y(cy - ry),
            width: size(2 * rx),
            height: size(2 * ry),
            ...angles,
            transform,
          };
        }
        if (!star) {
          try {
            return path(normalizePath(e.getAttribute("d") ?? "", "d"));
          } catch (error) {
            if (!(error instanceof KalamoError)) throw error;
            this.warn("INVALID_PATH", "", `A path was dropped: ${error.message}`);
            return null;
          }
        }
        const { cx, cy, shape } = star;
        // A randomized star seeds its jitter from these, so they stay as written (ADR-0024).
        if (shape.randomized) return { ...shape, cx, cy, transform };
        const common = {
          cx: x(cx),
          cy: y(cy),
          angle: round3(shape.angle),
          rounded: round3(shape.rounded),
          transform,
        };
        return shape.type === "polygon"
          ? { ...shape, ...common, radius: size(shape.radius) }
          : {
              ...shape,
              ...common,
              outerRadius: size(shape.outerRadius),
              innerRadius: size(shape.innerRadius),
              twist: round3(shape.twist),
            };
      }
      default:
        return null;
    }
  }
}

/** Reads SVG text into a Document's contents (ADR-0017). */
export function parseSvg(text: string, nameHint?: string): OpenedFile {
  let error: string | undefined;
  let dom: ReturnType<DOMParser["parseFromString"]>;
  try {
    dom = new DOMParser({
      onError: (level, message) => {
        if (level === "warning") return;
        error ??= message.split("\n")[0];
        throw new Error(message);
      },
    }).parseFromString(text, "image/svg+xml");
  } catch (e) {
    throw invalid(`Not well-formed XML: ${error ?? (e as Error).message}`);
  }
  const root = dom.documentElement;
  if (!root || root.localName !== "svg") throw invalid("The file has no <svg> root element.");

  const width = length(root.getAttribute("width"));
  const height = length(root.getAttribute("height"));
  const vb = numbers(root.getAttribute("viewBox"));
  const [vx = 0, vy = 0, vw = 0, vh = 0] = vb;
  const hasViewBox = vb.length === 4 && vw > 0 && vh > 0;
  // User units to pt; the viewBox origin stays where it is, so a Kalamo export's coordinates come
  // back unchanged.
  const scale = hasViewBox
    ? width !== undefined
      ? width / vw
      : height !== undefined
        ? height / vh
        : 1
    : 1;
  const frame = hasViewBox
    ? { x: vx * scale, y: vy * scale, width: vw * scale, height: vh * scale }
    : { x: 0, y: 0, width: width ?? 300, height: height ?? 150 };

  const all = [...(dom.getElementsByTagName("*") as unknown as Iterable<Element>)];
  const rules = stylesheet(
    all
      .filter((e) => e.localName === "style")
      .map((e) => e.textContent ?? "")
      .join("\n"),
  );
  const byId = new Map(
    all.flatMap((e) => (e.getAttribute("id") ? [[e.getAttribute("id") as string, e]] : [])),
  );
  // Inkscape's pages are in user units, like everything else; without any, the viewBox.
  const pages = all.filter((e) => e.namespaceURI === NS.inkscape && e.localName === "page");
  const rect = (r: { x: number; y: number; width: number; height: number }) => ({
    x: round3(r.x),
    y: round3(r.y),
    width: round3(r.width),
    height: round3(r.height),
  });
  const artboards: Artboard[] = pages.length
    ? pages.map((p, i) => {
        const at = (name: string) => (length(p.getAttribute(name)) ?? 0) * scale;
        return {
          id: idOf(p.getAttribute("id")) ?? newId(),
          name: p.getAttributeNS(NS.inkscape, "label") || `Artboard ${i + 1}`,
          frame: rect({ x: at("x"), y: at("y"), width: at("width"), height: at("height") }),
        };
      })
    : [{ id: newId(), name: "Artboard 1", frame: rect(frame) }];
  // In user units, as userSpaceOnUse percentages measure.
  const viewport = hasViewBox
    ? { width: vw, height: vh }
    : { width: width ?? 300, height: height ?? 150 };
  const reader = new Reader(rules, byId, artboards, viewport);
  const matrix: Matrix = [scale, 0, 0, scale, 0, 0];
  const ctx = { parentId: null, layerLevel: true, matrix, style: {}, depth: 0 };
  for (const e of elements(root)) reader.walk(e, ctx);
  // parseDocument wants a Layer at the root, even for a file with nothing in it.
  if (!reader.nodes.some((n) => n.type === "layer" && n.parentId === null)) reader.parent(ctx);

  const title = elements(root)
    .find((e) => e.localName === "title")
    ?.textContent?.trim();
  const docname = root.getAttributeNS(NS.sodipodi, "docname")?.replace(/\.svg$/i, "");
  const hint = nameHint?.replace(/\.(svg|kalamo\.json)$/i, "");
  const name = hint || docname || title || "Untitled";

  // Checked like any .kalamo.json, so an importer bug fails the Open instead of storing a corrupt
  // Document.
  const file = parseDocument(
    JSON.stringify({ version: MIGRATIONS.length + 1, name, artboards, nodes: reader.nodes }),
    MIGRATIONS,
    reader.images,
  );
  const scope = scopeOf(kalamoAttr(root, "scope"));
  return {
    ...file,
    warnings: [...reader.warnings.values()],
    ...(scope && { scope }),
    ...(reader.links.size && { links: reader.links }),
  };
}

/**
 * `file` with each linked Image's `kalamo:src` kept when `lookup` finds that image, the Document it
 * goes into holding it (ADR-0042). The rest are missing links; one without a size is dropped, with
 * the Clipping Mask made for it.
 */
export function resolveLinks(
  file: OpenedFile,
  lookup: (id: string) => ImageInfo | undefined,
): OpenedFile {
  const { links, ...rest } = file;
  if (!links) return file;
  const dropped = new Set<string>();
  const resolved = file.nodes.flatMap((n): Node[] => {
    const link = links.get(n.id);
    if (!link || n.type !== "image") return [n];
    const info = lookup(link.src);
    if (!info) {
      if (link.size) dropped.add(n.id);
      return [n];
    }
    const { size } = link;
    return [
      {
        ...n,
        src: link.src,
        ...(size && {
          width: round3(size.scale * (size.width ?? info.width)),
          height: round3(size.scale * (size.height ?? info.height)),
        }),
      },
    ];
  });
  const kept = resolved.filter((n) => !dropped.has(n.id));
  // A Group left with only its Clipping Path was the Clipping Mask of a dropped Image. A Layer stays
  // (ADR-0053).
  const clipOnly = (g: string) =>
    kept.find((n) => n.id === g)?.type === "group" &&
    kept.some((c) => c.parentId === g) &&
    kept.every((c) => c.parentId !== g || ("clipping" in c && c.clipping));
  const emptied = new Set(
    resolved.flatMap((n) =>
      dropped.has(n.id) && n.parentId && clipOnly(n.parentId) ? [n.parentId] : [],
    ),
  );
  const nodes = kept.filter((n) => !emptied.has(n.id) && !emptied.has(n.parentId ?? ""));
  const missing = nodes.some((n) => n.type === "image" && n.src === undefined);
  const warnings = file.warnings.filter((w) => missing || w.code !== "IMAGE_LINK_MISSING");
  if (dropped.size && !warnings.some((w) => w.code === "INVALID_IMAGE")) {
    warnings.push({ code: "INVALID_IMAGE", message: UNSIZED });
  }
  return { ...rest, nodes, warnings };
}
