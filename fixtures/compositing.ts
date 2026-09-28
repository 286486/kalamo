/**
 * Documents whose pixels depend on a translucent or blended Node composing as one image (ADR-0044),
 * or on a container's Appearance (ADR-0043), each with the colour expected at chosen Document
 * points. `render` and the browser canvas are both checked against them. Every case draws on one 200 × 100 Artboard with a white background.
 */

type RGB = [number, number, number];

const each = (f: (i: 0 | 1 | 2) => number): RGB => [f(0), f(1), f(2)];
/** Source-over of `s` at alpha `a` onto an opaque `b`, and the separable blend modes, per channel. */
const over = (s: RGB, a: number, b: RGB) => each((i) => s[i] * a + b[i] * (1 - a));
const multiply = (s: RGB, b: RGB) => each((i) => (s[i] * b[i]) / 255);
const screen = (s: RGB, b: RGB) => each((i) => s[i] + b[i] - (s[i] * b[i]) / 255);

const WHITE: RGB = [255, 255, 255];
const RED: RGB = [255, 0, 0];
const BLUE: RGB = [0, 0, 255];
const CYAN: RGB = [0, 255, 255];
const MAGENTA: RGB = [255, 0, 255];
const YELLOW: RGB = [255, 255, 0];
const GREY: RGB = [128, 128, 128];

const hex = (c: RGB) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
const rect = (name: string, x: number, y: number, width: number, height: number, fill: RGB) => ({
  type: "rect" as const,
  name,
  x,
  y,
  width,
  height,
  appearance: { fills: [{ color: hex(fill) }], strokes: [] },
});
/** Two rects overlapping over x 50..80, y 20..80. */
const pair = (lower: RGB, upper: RGB) => [
  rect("lower", 20, 20, 60, 60, lower),
  rect("upper", 50, 20, 60, 60, upper),
];
const backdrop = (fill: RGB) => rect("backdrop", 0, 0, 200, 100, fill);
/** A container Appearance as `node_update` takes it and a Document stores it. */
const appearance = (fills: RGB[], strokes: [RGB, number][], contents: number) => ({
  fills: fills.map((c) => ({ type: "solid", color: hex(c) })),
  strokes: strokes.map(([c, width]) => ({
    type: "solid",
    color: hex(c),
    width,
    cap: "butt",
    join: "miter",
    miterLimit: 10,
    dash: [],
  })),
  contents,
});
/**
 * A Group Stroke 10 wide over `pair(RED, BLUE)`, probed at 23 inside the lower rect and at 80
 * inside the upper.
 */
const strokedPair = (contents: number, rgb: { at23: RGB; at80: RGB }): CompositingCase => ({
  name: `a Group Stroke at contents ${contents} draws ${contents ? "below" : "above"} every child`,
  nodes: [{ type: "group", name: "g", children: pair(RED, BLUE) }],
  patches: { g: { appearance: appearance([], [[YELLOW, 10]], contents) } },
  probes: [
    { x: 17, y: 50, rgb: YELLOW },
    { x: 23, y: 50, rgb: rgb.at23 },
    { x: 80, y: 50, rgb: rgb.at80 },
  ],
});

/**
 * Area Type in heavy stems, 50% red with the second word yellow: "II II " then "III" wrap in its
 * frame and a last "II" overflows. Line 1's stems span y 6..30, line 2's y 38..62, the overflow
 * would sit at y 70..94. The first stem spans x 12.5..18.2 and the yellow word's first 64.5..70.3.
 */
const areaType = {
  type: "text",
  kind: "area",
  name: "type",
  x: 10,
  y: 5,
  width: 120,
  height: 64,
  content: "II II III\nII",
  fontSize: 36,
  fontStyle: "Black",
  leading: 32,
  tracking: 200,
  ranges: [{ start: 3, end: 5, fill: hex(YELLOW) }],
  appearance: { fills: [{ color: `${hex(RED)}80` }], strokes: [] },
};

