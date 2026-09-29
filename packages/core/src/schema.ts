import { z } from "zod";
import { COLOR_PATTERN } from "./color.ts";
import { type ImageInfo, preserveAspectRatio } from "./image.ts";
import { compose, scaleOf } from "./matrix.ts";
import { BUNDLED_FAMILIES_NOTE, BUNDLED_FONT, FONT_STYLES } from "./text.ts";

/**
 * `#RRGGBB` or `#RRGGBBAA`, case-insensitive (REQUIREMENTS §6.5). The published schema carries the
 * pattern, but any value parses so core can answer INVALID_COLOR with a conversion hint instead of
 * a generic INVALID_INPUT.
 */
export const Color = z.unknown().meta({
  type: "string",
  pattern: COLOR_PATTERN,
  description: "#RRGGBB or #RRGGBBAA, e.g. #FF8800.",
});

export const Rect = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type Rect = z.infer<typeof Rect>;

/** What `render` and `export` draw (ADR-0014); omitted, the whole Document. */
export const RenderScope = z.union([
  z.strictObject({ artboardId: z.string() }),
  z.strictObject({ nodeIds: z.array(z.string()).min(1).max(1000) }),
  z.strictObject({
    rect: Rect.extend({ width: z.number().positive(), height: z.number().positive() }),
  }),
]);
export type RenderScope = z.infer<typeof RenderScope>;

export const RenderOverlay = z.enum(["bounds", "ids", "artboards"]);
export type RenderOverlay = z.infer<typeof RenderOverlay>;

const Point = z.strictObject({ x: z.number(), y: z.number() });
export type Point = z.infer<typeof Point>;

export const ColorStop = z.strictObject({
  offset: z.number().min(0).max(1).describe("0 at the gradient's start, 1 at its end."),
  color: Color.describe("#RRGGBB or #RRGGBBAA; the alpha is the stop's opacity."),
});
const stops = z
  .array(ColorStop)
  .min(2)
  .describe("At least 2 Color Stops; beyond the first and last the colour holds.");
const positive = z.number().positive();

/** A gradient's full geometry, in the leaf's own coordinates, before its transform (ADR-0026). */
const linear = { type: z.literal("linear"), stops, start: Point, end: Point };
const radial = {
  type: z.literal("radial"),
  stops,
  center: Point,
  radius: positive,
  aspectRatio: positive,
  angle: z.number(),
  focus: Point,
};

// SVG paints a gradient without length in its last stop's colour and Canvas2D paints nothing.
const distinct = (g: { start?: Point; end?: Point }, ctx: z.RefinementCtx) => {
  if ((g.start === undefined) !== (g.end === undefined)) {
    ctx.addIssue({
      code: "custom",
      message: "start and end come together; leave both out to span the bounds.",
      path: [g.start ? "end" : "start"],
    });
  } else if (g.start && g.end && g.start.x === g.end.x && g.start.y === g.end.y) {
    ctx.addIssue({ code: "custom", message: "end must differ from start.", path: ["end"] });
  }
};

/** A gradient as written; geometry left out comes from the leaf's own bounds. */
export const Gradient = z.discriminatedUnion("type", [
  z
    .strictObject({
      ...linear,
      start: Point.optional().describe("Where the first stop sits. Default: from angle."),
      end: Point.optional().describe("Where the last stop sits; with start or neither."),
      angle: z
        .number()
        .optional()
        .describe(
          "Without start and end: the direction across the bounds, degrees clockwise from 3 o'clock; 0 is left to right, 90 top to bottom. Not stored.",
        ),
    })
    .superRefine(distinct),
  z.strictObject({
    ...radial,
    center: Point.optional().describe("Default: the bounds' centre."),
    radius: positive
      .optional()
      .describe("Where the last stop sits. Default: sqrt((w² + h²) / 8), Illustrator's."),
    aspectRatio: positive.default(1).describe("The radius across angle is radius × aspectRatio."),
    angle: z.number().default(0).describe("Direction of radius, degrees clockwise from 3 o'clock."),
    focus: Point.optional().describe(
      "Where the first stop sits. Default: center; moved onto the ellipse when outside it.",
    ),
  }),
]);
/** A gradient exactly as stored. */
export const StoredGradient = z.discriminatedUnion("type", [
  z.strictObject(linear).superRefine(distinct),
  z.strictObject(radial),
]);
export type ColorStop = { offset: number; color: string };
type Stored<G> = G extends unknown ? Omit<G, "stops"> & { stops: ColorStop[] } : never;
export type Gradient = Stored<z.output<typeof StoredGradient>>;

