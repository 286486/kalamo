import { KalamoError } from "./errors.ts";
import type { Rect, Shape } from "./schema.ts";
import { spiralSegments } from "./spiral.ts";

/** One absolute path command with its numbers, e.g. `{cmd: "C", args: [x1, y1, x2, y2, x, y]}`. */
export interface Segment {
  cmd: "M" | "L" | "C" | "Q" | "Z";
  args: number[];
}

const ARITY = { M: 2, L: 2, C: 6, Q: 4, Z: 0 } as const;
const TOKEN = /[\s,]*([A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/y;

/** Parses SVG `d` limited to absolute M, L, C, Q and Z (REQUIREMENTS §6.5). */
export function parsePath(d: string, path: string): Segment[] {
  const fail = (message: string, hint: string): never => {
    throw new KalamoError({ code: "INVALID_PATH", message, hint, path });
  };
  const tokens: string[] = [];
  let end = 0;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(d); m; m = TOKEN.exec(d)) {
    tokens.push(m[1] as string);
    end = TOKEN.lastIndex;
  }
  const rest = d.slice(end).trim();
  if (rest) fail(`Unexpected "${rest.slice(0, 10)}" in d.`, "d holds commands and numbers only.");

  const segments: Segment[] = [];
  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i++] as string;
    if (!/^[A-Za-z]$/.test(cmd)) fail(`Number ${cmd} has no command.`, "Start d with M x y.");
    if (!(cmd in ARITY)) {
      fail(
        `Command "${cmd}" is not supported.`,
        cmd === cmd.toLowerCase()
          ? "Use absolute (uppercase) commands M, L, C, Q and Z, in document coordinates."
          : "Only M, L, C, Q and Z are supported: write H, V as L, S as C, T as Q, and A as C.",
      );
    }
    const c = cmd as Segment["cmd"];
    if (segments.length === 0 && c !== "M") fail(`d starts with ${c}.`, "Start d with M x y.");
    const args: number[] = [];
    while (i < tokens.length && !/^[A-Za-z]$/.test(tokens[i] as string)) {
      const n = Number(tokens[i++]);
      if (!Number.isFinite(n)) fail(`${tokens[i - 1]} is out of range.`, "Use finite numbers.");
      args.push(n);
    }
    const n = ARITY[c];
    if (n === 0 ? args.length > 0 : args.length === 0 || args.length % n !== 0) {
      fail(
        `${c} takes ${n} numbers per segment; got ${args.length}.`,
        "M and L take x y; Q takes x1 y1 x y; C takes x1 y1 x2 y2 x y; Z takes none.",
      );
    }
    if (n === 0) segments.push({ cmd: c, args });
    for (let k = 0; k < args.length; k += n) {
      // After M, extra pairs are implicit L (SVG rule).
      segments.push({ cmd: k > 0 && c === "M" ? "L" : c, args: args.slice(k, k + n) });
    }
  }
  if (segments.length === 0) fail("d is empty.", "Start d with M x y.");
  return segments;
}

type Point = [number, number];

const NUMBER = /[\s,]*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/y;
const FLAG = /[\s,]*([01])/y;
const COMMAND = /[\s,]*([MmLlHhVvCcSsQqTtAaZz])/y;

/**
 * Parses any SVG 1.1 path data into absolute M, L, C, Q and Z (ADR-0017): relative commands and
 * H, V, S, T fold, arcs become cubics. For imported files; `parsePath` stays strict for tool input.
 */