/** A leaf Appearance, as `node_update` takes it and a Document stores it. */
const look = (fills: RGB[], strokes: [RGB, number][]) => {
  const { contents: _, ...rest } = appearance(fills, strokes, 0);
  return rest;
};
/** A red photo over x 20..80, y 20..80, clipped by a rect over x 40..140, y 30..70. */
const cropped = {
  nodes: [rect("photo", 20, 20, 60, 60, RED), rect("clip", 40, 30, 100, 40, WHITE)],
  masks: [{ name: "mask", clip: "clip", content: ["photo"] }],
};
/**
 * The crop's Clipping Path stroked blue, 10 wide, under or over a Group Stroke 4 wide, which
 * outlines the photo only. The two cross at (80, 30), where only the Group Stroke is clipped.
 */
const crossed = (contents: number): CompositingCase => ({
  name: `a Group Stroke at contents ${contents} draws ${contents ? "below" : "above"} its Clipping Path's Stroke, clipped`,
  ...cropped,
  patches: {
    clip: { appearance: look([], [[BLUE, 10]]) },
    mask: { appearance: appearance([], [[YELLOW, 4]], contents) },
  },
  probes: [
    { x: 80, y: 32, rgb: contents ? BLUE : YELLOW },
    { x: 80, y: 27, rgb: BLUE },
    { x: 81, y: 50, rgb: YELLOW },
  ],
});

export interface CompositingCase {
  name: string;
  /** Created in the default Layer, bottom to top, by `node_create`. */
  nodes: object[];
  /**
   * Made into Clipping Masks in order, each by the names of its Clipping Path and content, and then
   * named `name`, which a later one's content can list.
   */
  masks?: { name: string; clip: string; content: string[] }[];
  /** `node_transform` inputs by Node name, applied before the patches. */
  transforms?: Record<string, { matrix: number[]; pivot: { x: number; y: number } }>;
  /** `node_update` patches by Node name, applied last; "Layer" is the default Layer. */
  patches: Record<string, { opacity?: number; blendMode?: string; appearance?: object }>;
  /** Document points and their colour. */
  probes: { x: number; y: number; rgb: RGB }[];
}

const half = over(RED, 0.5, WHITE);
/** Red at x 0 to blue at x 200, as a linear gradient in document coordinates paints pixel `x`. */
const across = (x: number): RGB => {
  const t = (x + 0.5) / 200;
  return [255 * (1 - t), 0, 255 * t];
};