const solid = { type: z.literal("solid").optional(), color: Color };
const gradient = { type: z.literal("gradient"), gradient: Gradient };
const line = {
  width: z.number().positive().default(1),
  cap: z.enum(["butt", "round", "square"]).default("butt"),
  join: z.enum(["miter", "round", "bevel"]).default("miter"),
  miterLimit: z.number().min(1).max(500).default(10),
  dash: z
    .array(z.number().nonnegative())
    .default([])
    .describe("Alternating dash and gap lengths in pt, e.g. [4, 2]; empty for a solid Stroke."),
};
// `type` is optional, not defaulted: zod refuses a defaulted discriminator. `paint` writes it.
export const Fill = z.discriminatedUnion("type", [z.strictObject(solid), z.strictObject(gradient)]);
export const Stroke = z.discriminatedUnion("type", [
  z.strictObject({ ...solid, ...line }),
  z.strictObject({ ...gradient, ...line }),
]);
/** The same, with every gradient's geometry, as a file stores them. */
export const StoredFill = z.discriminatedUnion("type", [
  z.strictObject(solid),
  z.strictObject({ ...gradient, gradient: StoredGradient }),
]);
export const StoredStroke = z.discriminatedUnion("type", [
  z.strictObject({ ...solid, ...line }),
  z.strictObject({ ...gradient, ...line, gradient: StoredGradient }),
]);

export type AppearanceInput = z.output<typeof AppearanceInput>;
export const AppearanceInput = z.strictObject({
  fills: z.array(Fill).default([]).describe("Painted bottom to top."),
  strokes: z.array(Stroke).default([]).describe("Painted bottom to top, above every Fill."),
});

const contents = z
  .number()
  .int()
  .describe(
    "Where the children sit in the stack: how many paints, counted from the first Fill up through the Strokes, draw below them; 0 to fills + strokes. Default 0, every paint above.",
  );
/** A Layer's or Group's Appearance: it paints every descendant's outline (ADR-0043). */
export type ContainerAppearanceInput = z.output<typeof ContainerAppearanceInput>;
export const ContainerAppearanceInput = AppearanceInput.extend({
  contents: contents.default(0),
});

export type Fill = { type: "solid"; color: string } | { type: "gradient"; gradient: Gradient };
export type Stroke = Fill & Omit<z.output<(typeof Stroke.options)[0]>, "type" | "color">;
export interface Appearance {
  fills: Fill[];
  strokes: Stroke[];
}
/** `contents` of the paints, from the bottom of fills then strokes, draw below the children. */
export interface ContainerAppearance extends Appearance {
  contents: number;
}

export const ArtboardInput = z.strictObject({
  name: z.string().optional(),
  x: z
    .number()
    .optional()
    .describe("Left edge in document coordinates. Default: right of the previous Artboard."),
  y: z.number().default(0),
  width: z.number().positive(),
  height: z.number().positive(),
  background: Color.optional(),
});
export type ArtboardInput = z.input<typeof ArtboardInput>;

export interface Artboard {
  id: string;
  name: string;
  frame: Rect;
  background?: string;
}

const size = z.number().nonnegative();
/** The fewest and most sides a polygon, or points a star, can have. */
export const MIN_COUNT = 3;
export const MAX_COUNT = 1000;
const count = z.number().int().min(MIN_COUNT).max(MAX_COUNT);

