// The facts of Kalamo's Inkscape SVG dialect (ADR-0017) that export writes and import reads back,
// each defined once with both directions. No XML parser here: the browser's writer imports it.
import {
  alphaOf,
  formatNumber,
  LEGACY_SVG_NS,
  type RenderScope,
  type ShapeNode,
} from "@kalamo/core";

export const NS = {
  svg: "http://www.w3.org/2000/svg",
  inkscape: "http://www.inkscape.org/namespaces/inkscape",
  sodipodi: "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd",
  kalamo: "https://kalamo.cc/ns/svg",
  legacy: LEGACY_SVG_NS,
  // Inkscape 1.2 draws an <image> only through xlink:href, not SVG 2's href (ADR-0023).
  xlink: "http://www.w3.org/1999/xlink",
};

/** The root's namespace declarations. */
export const XMLNS = {
  xmlns: NS.svg,
  "xmlns:inkscape": NS.inkscape,
  "xmlns:sodipodi": NS.sodipodi,
  "xmlns:kalamo": NS.kalamo,
  "xmlns:xlink": NS.xlink,
};

/** Kalamo's own attributes, written as `kalamo:<name>`. */
export type KalamoAttr =
  | "scope"
  | "stack"
  | "paint"
  | "clipped"
  | "artboard"
  | "background"
  | "tags"
  | "meta"
  | "src"
  | "fileOrientation"
  | "midpoint"
  | "simulated"
  | "autosize";

export const kalamo = (name: KalamoAttr) => `kalamo:${name}` as const;

/** Numbers in an attribute, split at spaces and commas. */
export const numbers = (s: string | null) =>
  (s ?? "")
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);

/** A Node's or Artboard's XML id: an XML id cannot start with a digit, a ULID can. */
export const xmlId = (id: string) => `z-${id}`;

/** The id of a Clipping Mask's `<clipPath>`: its Group's XML id behind `clip-`. */
export const clipId = (groupId: string) => `clip-${xmlId(groupId)}`;

/** The id of an Area Type's frame `<rect>` in `<defs>`: its XML id behind `area-` (ADR-0022). */
export const areaId = (textId: string) => `area-${xmlId(textId)}`;

/** The id of a gradient paint: its list and index in it, then its Node's XML id (ADR-0026). */
export const gradientId = (list: "fill" | "stroke", i: number, nodeId: string) =>
  `${list}-${i}-${xmlId(nodeId)}`;

/** The id `xmlId` wrote, or undefined for any other id. */
export const idOf = (value: string | null | undefined) =>
  /^z-([0-9A-HJKMNP-TV-Z]{26})$/.exec(value ?? "")?.[1];

/** A Render Scope as `kalamo:scope`: `doc`, `artboard:<id>`, `nodes:<id,…>` or `rect:<x,y,w,h>`. */
export const scopeAttr = (scope?: RenderScope) =>
  !scope
    ? "doc"
    : "artboardId" in scope
      ? `artboard:${scope.artboardId}`
      : "nodeIds" in scope
        ? `nodes:${scope.nodeIds.join(",")}`
        : `rect:${[scope.rect.x, scope.rect.y, scope.rect.width, scope.rect.height].map(formatNumber).join(",")}`;

/** The Render Scope `scopeAttr` wrote; undefined at doc scope or for anything else. */
export function scopeOf(value: string | null): RenderScope | undefined {
  const [kind, rest = ""] = (value ?? "").split(/:(.*)/s);
  const [x = 0, y = 0, width = 0, height = 0] = numbers(rest);
  return kind === "artboard"
    ? { artboardId: rest }
    : kind === "nodes"
      ? { nodeIds: rest.split(",") }
      : kind === "rect"
        ? { rect: { x, y, width, height } }
        : undefined;
}

/** A colour as `fill` or `stroke` plus its alpha as `-opacity`: Inkscape 1.2 draws #RRGGBBAA black. */
export const paintAttrs = (name: "fill" | "stroke", color: string) => ({
  [name]: color.slice(0, 7),
  [`${name}-opacity`]: color.length === 9 ? formatNumber(alphaOf(color)) : undefined,
});

/** An opacity from `0.5` or `50%`, 1 when missing or unreadable. */
export const alpha = (v: string | undefined) => {
  const n = v?.trim().endsWith("%") ? Number.parseFloat(v) / 100 : Number(v ?? 1);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
};

/**
 * SVG's Stroke defaults, which export leaves unwritten and import assumes. SVG's miter limit is 4,
 * Illustrator's 10, so export always writes it for a miter join, where it shows, and import takes
 * Kalamo's for the other joins.
 */
export const SVG_STROKE = { cap: "butt", join: "miter", miterLimit: 4 } as const;
export const MITER_LIMIT = 10;

/** A star's first vertex points straight up; `sodipodi:arg1` is in radians, clockwise. */
const ARG1 = -Math.PI / 2;