export const COMPOSITING: CompositingCase[] = [
  {
    // Per paint, the overlap would be red at 50% over red at 50%: over(RED, 0.5, half).
    name: "a 50% Group of overlapping opaque rects is evenly 50%",
    nodes: [{ type: "group", name: "g", children: pair(RED, RED) }],
    patches: { g: { opacity: 0.5 } },
    probes: [
      { x: 35, y: 50, rgb: half },
      { x: 65, y: 50, rgb: half },
    ],
  },
  {
    name: "the same Group in a 50% Layer is faded once per level",
    nodes: [{ type: "group", name: "g", children: pair(RED, RED) }],
    patches: { g: { opacity: 0.5 }, Layer: { opacity: 0.5 } },
    probes: [
      { x: 35, y: 50, rgb: over(RED, 0.25, WHITE) },
      { x: 65, y: 50, rgb: over(RED, 0.25, WHITE) },
    ],
  },
  {
    // Per paint, the overlap would be magenta × cyan × yellow, black.
    name: "a Multiply Group blends its composed children with the backdrop only",
    nodes: [backdrop(YELLOW), { type: "group", name: "g", children: pair(CYAN, MAGENTA) }],
    patches: { g: { blendMode: "multiply" } },
    probes: [
      { x: 35, y: 50, rgb: multiply(CYAN, YELLOW) },
      { x: 65, y: 50, rgb: multiply(MAGENTA, YELLOW) },
      { x: 95, y: 50, rgb: multiply(MAGENTA, YELLOW) },
    ],
  },
  {
    // Alone in the Group, the Screen rect has nothing to blend with, so it stays red.
    name: "a Screen child in a Multiply Group blends with its sibling, not the backdrop",
    nodes: [backdrop(GREY), { type: "group", name: "g", children: pair(BLUE, RED) }],
    patches: { g: { blendMode: "multiply" }, upper: { blendMode: "screen" } },
    probes: [
      { x: 35, y: 50, rgb: multiply(BLUE, GREY) },
      { x: 65, y: 50, rgb: multiply(screen(RED, BLUE), GREY) },
      { x: 95, y: 50, rgb: multiply(RED, GREY) },
    ],
  },
  {
    name: "a 50% rect shows no Fill through the inner half of its Stroke",
    nodes: [
      {
        ...rect("r", 40, 30, 120, 40, RED),
        appearance: { fills: [{ color: hex(RED) }], strokes: [{ color: hex(BLUE), width: 20 }] },
      },
    ],
    patches: { r: { opacity: 0.5 } },
    probes: [
      { x: 35, y: 50, rgb: over(BLUE, 0.5, WHITE) },
      { x: 45, y: 50, rgb: over(BLUE, 0.5, WHITE) },
      { x: 100, y: 50, rgb: half },
    ],
  },
  {
    name: "a 50% Clipping Mask is faded once and draws nothing outside its Clipping Path",
    nodes: [...pair(RED, RED), rect("clip", 30, 30, 60, 40, BLUE)],
    masks: [{ name: "mask", clip: "clip", content: ["lower", "upper"] }],
    patches: { mask: { opacity: 0.5 } },
    probes: [
      { x: 40, y: 50, rgb: half },
      { x: 65, y: 50, rgb: half },
      { x: 25, y: 25, rgb: WHITE },
      { x: 100, y: 50, rgb: WHITE },
    ],
  },
  strokedPair(0, { at23: YELLOW, at80: YELLOW }),
  strokedPair(1, { at23: RED, at80: BLUE }),
  {
    name: "a Group Fill below its children and a Stroke above them",
    nodes: [
      {
        type: "group",
        name: "g",
        children: [
          { ...rect("hollow", 20, 20, 60, 60, RED), appearance: { fills: [], strokes: [] } },
          rect("upper", 50, 20, 60, 60, RED),
        ],
      },
    ],
    patches: { g: { appearance: appearance([CYAN], [[BLUE, 4]], 1) } },
    probes: [
      { x: 35, y: 50, rgb: CYAN },
      { x: 65, y: 50, rgb: RED },
      { x: 80, y: 50, rgb: BLUE },
      { x: 95, y: 50, rgb: RED },
    ],
  },
  {
    // Per paint, the Stroke's inner half would be blue at 50% over red at 50%.
    name: "a 50% Group's Stroke is faded with its child as one image",
    nodes: [{ type: "group", name: "g", children: [rect("r", 40, 30, 120, 40, RED)] }],
    patches: { g: { opacity: 0.5, appearance: appearance([], [[BLUE, 20]], 0) } },
    probes: [
      { x: 35, y: 50, rgb: over(BLUE, 0.5, WHITE) },
      { x: 45, y: 50, rgb: over(BLUE, 0.5, WHITE) },
      { x: 100, y: 50, rgb: half },
    ],
  },
  {
    name: "a Group Fill below Area Type and a Stroke above it paint only the lines in the frame",
    nodes: [{ type: "group", name: "g", children: [areaType] }],
    patches: { g: { appearance: appearance([CYAN], [[BLUE, 2]], 1) } },
    probes: [
      { x: 15, y: 18, rgb: over(RED, 128 / 255, CYAN) },
      { x: 67, y: 18, rgb: YELLOW },
      { x: 12, y: 18, rgb: BLUE },
      { x: 12, y: 50, rgb: BLUE },
      { x: 15, y: 34, rgb: WHITE },
      { x: 15, y: 82, rgb: WHITE },
    ],
  },
  {
    name: "a Group Fill above Area Type paints every shown glyph, range fills too",
    nodes: [{ type: "group", name: "g", children: [areaType] }],
    patches: { g: { appearance: appearance([MAGENTA], [], 0) } },
    probes: [
      { x: 15, y: 18, rgb: MAGENTA },
      { x: 67, y: 18, rgb: MAGENTA },
      { x: 15, y: 50, rgb: MAGENTA },
      { x: 25, y: 18, rgb: WHITE },
      { x: 15, y: 34, rgb: WHITE },
      { x: 15, y: 82, rgb: WHITE },
    ],
  },
  {
    name: "a Group Fill leaves an evenodd Path's hole open",
    nodes: [
      {
        type: "group",
        name: "g",
        children: [
          {
            type: "path",
            name: "ring",
            d: "M 20 20 L 80 20 L 80 80 L 20 80 Z M 40 40 L 60 40 L 60 60 L 40 60 Z",
            fillRule: "evenodd",
            appearance: { fills: [], strokes: [] },
          },
        ],
      },
    ],
    patches: { g: { appearance: appearance([RED], [], 0) } },
    probes: [
      { x: 30, y: 50, rgb: RED },
      { x: 50, y: 50, rgb: WHITE },
    ],
  },
  {
    // #107. The text's stem spans x 22.5..28.2, y 16..40 in its own coordinates, and x 40..88, y 45..56.4
    // once doubled and turned 90°. Painted in its own space, the stem would take the colour at y / 2.
    name: "a Group gradient Fill runs one field across a shape and a doubled, turned text",
    nodes: [
      {
        type: "group",
        name: "g",
        children: [
          rect("r", 120, 20, 60, 60, RED),
          { type: "text", name: "t", x: 20, y: 40, content: "I", fontSize: 36, fontStyle: "Black" },
        ],
      },
    ],
    transforms: { t: { matrix: [0, 2, -2, 0, 120, 0], pivot: { x: 0, y: 0 } } },
    patches: {
      g: {
        appearance: {
          fills: [
            {
              type: "gradient",
              gradient: {
                type: "linear",
                stops: [
                  { offset: 0, color: `${hex(RED)}FF` },
                  { offset: 1, color: `${hex(BLUE)}FF` },
                ],
                start: { x: 0, y: 0 },
                end: { x: 200, y: 0 },
              },
            },
          ],
          strokes: [],
          contents: 0,
        },
      },
    },
    probes: [
      { x: 130, y: 50, rgb: across(130) },
      { x: 170, y: 30, rgb: across(170) },
      { x: 64, y: 50, rgb: across(64) },
      { x: 78, y: 52, rgb: across(78) },
      { x: 100, y: 50, rgb: WHITE },
    ],
  },
];

