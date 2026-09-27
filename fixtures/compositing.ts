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

export interface CompositingCase {
  name: string;
  /** Created in the default Layer, bottom to top, by `node_create`. */
  nodes: object[];
  /** Made into a Clipping Mask, by the names of its Clipping Path and content; it is then "mask". */
  mask?: { clip: string; content: string[] };
  /** `node_update` patches by Node name, applied last; "Layer" is the default Layer. */
  patches: Record<
    string,
    { opacity?: number; blendMode?: string; appearance?: ReturnType<typeof appearance> }
  >;
  /** Document points and their colour. */
  probes: { x: number; y: number; rgb: RGB }[];
}

const half = over(RED, 0.5, WHITE);

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
    mask: { clip: "clip", content: ["lower", "upper"] },
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
];

/** Whether `rgb` is within `tolerance` of `expected` on every channel. */
export const near = (rgb: ArrayLike<number>, expected: RGB, tolerance = 3) =>
  expected.every((v, i) => Math.abs(Number(rgb[i]) - v) <= tolerance);