/** Live Shape parameters (F-DRAW-01) and a Path's `d`, in document coordinates. */
export const RectShape = z.object({
  type: z.literal("rect"),
  x: z.number(),
  y: z.number(),
  width: size,
  height: size,
  radius: size.default(0).describe("Corner radius, clamped to half the shorter side."),
});
export const EllipseShape = z.object({
  type: z.literal("ellipse"),
  x: z.number().describe("Left edge of the bounding box."),
  y: z.number().describe("Top edge of the bounding box."),
  width: size,
  height: size,
  // Parametric angles, as Inkscape's (ADR-0025); 0 and 360 are one direction, written one way.
  startAngle: z
    .number()
    .min(0)
    .lt(360)
    .default(0)
    .describe("Where a pie starts, degrees clockwise from 3 o'clock; equal to endAngle is whole."),
  endAngle: z
    .number()
    .gt(0)
    .max(360)
    .default(360)
    .describe("Where a pie ends, degrees clockwise from 3 o'clock."),
  arcType: z
    .enum(["slice", "chord", "open"])
    .default("slice")
    .describe("How a pie's ends close: through the center, straight across, or not at all."),
});
export const LineShape = z.object({
  type: z.literal("line"),
  x1: z.number(),
  y1: z.number(),
  x2: z.number(),
  y2: z.number(),
});
/** Inkscape's star and polygon parameters (ADR-0024). */
const inkscape = {
  angle: z
    .number()
    .default(0)
    .describe("Direction of the first vertex, degrees clockwise from straight up."),
  rounded: z
    .number()
    .min(-10)
    .max(10)
    .default(0)
    .describe("Handle length at each vertex as a fraction of the edge; 0 is sharp."),
  randomized: z
    .number()
    .min(-10)
    .max(10)
    .default(0)
    .describe("Vertex jitter as a fraction of the larger radius; 0 is regular."),
};
export const PolygonShape = z.object({
  type: z.literal("polygon"),
  cx: z.number(),
  cy: z.number(),
  radius: size.describe("Center to each vertex."),
  sides: count,
  ...inkscape,
});
export const StarShape = z.object({
  type: z.literal("star"),
  cx: z.number(),
  cy: z.number(),
  outerRadius: size.describe("Center to each point."),
  innerRadius: size.describe("Center to each inner vertex."),
  points: count,
  ...inkscape,
  twist: z
    .number()
    .default(0)
    .describe("Degrees the inner vertices turn clockwise off the half step."),
});
/** The most turns a spiral can have, Inkscape's bound. */
export const MAX_REVOLUTION = 1024;

/** Inkscape's spiral (ADR-0060): r = radius·t^expansion at 2π·revolution·t + argument, t0 ≤ t ≤ 1. */
export const SpiralShape = z.object({
  type: z.literal("spiral"),
  cx: z.number(),
  cy: z.number(),
  radius: size.describe("Center to the outer end."),
  revolution: z
    .number()
    .min(0.05)
    .max(MAX_REVOLUTION)
    .default(3)
    .describe("Turns from the center to the outer end, 0.05 to 1024."),
  expansion: z
    .number()
    .min(0)
    .max(1000)
    .default(1)
    .describe(
      "How the turns spread: 1 evenly, above 1 wider outward, below 1 wider inward; 0 to 1000.",
    ),
  argument: z
    .number()
    .default(0)
    .describe(
      "Direction of the center end, degrees clockwise from 3 o'clock; the turns run clockwise.",
    ),
  t0: z
    .number()
    .min(0)
    .max(0.999)
    .default(0)
    .describe("Where the inner end starts, as a share of the curve from the center, 0 to 0.999."),
});
export const PathShape = z.object({
  type: z.literal("path"),
  d: z.string().describe("SVG path data, absolute M, L, C, Q and Z only, e.g. M 0 0 L 10 0 Z."),
  fillRule: z
    .enum(["nonzero", "evenodd"])
    .default("nonzero")
    .describe(
      "Several subpaths in one d make a Compound Path (ADR-0018): under evenodd every inner subpath is a hole; under nonzero only one that winds the other way.",
    ),
});
export const SHAPES = {
  rect: RectShape,
  ellipse: EllipseShape,
  line: LineShape,
  polygon: PolygonShape,
  star: StarShape,
  spiral: SpiralShape,
  path: PathShape,
};
const { rect, ...others } = SHAPES;
export const Shape = z.discriminatedUnion("type", [rect, ...Object.values(others)]);
export type Shape = z.output<typeof Shape>;

/** Overrides for the characters from `start` up to `end` of a text's content (ADR-0029). */
export const CharacterRange = z.strictObject({
  start: z.number().int().min(0),
  end: z.number().int().min(1),
  fill: Color.optional().describe("Replaces every Fill's paint for these characters."),
  stroke: Color.optional().describe(
    "Replaces every Stroke's paint for these characters; a text with no Stroke draws none.",
  ),
  baselineShift: z.number().optional().describe("In pt, positive up."),
  rotation: z
    .number()
    .min(-360)
    .max(360)
    .optional()
    .describe("Degrees clockwise about each character's baseline origin."),
  tracking: z
    .number()
    .min(-1000)
    .max(10_000)
    .optional()
    .describe("Space after each character in 1/1000 of its own em, -1000 to 10000."),
  fontStyle: z
    .enum(FONT_STYLES)
    .optional()
    .describe("The style name these characters draw in, as the text's fontStyle."),
});
/** A stored Character Range, its fill and stroke parsed to `#RRGGBB` or `#RRGGBBAA`. */
export type CharacterRange = Omit<z.output<typeof CharacterRange>, "fill" | "stroke"> & {
  fill?: string;
  stroke?: string;
};