// A painted Clipping Path (ADR-0051): its Fills behind the content, its Strokes in front, unclipped.
COMPOSITING.push(
  {
    name: "a Clipping Path's Fill shows behind the content and its Stroke over it at full width",
    ...cropped,
    patches: { clip: { appearance: look([CYAN], [[BLUE, 10]]) } },
    probes: [
      { x: 60, y: 50, rgb: RED },
      { x: 110, y: 50, rgb: CYAN },
      { x: 43, y: 50, rgb: BLUE },
      { x: 36, y: 50, rgb: BLUE },
      { x: 110, y: 26, rgb: BLUE },
      { x: 30, y: 50, rgb: WHITE },
    ],
  },
  {
    name: "a Clipping Path's two Fills and two Strokes draw in order",
    ...cropped,
    patches: {
      clip: {
        appearance: look(
          [CYAN, YELLOW],
          [
            [BLUE, 10],
            [MAGENTA, 4],
          ],
        ),
      },
    },
    probes: [
      { x: 110, y: 50, rgb: YELLOW },
      { x: 60, y: 50, rgb: RED },
      { x: 41, y: 50, rgb: MAGENTA },
      { x: 36, y: 50, rgb: BLUE },
    ],
  },
  {
    name: "a Clipping Path's gradient Fill draws",
    ...cropped,
    patches: {
      clip: {
        appearance: {
          fills: [
            {
              type: "gradient",
              gradient: {
                type: "linear",
                stops: [
                  { offset: 0, color: `${hex(RED)}FF` },
                  { offset: 1, color: `${hex(BLUE)}FF` },
                ],
                start: { x: 0, y: 0 },
                end: { x: 200, y: 0 },
              },
            },
          ],
          strokes: [],
        },
      },
    },
    probes: [
      { x: 60, y: 50, rgb: RED },
      { x: 100, y: 50, rgb: across(100) },
      { x: 130, y: 50, rgb: across(130) },
    ],
  },
  {
    name: "an evenodd Clipping Path's Fill leaves its hole empty",
    nodes: [
      rect("photo", 20, 20, 80, 60, RED),
      {
        type: "path",
        name: "ring",
        d: "M 90 20 L 170 20 L 170 80 L 90 80 Z M 110 40 L 150 40 L 150 60 L 110 60 Z",
        fillRule: "evenodd",
      },
    ],
    masks: [{ name: "mask", clip: "ring", content: ["photo"] }],
    patches: { ring: { appearance: look([CYAN], []) } },
    probes: [
      { x: 95, y: 50, rgb: RED },
      { x: 160, y: 50, rgb: CYAN },
      { x: 130, y: 50, rgb: WHITE },
      { x: 50, y: 50, rgb: WHITE },
    ],
  },
  {
    // As one image, the Fills would be yellow at 50% over white and the Stroke's inner half blue
    // at 50% over white; as one image with the photo, the photo would fade.
    name: "a 50% Clipping Path fades its Fills and its Stroke each as one image, and not the content",
    ...cropped,
    patches: { clip: { opacity: 0.5, appearance: look([CYAN, YELLOW], [[BLUE, 10]]) } },
    probes: [
      { x: 60, y: 50, rgb: RED },
      { x: 110, y: 50, rgb: over(YELLOW, 0.5, WHITE) },
      { x: 110, y: 32, rgb: over(BLUE, 0.5, over(YELLOW, 0.5, WHITE)) },
      { x: 110, y: 27, rgb: over(BLUE, 0.5, WHITE) },
    ],
  },
  crossed(0),
  crossed(1),
  {
    name: "an outer Clipping Mask clips an inner Clipping Path's Stroke",
    nodes: [...cropped.nodes, rect("frame", 0, 0, 200, 50, WHITE)],
    masks: [...cropped.masks, { name: "outer", clip: "frame", content: ["mask"] }],
    patches: { clip: { appearance: look([], [[BLUE, 10]]) } },
    probes: [
      { x: 36, y: 45, rgb: BLUE },
      { x: 110, y: 32, rgb: BLUE },
      { x: 36, y: 55, rgb: WHITE },
      { x: 110, y: 68, rgb: WHITE },
    ],
  },
);