export function normalizePath(d: string, path: string): Segment[] {
  const fail = (message: string, hint = "d is SVG path data starting with M."): never => {
    throw new KalamoError({ code: "INVALID_PATH", message, hint, path });
  };
  let at = 0;
  const read = (re: RegExp) => {
    re.lastIndex = at;
    const m = re.exec(d);
    if (m) at = re.lastIndex;
    return m?.[1];
  };
  const more = () => {
    NUMBER.lastIndex = at;
    return NUMBER.test(d);
  };
  const num = () => {
    const n = Number(read(NUMBER) ?? fail(`Expected a number at ${at} in d.`));
    return Number.isFinite(n) ? n : fail(`A number in d is out of range.`);
  };
  const flag = () => Number(read(FLAG) ?? fail(`Expected an arc flag 0 or 1 at ${at} in d.`));

  const out: Segment[] = [];
  let [x, y, sx, sy] = [0, 0, 0, 0];
  /** The control point S or T reflects, when the previous segment was a C or a Q. */
  let cubic: Point | null = null;
  let quad: Point | null = null;
  const reflect = (p: Point | null): Point => (p ? [2 * x - p[0], 2 * y - p[1]] : [x, y]);
  let closed = false;
  for (let c = read(COMMAND); c !== undefined; c = read(COMMAND)) {
    const C = c.toUpperCase();
    if (out.length === 0 && C !== "M") fail(`d starts with ${c}.`, "Start d with M x y.");
    if (C === "Z") {
      out.push({ cmd: "Z", args: [] });
      [x, y, cubic, quad, closed] = [sx, sy, null, null, true];
      continue;
    }
    if (closed && C !== "M") out.push({ cmd: "M", args: [sx, sy] });
    closed = false;
    const rel = c !== C;
    let first = true;
    do {
      const px = () => num() + (rel ? x : 0);
      const py = () => num() + (rel ? y : 0);
      let nextCubic: Point | null = null;
      let nextQuad: Point | null = null;
      switch (C) {
        case "M":
        case "L": {
          [x, y] = [px(), py()];
          const move = C === "M" && first;
          if (move) [sx, sy] = [x, y];
          out.push({ cmd: move ? "M" : "L", args: [x, y] });
          break;
        }
        case "H":
          x = px();
          out.push({ cmd: "L", args: [x, y] });
          break;
        case "V":
          y = py();
          out.push({ cmd: "L", args: [x, y] });
          break;
        case "C":
        case "S": {
          const [x1, y1]: Point = C === "C" ? [px(), py()] : reflect(cubic);
          const [x2, y2, ex, ey] = [px(), py(), px(), py()];
          out.push({ cmd: "C", args: [x1, y1, x2, y2, ex, ey] });
          nextCubic = [x2, y2];
          [x, y] = [ex, ey];
          break;
        }
        case "Q":
        case "T": {
          const control: Point = C === "Q" ? [px(), py()] : reflect(quad);
          const [ex, ey] = [px(), py()];
          out.push({ cmd: "Q", args: [...control, ex, ey] });
          nextQuad = control;
          [x, y] = [ex, ey];
          break;
        }
        case "A": {
          const [rx, ry, rotation, large, sweep] = [num(), num(), num(), flag(), flag()];
          const [ex, ey] = [px(), py()];
          out.push(...arcToCubics(x, y, rx, ry, rotation, large === 1, sweep === 1, ex, ey));
          [x, y] = [ex, ey];
          break;
        }
      }
      cubic = nextCubic;
      quad = nextQuad;
      first = false;
    } while (more());
  }
  const rest = d.slice(at).trim();
  if (rest) fail(`Unexpected "${rest.slice(0, 10)}" in d.`);
  if (out.length === 0) fail("d is empty.", "Start d with M x y.");
  return out;
}

/** An SVG arc as cubics of at most 90° each (SVG 1.1 F.6.5 endpoint to centre conversion). */
function arcToCubics(
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  rotation: number,
  large: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): Segment[] {
  if (x1 === x2 && y1 === y2) return [];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0) return [{ cmd: "L", args: [x2, y2] }];
  const phi = (rotation * Math.PI) / 180;
  const [cos, sin] = [Math.cos(phi), Math.sin(phi)];
  const [dx, dy] = [(x1 - x2) / 2, (y1 - y2) / 2];
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  // Radii too small to reach the end point scale up until they just do.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) [rx, ry] = [rx * Math.sqrt(lambda), ry * Math.sqrt(lambda)];
  const [rx2, ry2] = [rx * rx, ry * ry];
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (rx2 * ry2 - den) / den));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const [ux, uy] = [(x1p - cxp) / rx, (y1p - cyp) / ry];
  const start = angle(1, 0, ux, uy);
  let delta = angle(ux, uy, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;
  return ellipseCubics(cx, cy, rx, ry, phi, start, delta, [x2, y2]);
}

/**
 * Cubics of at most 90° each along an ellipse rotated by `phi` radians, from parametric angle
 * `start` through `delta` radians, the last one ending exactly at `end` when given.
 */
function ellipseCubics(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  phi: number,
  start: number,
  delta: number,
  end?: [number, number],
): Segment[] {
  const [cos, sin] = [Math.cos(phi), Math.sin(phi)];
  const n = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const at = (t: number) => [
    cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin,
    cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos,
  ];
  const tangent = (t: number) => [
    -rx * Math.sin(t) * cos - ry * Math.cos(t) * sin,
    -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos,
  ];
  return Array.from({ length: n }, (_, i) => {
    const [ta, tb] = [start + i * step, start + (i + 1) * step];
    const [ax = 0, ay = 0] = at(ta);
    const [bx = 0, by = 0] = (i === n - 1 && end) || at(tb);
    const [dax = 0, day = 0] = tangent(ta);
    const [dbx = 0, dby = 0] = tangent(tb);
    return { cmd: "C", args: [ax + k * dax, ay + k * day, bx - k * dbx, by - k * dby, bx, by] };
  });
}