/**
 * A text (ADR-0013, ADR-0022): Point Type from its baseline origin, or Area Type in its frame,
 * measured in the one bundled font. `textFrame` checks that the frame matches the kind.
 */
export const TextShape = z.object({
  type: z.literal("text"),
  kind: z
    .enum(["point", "area"])
    .default("point")
    .describe("point breaks only at hard returns; area wraps inside its width and height."),
  x: z
    .number()
    .describe("Point Type: where the first baseline starts. Area Type: the frame's left."),
  y: z.number().describe("Point Type: the first baseline. Area Type: the frame's top."),
  width: z.number().positive().optional().describe("Area Type only: the frame's width."),
  height: z.number().positive().optional().describe("Area Type only: the frame's height."),
  content: z
    .string()
    .min(1)
    .max(10_000)
    .refine(
      // Tabs, \r and line separators draw as spaces but measure as .notdef.
      (s) => !/[^\P{Cc}\n]|[\u2028\u2029]/u.test(s),
      "Printable characters and \\n for a hard return; a tab or \\r is not laid out yet.",
    ),
  fontFamily: z
    .string()
    .min(1)
    .default("Source Sans 3")
    .describe(
      `Any font name, kept as written; ${BUNDLED_FAMILIES_NOTE}; others render in ${BUNDLED_FONT}.`,
    ),
  fontStyle: z
    .enum(FONT_STYLES)
    .default("Regular")
    .describe(
      "The style name. Regular, Italic, Bold, Bold Italic, Black and Black Italic are bundled; the others render in the nearest of them.",
    ),
  fontSize: z.number().positive().default(12).describe("In pt."),
  leading: z
    .number()
    .positive()
    .optional()
    .describe("Distance between baselines in pt; omit for Auto, 120% of fontSize."),
  tracking: z
    .number()
    .min(-1000)
    .max(10_000)
    .optional()
    .describe("Space after each character in 1/1000 em, -1000 to 10000; omit for 0."),
  ranges: z
    .array(CharacterRange)
    .max(10_000)
    .optional()
    .describe(
      "Character Ranges over content's code points, end exclusive; a later range wins, stored canonical.",
    ),
});
/** Every Character Range lies inside the content, counted in code points (ADR-0029). */
export function textRanges(
  t: { content?: string; ranges?: { start: number; end: number }[] | undefined },
  ctx: z.RefinementCtx,
) {
  const length = [...(t.content ?? "")].length;
  // Canonicalising expands every range per character; import's never cover more than the content.
  const covered = (t.ranges ?? []).reduce((sum, r) => sum + Math.max(0, r.end - r.start), 0);
  if (covered > 100_000) {
    ctx.addIssue({
      code: "custom",
      path: ["ranges"],
      message: `The ranges cover ${covered} characters in all, over the limit of 100000; merge overlapping ranges.`,
    });
  }
  t.ranges?.forEach(({ start, end }, i) => {
    if (start >= end) {
      ctx.addIssue({
        code: "custom",
        path: ["ranges", i, "end"],
        message: "end must be after start.",
      });
    } else if (end > length) {
      ctx.addIssue({
        code: "custom",
        path: ["ranges", i, "end"],
        message: `end is past the content's ${length} characters (code points, a hard return included).`,
      });
    }
  });
}
/** Area Type needs its frame, and Point Type has none (ADR-0022); `textRanges` holds too. */
export function textFrame(
  t: Parameters<typeof textRanges>[0] & { kind?: string; width?: number; height?: number },
  ctx: z.RefinementCtx,
) {
  textRanges(t, ctx);
  for (const key of ["width", "height"] as const) {
    if (t.kind === "area" && t[key] === undefined) {
      ctx.addIssue({ code: "custom", path: [key], message: "Area Type needs width and height." });
    } else if (t.kind !== "area" && t[key] !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: "width and height belong to Area Type; set kind to area and pass both.",
      });
    }
  }
}
export type TextShape = Omit<z.output<typeof TextShape>, "ranges"> & {
  ranges?: CharacterRange[] | undefined;
};