/**
 * The `sodipodi:` and `inkscape:` parameters of a polygon or star, from which Inkscape's star tool
 * rebuilds it on load (ADR-0024): arg1 turned by `angle`, the inner vertices half a step plus
 * `twist` clockwise of the outer ones (arg2), a polygon's r2 its inradius. A Node stored before
 * ADR-0024 reads the new fields as 0.
 */
export function starAttrs(n: Extract<ShapeNode, { type: "polygon" | "star" }>) {
  const [sides, r1, r2, twist] =
    n.type === "polygon"
      ? [n.sides, n.radius, n.radius * Math.cos(Math.PI / n.sides), 0]
      : [n.points, n.outerRadius, n.innerRadius, n.twist || 0];
  const arg1 = ARG1 + ((n.angle || 0) * Math.PI) / 180;
  return {
    sides,
    r1,
    r2,
    arg1,
    arg2: arg1 + Math.PI / sides + (twist * Math.PI) / 180,
    flat: n.type === "polygon",
    rounded: n.rounded || 0,
    randomized: n.randomized || 0,
  };
}

/** An ellipse's arc type as `sodipodi:arc-type`: Inkscape calls an open arc `arc` (ADR-0025). */
const ARC_TYPES = { slice: "slice", chord: "chord", open: "arc" } as const;

/**
 * The `sodipodi:` parameters of an Inkscape arc, from which Inkscape rebuilds a cut ellipse on
 * load (ADR-0025): its centre and radii, its angles in radians at full precision, its arc type.
 * A Node stored before ADR-0025 reads as whole, so it is not an arc.
 */
export function arcAttrs(n: Extract<ShapeNode, { type: "ellipse" }>) {
  const { startAngle = 0, endAngle = 360, arcType = "slice" } = n;
  const [rx, ry] = [n.width / 2, n.height / 2];
  return {
    arc: startAngle !== 0 || endAngle !== 360 || arcType !== "slice",
    cx: n.x + rx,
    cy: n.y + ry,
    rx,
    ry,
    start: (startAngle * Math.PI) / 180,
    end: (endAngle * Math.PI) / 180,
    type: ARC_TYPES[arcType],
    // Inkscape's own writer adds it for readers older than arc-type.
    open: arcType !== "slice",
  };
}

/**
 * The angles and arc type an Inkscape arc holds, the inverse of `arcAttrs` (ADR-0025): degrees
 * within one turn at 3 decimals, a start of 360 read as 0 and an end of 0 as 360. An unknown
 * `arc-type` is a slice; with none, `sodipodi:open` makes an open arc, as Inkscape 1.2.2 reads it.
 */
export function arcOf(p: { start: number; end: number; type: string | null; open: boolean }) {
  const turn = (rad: number) =>
    (Math.round((((((rad * 180) / Math.PI) % 360) + 360) % 360) * 1000) / 1000) % 360;
  const types: Record<string, "chord" | "open"> = { chord: "chord", arc: "open" };
  return {
    startAngle: turn(p.start),
    endAngle: turn(p.end) || 360,
    arcType: p.type === null ? (p.open ? "open" : "slice") : (types[p.type] ?? "slice"),
  } as const;
}

/** Radians as degrees at 9 decimals, which absorbs the float error of the round trip (ADR-0024). */
const degrees = (rad: number) => Math.round(((rad * 180) / Math.PI) * 1e9) / 1e9 || 0;

/**
 * The Live Shape a star's parameters hold, the inverse of `starAttrs`: `angle` from arg1, and a
 * star's `twist` from how far arg2 is off the half step, within ±180°.
 */
export function starOf(p: {
  sides: number;
  r1: number;
  r2: number;
  arg1: number;
  arg2: number;
  flat: boolean;
  rounded: number;
  randomized: number;
}) {
  const common = { angle: degrees(p.arg1 - ARG1), rounded: p.rounded, randomized: p.randomized };
  if (p.flat) return { type: "polygon" as const, radius: p.r1, sides: p.sides, ...common };
  const off = p.arg2 - p.arg1 - Math.PI / p.sides;
  return {
    type: "star" as const,
    outerRadius: p.r1,
    innerRadius: p.r2,
    points: p.sides,
    ...common,
    twist: degrees(off - 2 * Math.PI * Math.round(off / (2 * Math.PI))),
  };
}

/**
 * The `sodipodi:` parameters of an Inkscape spiral, from which Inkscape rebuilds it on load
 * (ADR-0060): Kalamo's own, at full precision, with `argument` in radians.
 */
export function spiralAttrs(n: Extract<ShapeNode, { type: "spiral" }>) {
  return {
    cx: n.cx,
    cy: n.cy,
    radius: n.radius,
    revolution: n.revolution,
    expansion: n.expansion,
    argument: (n.argument * Math.PI) / 180,
    t0: n.t0,
  };
}

/** The Live Shape a spiral's parameters hold, the inverse of `spiralAttrs`. */
export function spiralOf(p: {
  cx: number;
  cy: number;
  radius: number;
  revolution: number;
  expansion: number;
  argument: number;
  t0: number;
}) {
  return { type: "spiral" as const, ...p, argument: degrees(p.argument) };
}