/** At most 3 decimals and no -0 (REQUIREMENTS §6.5). */
export const formatNumber = (n: number) => String(Math.round(n * 1000) / 1000 || 0);

/** `d` with at most 3 decimals (REQUIREMENTS §6.5). */
export function formatPath(segments: Segment[]): string {
  return segments.map((s) => [s.cmd, ...s.args.map(formatNumber)].join(" ")).join(" ");
}

/** Exact bounds of the curves (extrema, not control points), or null for no segments. */
export function pathBounds(segments: Segment[]): Rect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const addX = (x: number) => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
  };
  const addY = (y: number) => {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  };
  let cur = [0, 0];
  let start = [0, 0];
  for (const { cmd, args } of segments) {
    if (cmd === "Z") {
      cur = start;
      continue;
    }
    const end = args.slice(-2);
    const [x0 = 0, y0 = 0] = cur;
    const [x = 0, y = 0] = end;
    addX(x);
    addY(y);
    if (cmd === "C" || cmd === "Q") {
      const px = [x0, ...args.filter((_, k) => k % 2 === 0)];
      const py = [y0, ...args.filter((_, k) => k % 2 === 1)];
      for (const t of extrema(px)) addX(bezier(px, t));
      for (const t of extrema(py)) addY(bezier(py, t));
    }
    if (cmd === "M") start = end;
    cur = end;
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Parameters in (0, 1) where a quadratic (3 points) or cubic (4 points) Bézier is flat on this axis. */
function extrema(p: number[]): number[] {
  const [p0 = 0, p1 = 0, p2 = 0, p3 = 0] = p;
  let roots: number[];
  if (p.length === 3) {
    const den = p0 - 2 * p1 + p2;
    roots = den === 0 ? [] : [(p0 - p1) / den];
  } else {
    // B'(t) / 3 = a t² + b t + c
    const a = -p0 + 3 * p1 - 3 * p2 + p3;
    const b = 2 * (p0 - 2 * p1 + p2);
    const c = p1 - p0;
    if (Math.abs(a) < 1e-12) roots = b === 0 ? [] : [-c / b];
    else {
      const disc = b * b - 4 * a * c;
      roots = disc < 0 ? [] : [(-b + Math.sqrt(disc)) / (2 * a), (-b - Math.sqrt(disc)) / (2 * a)];
    }
  }
  return roots.filter((t) => t > 0 && t < 1);
}

function bezier(p: number[], t: number): number {
  const u = 1 - t;
  const [p0 = 0, p1 = 0, p2 = 0, p3 = 0] = p;
  return p.length === 3
    ? u * u * p0 + 2 * u * t * p1 + t * t * p2
    : u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** 4 (√2 − 1) / 3: cubic control distance that approximates a quarter circle. */
const KAPPA = 0.5522847498307936;

/** Inkscape's stream for one vertex: a seed from its position, then an LCG (ADR-0024). */
function draws(x: number, y: number): number[] {
  const h = (v: number) => {
    const f = Math.floor(1024 * v);
    return (Math.floor(f / 16) % 1024) + (f % 64);
  };
  let s = ((h(x) << 16) + h(y)) >>> 0;
  return Array.from({ length: 4 }, () => {
    s = (Math.imul(69069, s) + 1) >>> 0;
    return (2 * s) / 2 ** 32 - 1;
  });
}

/**
 * A star or polygon as Inkscape draws it (ADR-0024): outer and inner vertices, the first at
 * `angle` clockwise from straight up, each jittered by `randomized`, joined by lines or, when
 * `rounded`, by cubics. A Node stored before ADR-0024 lacks the new fields and reads them as 0.
 */
function starSegments(shape: Extract<Shape, { type: "polygon" | "star" }>): Segment[] {
  const { cx, cy, angle = 0, rounded = 0, randomized = 0 } = shape;
  const star = shape.type === "star";
  const n = star ? shape.points : shape.sides;
  const r1 = star ? shape.outerRadius : shape.radius;
  const r2 = star ? shape.innerRadius : r1;
  const arg1 = -Math.PI / 2 + (angle * Math.PI) / 180;
  const arg2 = arg1 + Math.PI / n + (((star && shape.twist) || 0) * Math.PI) / 180;
  const step = (2 * Math.PI) / n;
  const ring = (x: number, y: number, a: number, b: number) =>
    Array.from({ length: n }, (_, i) =>
      (star
        ? [
            [a, arg1],
            [b, arg2],
          ]
        : [[a, arg1]]
      ).map(([r = 0, arg = 0]) => {
        // The step first, as Inkscape does: a vertex on a 1/1024 grid line seeds from the last bit.
        const t = arg + i * step;
        return [x + r * Math.cos(t), y + r * Math.sin(t)] as const;
      }),
    ).flat();
  const f = Math.fround;
  const U = ring(cx, cy, r1, r2);
  const D = ring(f(cx), f(cy), f(r1), f(r2)).map(([x, y]) => draws(x, y));
  const jitter = randomized * Math.max(r1, r2);
  const V = U.map(([x, y], i) => {
    const [d1 = 0, d2 = 0] = D[i] ?? [];
    return [x + jitter * d1, y + jitter * d2] as const;
  });
  const move: Segment = { cmd: "M", args: [...(V[0] ?? [])] };
  const Z: Segment = { cmd: "Z", args: [] };
  if (rounded === 0)
    return [move, ...V.slice(1).map(([x, y]): Segment => ({ cmd: "L", args: [x, y] })), Z];
  const k = U.length;
  // ponytail: on a twisted, rounded star Inkscape's handles turn a further angle proportional to
  // r1 (2.6e-4 rad at r1 = 80), under a pixel; model it if a round-trip pixel check fails on it.
  const handle = (i: number, length: number, sign: number) => {
    const [px = 0, py = 0] = U[(i + k - 1) % k] ?? [];
    const [qx = 0, qy = 0] = U[(i + 1) % k] ?? [];
    const [, , d3 = 0, d4 = 0] = D[i] ?? [];
    const [vx = 0, vy = 0] = V[i] ?? [];
    const t = Math.atan2(qy - py, qx - px) + ((randomized * Math.PI) / 2) * d3;
    const l = rounded * length * (1 + (randomized * d4) / 2);
    return [vx + sign * l * Math.cos(t), vy + sign * l * Math.sin(t)];
  };
  return [
    move,
    ...U.map(([ux, uy], i): Segment => {
      const j = (i + 1) % k;
      const [wx = 0, wy = 0] = U[j] ?? [];
      const length = Math.hypot(wx - ux, wy - uy);
      return {
        cmd: "C",
        args: [...handle(i, length, 1), ...handle(j, length, -1), ...(V[j] ?? [])],
      };
    }),
    Z,
  ];
}

/** Outline of a Live Shape, or the parsed `d` of a Path. */
export function shapeSegments(shape: Shape): Segment[] {
  const M = (x: number, y: number): Segment => ({ cmd: "M", args: [x, y] });
  const L = (x: number, y: number): Segment => ({ cmd: "L", args: [x, y] });
  const Z: Segment = { cmd: "Z", args: [] };
  switch (shape.type) {
    case "rect": {
      const { x, y, width: w, height: h } = shape;
      const r = Math.min(shape.radius, w / 2, h / 2);
      if (r === 0) return [M(x, y), L(x + w, y), L(x + w, y + h), L(x, y + h), Z];
      const k = r * (1 - KAPPA);
      const C = (...args: number[]): Segment => ({ cmd: "C", args });
      return [
        M(x + r, y),
        L(x + w - r, y),
        C(x + w - k, y, x + w, y + k, x + w, y + r),
        L(x + w, y + h - r),
        C(x + w, y + h - k, x + w - k, y + h, x + w - r, y + h),
        L(x + r, y + h),
        C(x + k, y + h, x, y + h - k, x, y + h - r),
        L(x, y + r),
        C(x, y + k, x + k, y, x + r, y),
        Z,
      ];
    }
    case "ellipse": {
      const rx = shape.width / 2;
      const ry = shape.height / 2;
      const cx = shape.x + rx;
      const cy = shape.y + ry;
      // A Node stored before ADR-0025 has no angles: it is whole.
      const { startAngle = 0, endAngle = 360, arcType = "slice" } = shape;
      const sweep = (((endAngle - startAngle) % 360) + 360) % 360;
      if (sweep > 0) {
        const start = (startAngle * Math.PI) / 180;
        const arc = [
          M(cx + rx * Math.cos(start), cy + ry * Math.sin(start)),
          ...ellipseCubics(cx, cy, rx, ry, 0, start, (sweep * Math.PI) / 180),
        ];
        return arcType === "slice"
          ? [...arc, L(cx, cy), Z]
          : arcType === "chord"
            ? [...arc, Z]
            : arc;
      }
      const kx = rx * KAPPA;
      const ky = ry * KAPPA;
      return [
        M(cx, cy - ry),
        { cmd: "C", args: [cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy] },
        { cmd: "C", args: [cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry] },
        { cmd: "C", args: [cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy] },
        { cmd: "C", args: [cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry] },
        Z,
      ];
    }
    case "line":
      return [M(shape.x1, shape.y1), L(shape.x2, shape.y2)];
    case "polygon":
    case "star":
      return starSegments(shape);
    case "spiral":
      return spiralSegments(shape);
    case "path":
      return parsePath(shape.d, "d");
  }
}