/** An Image (ADR-0023): a file stored once per Document, drawn in a frame. */
export const ImageShape = z.object({
  type: z.literal("image"),
  src: z
    .string()
    .optional()
    .describe(
      "A data: URL of a PNG, JPEG or GIF file (WebP is refused: convert it to PNG), or the id of an image already in the Document, which reuses its bytes. Optional with file.",
    ),
  file: z
    .string()
    .optional()
    .describe(
      "Links the Image to this file: its path or URL as an SVG names it, which export SVG writes. Without src it is a missing link, drawn as a crossed frame; nothing is fetched.",
    ),
  x: z.number().describe("The frame's left."),
  y: z.number().describe("The frame's top."),
  width: z
    .number()
    .positive()
    .optional()
    .describe("With height; omit both for the file's pixel size, one pt per pixel."),
  height: z.number().positive().optional(),
  preserveAspectRatio: z
    .string()
    .refine(
      (v) => preserveAspectRatio(v) !== undefined,
      "none, or xMinYMin to xMaxYMax optionally followed by meet or slice, e.g. xMidYMid meet.",
    )
    .default("none")
    .describe(
      "SVG's: none stretches the file to the frame; xMidYMid meet fits it inside, slice fills and crops.",
    ),
});
/** An Image's frame is given whole or taken from the file. */
export function imageFrame(t: { width?: number; height?: number }, ctx: z.RefinementCtx) {
  if ((t.width === undefined) === (t.height === undefined)) return;
  ctx.addIssue({
    code: "custom",
    path: [t.width === undefined ? "width" : "height"],
    message: "Give both width and height, or neither for the file's pixel size.",
  });
}

/** An Image has pixels, a linked file or both; a missing link has no pixel size (ADR-0042). */
export function imagePixels(
  t: { src?: string; file?: string; width?: number; height?: number },
  ctx: z.RefinementCtx,
) {
  if (t.src !== undefined) return;
  if (t.file === undefined) {
    ctx.addIssue({ code: "custom", path: ["src"], message: "Give src, file or both." });
  } else if (t.width === undefined && t.height === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["width"],
      message: "An Image with file and no src has no pixel size; give width and height.",
    });
  }
}

const clientKey = z
  .string()
  .optional()
  .describe("Your own key for this item; the receipt's keyMap maps it to the new id.");
const tags = z.array(z.string());
const meta = z.record(z.string(), z.unknown()).describe("Any JSON: your notes or data bindings.");
const item = {
  clientKey,
  name: z.string().optional(),
  tags: tags.optional(),
  meta: meta.optional(),
};
const leaf = {
  ...item,
  appearance: AppearanceInput.optional().describe(
    "Omit for Illustrator's default, a white Fill and a 1 pt black Stroke; {} paints nothing.",
  ),
};
// Strict, unlike the shapes: core parses a shape out of an item to drop the item's other keys.
const RectItem = z.strictObject({ ...RectShape.shape, ...leaf });
const EllipseItem = z.strictObject({ ...EllipseShape.shape, ...leaf });
const LineItem = z.strictObject({ ...LineShape.shape, ...leaf });
const PolygonItem = z.strictObject({ ...PolygonShape.shape, ...leaf });
const StarItem = z.strictObject({ ...StarShape.shape, ...leaf });
const SpiralItem = z.strictObject({ ...SpiralShape.shape, ...leaf });
const PathItem = z.strictObject({ ...PathShape.shape, ...leaf });
const TextItem = z
  .strictObject({
    ...TextShape.shape,
    ...leaf,
    appearance: AppearanceInput.optional().describe(
      "Omit for Illustrator's default type Appearance, a black Fill and no Stroke; {} paints nothing.",
    ),
  })
  .superRefine(textFrame);
const ImageItem = z
  .strictObject({ ...ImageShape.shape, ...item })
  .superRefine(imageFrame)
  .superRefine(imagePixels);