// A text Clipping Path (ADR-0052): the content shows through the glyphs as laid out, and the
// overflow clips nothing. The Area Type's first stem spans x 12.5..18.2 on each line.
COMPOSITING.push(
  {
    name: "a text Clipping Path shows the content only through its glyphs, its overflow clipping nothing",
    nodes: [rect("photo", 0, 0, 200, 100, RED), areaType],
    masks: [{ name: "mask", clip: "type", content: ["photo"] }],
    patches: {},
    probes: [
      { x: 15, y: 18, rgb: RED },
      { x: 15, y: 50, rgb: RED },
      { x: 15, y: 34, rgb: WHITE },
      { x: 15, y: 82, rgb: WHITE },
      { x: 180, y: 50, rgb: WHITE },
    ],
  },
  {
    name: "a text Clipping Path's Fill shows behind the content in its glyphs, its Stroke over it",
    nodes: [rect("photo", 0, 0, 200, 20, RED), areaType],
    masks: [{ name: "mask", clip: "type", content: ["photo"] }],
    patches: { type: { appearance: look([CYAN], [[BLUE, 2]]) } },
    probes: [
      { x: 15, y: 12, rgb: RED },
      { x: 15, y: 25, rgb: CYAN },
      { x: 12, y: 25, rgb: BLUE },
      { x: 10, y: 25, rgb: WHITE },
      { x: 15, y: 34, rgb: WHITE },
      { x: 15, y: 82, rgb: WHITE },
    ],
  },
);

/** Whether `rgb` is within `tolerance` of `expected` on every channel. */
export const near = (rgb: ArrayLike<number>, expected: RGB, tolerance = 3) =>
  expected.every((v, i) => Math.abs(Number(rgb[i]) - v) <= tolerance);