const LEAF_ITEMS = [
  RectItem,
  EllipseItem,
  LineItem,
  PolygonItem,
  StarItem,
  SpiralItem,
  PathItem,
  TextItem,
  ImageItem,
] as const;
type LeafItem = (typeof LEAF_ITEMS)[number];
interface GroupChild {
  type: "group";
  clientKey?: string;
  name?: string;
  tags?: string[];
  meta?: Record<string, unknown>;
  appearance?: ContainerAppearanceInput;
  children: ChildInput[];
}
interface GroupChildIn extends Omit<GroupChild, "children" | "appearance"> {
  appearance?: z.input<typeof ContainerAppearanceInput>;
  children?: ChildIn[];
}
/**
 * A Node created inline in a Group, without `parentId`. `layer` parses only so core can reject it with
 * INVALID_PARENT and a hint rather than a generic INVALID_INPUT.
 */
export type ChildInput = z.output<LeafItem> | GroupChild | z.output<typeof InlineLayer>;
type ChildIn = z.input<LeafItem> | GroupChildIn | z.input<typeof InlineLayer>;
const InlineLayer = z.strictObject({ type: z.literal("layer"), ...item });
const ChildInput: z.ZodType<ChildInput, ChildIn> = z.lazy(() =>
  z.discriminatedUnion("type", [...LEAF_ITEMS, GroupItem, InlineLayer]),
);
const container = {
  appearance: ContainerAppearanceInput.optional().describe(
    "Paints every descendant Live Shape's and path's outline, each in its stacking order; omit for none.",
  ),
};
const GroupItem = z.strictObject({
  type: z.literal("group"),
  ...item,
  ...container,
  children: z.array(ChildInput).default([]).describe("Created inside this Group, bottom to top."),
});

const parentId = z
  .string()
  .describe("Id of a Layer or Group, never an Artboard. doc_create returns the default Layer id.");
export const NodeInput = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("layer"),
    ...item,
    ...container,
    parentId: z
      .string()
      .nullable()
      .default(null)
      .describe("Id of the parent Layer; omit or null for a top-level Layer."),
  }),
  ...[...LEAF_ITEMS, GroupItem].map((s) => s.extend({ parentId })),
]);
export type NodeInput = z.input<typeof NodeInput>;

/** Illustrator's 16 blend modes, by their CSS names. */
export const BlendMode = z.enum([
  "normal",
  "darken",
  "multiply",
  "color-burn",
  "lighten",
  "screen",
  "color-dodge",
  "overlay",
  "soft-light",
  "hard-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
]);

/** What `node_update` may write on every Node; each type adds its parameters and `appearance`. */
export const Writable = z.object({
  name: z.string(),
  visible: z.boolean(),
  locked: z.boolean(),
  opacity: z.number().min(0).max(1),
  blendMode: BlendMode,
  tags,
  meta,
});

const unwrapDefault = (t: z.ZodType) => (t instanceof z.ZodDefault ? t.unwrap() : t);
const parameters = Object.fromEntries(
  [TextShape, ...Object.values(SHAPES)]
    .flatMap((o) => Object.entries(o.shape))
    .filter(([k]) => k !== "type" && k !== "kind")
    .map(([k, t]) => [k, unwrapDefault(t as z.ZodType)]),
);
// An Image's frame reuses the keys above; src Relinks and file links, relinks or Embeds (ADR-0042).
parameters.preserveAspectRatio = unwrapDefault(ImageShape.shape.preserveAspectRatio);
parameters.src = ImageShape.shape.src
  .unwrap()
  .describe(
    "An image's new pixels (Relink): a data: URL of a PNG, JPEG or GIF, or the id of an image already in the Document. The frame and preserveAspectRatio stay.",
  );
parameters.file = ImageShape.shape.file
  .unwrap()
  .describe(
    "An image's linked file: a string links or relinks it; null Embeds a linked Image, which needs src.",
  );

/**
 * The published `node_update` patch. Nothing here has a default, or the MCP SDK would insert it into
 * the patch and overwrite the stored value. Loose, so read-only keys reach core and get a hint; every
 * key is nullable because null deletes in a merge patch.
 */
export const NodePatch = z
  .looseObject(
    Object.fromEntries(
      Object.entries({
        ...Writable.shape,
        appearance: z
          .strictObject({ fills: z.array(Fill), strokes: z.array(Stroke), contents })
          .partial()
          .describe("contents only on a Layer or Group."),
        ...parameters,
      }).map(([k, t]) => [k, (t as z.ZodType).nullable().optional()]),
    ),
  )
  .describe(
    "JSON Merge Patch (RFC 7396) of the Node's writable properties: objects merge, null deletes, arrays and everything else replace.",
  );

export const UpdateInput = z.strictObject({ nodeId: z.string(), patch: NodePatch });
export type UpdateInput = z.input<typeof UpdateInput>;

const clipNodeId = z
  .string()
  .describe("The Live Shape, Path or text that clips; it loses its Appearance.");
const contentIds = z
  .array(z.string())
  .min(1)
  .max(1000)
  .describe("The Nodes it clips: siblings of the clip Node.");
const layerId = z
  .string()
  .describe(
    "Alone, instead of clipNodeId and contentIds: the Layer whose topmost child clips it (ADR-0053).",
  );
const kind = z
  .enum(["clip", "opacity"])
  .default("clip")
  .describe("clip; an Opacity Mask (F-MASK-02) is not available yet.");
/**
 * Illustrator's Object > Clipping Mask > Make (ADR-0021), or with `layerId` alone the Layers
 * panel's Make Clipping Mask (ADR-0053).
 */
export const MaskInput = z.union([
  z.strictObject({ clipNodeId, contentIds, kind }),
  z.strictObject({ layerId, kind }),
]);
export type MaskInput = z.input<typeof MaskInput>;
/** MaskInput's arguments in one object, as an MCP tool advertises them. */
export const MaskFields = z.strictObject({
  clipNodeId: clipNodeId.optional(),
  contentIds: contentIds.optional(),
  layerId: layerId.optional(),
  kind,
});

/** `[a, b, c, d, e, f]` with SVG semantics. */
export type Matrix = [number, number, number, number, number, number];

const nodeIds = z.array(z.string()).min(1).max(1000);

/** Illustrator's 9-point reference point, as fractions of the bounds' width and height. */
export const PIVOTS = {
  topLeft: [0, 0],
  top: [0.5, 0],
  topRight: [1, 0],
  left: [0, 0.5],
  center: [0.5, 0.5],
  right: [1, 0.5],
  bottomLeft: [0, 1],
  bottom: [0.5, 1],
  bottomRight: [1, 1],
} as const;
const nonZero = z.number().refine((n) => n !== 0, "Scale by a non-zero factor.");
const xy = z.strictObject({ x: z.number().default(0), y: z.number().default(0) });

export const TransformInput = z
  .strictObject({
    nodeIds,
    translate: xy.optional().describe("Move by x, y in pt, after everything else."),
    rotate: z.number().optional().describe("Degrees, clockwise on screen."),
    scale: z
      .union([nonZero, z.strictObject({ x: nonZero, y: nonZero })])
      .optional()
      .describe("A factor, or one per axis; negative mirrors."),
    skew: xy.optional().describe("Degrees, as SVG skewX (x) and skewY (y)."),
    matrix: z
      .tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()])
      .optional()
      .describe("[a, b, c, d, e, f] applied about the pivot, instead of rotate, skew and scale."),
    pivot: z
      .union([
        z.enum(Object.keys(PIVOTS) as [keyof typeof PIVOTS]),
        z.strictObject({ x: z.number(), y: z.number() }),
      ])
      .default("center")
      .describe("Reference point on the targets' geometricBounds, or document coordinates."),
    each: z
      .boolean()
      .default(false)
      .describe("true: each target about its own pivot; false: all about one pivot."),
    scaleStrokes: z
      .boolean()
      .default(true)
      .describe("false keeps the rendered Stroke width by dividing the stored width."),
  })
  .refine(
    (t) => [t.translate, t.rotate, t.scale, t.skew, t.matrix].some((v) => v !== undefined),
    "Give at least one of translate, rotate, scale, skew or matrix.",
  )
  .refine(
    (t) => t.matrix === undefined || [t.rotate, t.scale, t.skew].every((v) => v === undefined),
    "matrix replaces rotate, scale and skew; send it alone (translate may accompany it).",
  )
  .refine(
    // A singular matrix collapses the Nodes for good: nothing composed onto it can undo it.
    (t) => scaleOf(compose(t, { x: 0, y: 0 })) > 1e-6,
    "The transform collapses the Nodes to a line or point; use a non-singular matrix and skews whose sum stays away from 90°.",
  );
export type TransformInput = z.input<typeof TransformInput>;

/** Common properties (F-DOC-02). */
interface NodeBase {
  id: string;
  name: string;
  parentId: string | null;
  /** Fractional-index key ordering siblings (ADR-0002). */
  index: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: z.infer<typeof BlendMode>;
  transform: Matrix;
  tags: string[];
  meta: Record<string, unknown>;
}

export interface LayerNode extends NodeBase {
  type: "layer";
  /** Missing means empty (ADR-0043). */
  appearance?: ContainerAppearance;
}

export interface GroupNode extends NodeBase {
  type: "group";
  /** Missing means empty (ADR-0043). */
  appearance?: ContainerAppearance;
}

/** A Live Shape or Path: its parameters plus an Appearance. */
export type ShapeNode = NodeBase &
  Shape & {
    appearance: Appearance;
    /** The Clipping Path of its Group (ADR-0021); missing means false. */
    clipping?: boolean;
  };

export type TextNode = NodeBase &
  TextShape & {
    appearance: Appearance;
    /** The Clipping Path of its Group (ADR-0052); missing means false. */
    clipping?: boolean;
  };

/** A Node that paints with an Appearance: a Live Shape, a Path or a text. */
export type LeafNode = ShapeNode | TextNode;

export interface ImageNode extends NodeBase {
  type: "image";
  /**
   * The SHA-256 of the pixels, stored once in the Document (ADR-0023). Absent only on a missing
   * link (ADR-0042).
   */
  src?: string;
  /** The linked file's path or URL, as an SVG names it; absent on an embedded Image (ADR-0042). */
  file?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** `none` or `<align> <meet|slice>`, as `preserveAspectRatio()` spells it. */
  preserveAspectRatio: string;
}

export type Node = LayerNode | GroupNode | LeafNode | ImageNode;

export interface Document {
  id: string;
  name: string;
  /** Schema version. */
  version: 1;
  rev: number;
  artboards: Artboard[];
  nodes: Map<string, Node>;
  /** Every image file the Document holds, by id; the bytes live outside it (ADR-0023). */
  images: Map<string, ImageInfo>;
}

/** A non-fatal note on a write, in its receipt's `warnings`. */
export const Warning = z.object({
  code: z.string(),
  nodeId: z.string().optional(),
  message: z.string(),
});
export type Warning = z.infer<typeof Warning>;

/** The uniform result of every write (REQUIREMENTS §6.5). */
export const WriteReceipt = z.object({
  txId: z.string(),
  rev: z.number().int(),
  createdIds: z.array(z.string()),
  updatedIds: z.array(z.string()),
  deletedIds: z.array(z.string()),
  keyMap: z.record(z.string(), z.string()),
  bounds: Rect.nullable(),
  warnings: z.array(Warning),
  failed: z
    .array(
      z.object({
        index: z.number().int(),
        code: z.string(),
        message: z.string(),
        hint: z.string(),
        path: z.string().optional(),
      }),
    )
    .optional()
    .describe("Only with partial: true. The items that did not apply, by input index."),
});
export type WriteReceipt = z.infer<typeof WriteReceipt>;

/** Every Node type once: the Record fails to compile when a type is added or dropped. */
const NODE_TYPES = {
  layer: true,
  group: true,
  rect: true,
  ellipse: true,
  line: true,
  polygon: true,
  star: true,
  spiral: true,
  path: true,
  text: true,
  image: true,
} satisfies Record<Node["type"], true>;
export const NodeType = z.enum(Object.keys(NODE_TYPES) as [Node["type"]]);

const compiles = (pattern: string) => {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
};

/** A Node Query's filters and page (ADR-0015): every filter given must hold. */
export const NodeQuery = z.strictObject({
  types: z.array(NodeType).min(1).optional(),
  // ponytail: the length cap is the only guard against a slow pattern; add a time budget with a spatial index.
  nameRegex: z
    .string()
    .max(200)
    .refine(compiles, "Not a valid JavaScript regular expression.")
    .optional()
    .describe("JavaScript regular expression, no flags, tested against the stored name."),
  tags: z.array(z.string()).min(1).optional().describe("The Node carries every one of these."),
  parentId: z
    .string()
    .optional()
    .describe("The Node's direct parent; deeper descendants do not match."),
  withinRect: Rect.optional().describe("geometricBounds entirely inside, edges included."),
  intersectsRect: Rect.optional().describe("geometricBounds touching, edges included."),
  limit: z.number().int().min(1).max(1000).default(100),
  cursor: z.string().optional().describe("nextCursor from the previous page."),
});
export type NodeQuery = z.input<typeof NodeQuery>;
