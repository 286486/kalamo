// Measures shapeSegments' spirals against Inkscape's (ADR-0060) and writes src/spiral.inkscape.json:
// `node --experimental-transform-types packages/core/scripts/spiral-reference.ts`. Needs Inkscape
// 1.2.2 on PATH. Rerun it when the spiral geometry changes.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePath, type Segment, shapeSegments } from "../src/path.ts";

type Point = [number, number];

type Params = Record<
  "cx" | "cy" | "radius" | "revolution" | "expansion" | "argument" | "t0",
  number
>;

/**
 * Random spirals from a seed, across the ranges ADR-0060 first measured; with `upper`, a third of
 * them take `revolution` 200…1024, a third `expansion` 60…1000, and a third both, drawn from the
 * same number generator calls so that a seed's other parameters are the same either way.
 */
function random(n: number, seed: number, upper = false): Params[] {
  let s = seed;
  const rnd = () => {
    s = (Math.imul(s, 69069) + 1) >>> 0;
    return s / 2 ** 32;
  };
  const pick = (a: number, b: number) => a + (b - a) * rnd();
  const log = (a: number, b: number) => Math.exp(pick(Math.log(a), Math.log(b)));
  const round = (v: number, k: number) => Number(v.toFixed(k));
  return Array.from({ length: n }, (_, i) => {
    const k = i % 6;
    const highRevolution = upper && k % 3 !== 1;
    const highExpansion = upper && k % 3 !== 0;
    return {
      cx: round(pick(-500, 500), 3),
      cy: round(pick(-500, 500), 3),
      radius: round(log(0.5, 3000), 3),
      revolution: round(highRevolution ? log(200, 1024) : log(0.05, k === 5 ? 200 : 30), 4),
      expansion: round(
        highExpansion
          ? log(60, 1000)
          : k === 0
            ? log(0.001, 1)
            : k === 1
              ? log(5, 60)
              : log(0.1, 6),
        4,
      ),
      argument: round(pick(-400, 400), 4),
      t0: round(k < 3 ? 0 : pick(0, 0.999), 5),
    };
  });
}

/** Round numbers and the ends of each range ADR-0060 first measured. */
const SPECIAL: Params[] = [
  { cx: 100, cy: 100, radius: 50, revolution: 3, expansion: 1, argument: 0, t0: 0 },
  { cx: 0, cy: 0, radius: 0, revolution: 3, expansion: 1, argument: 0, t0: 0 },
  { cx: 10, cy: 20, radius: 80, revolution: 3, expansion: 0, argument: 45, t0: 0 },
  { cx: 10, cy: 20, radius: 80, revolution: 3, expansion: 1, argument: 0, t0: 0.999 },
  { cx: 10, cy: 20, radius: 80, revolution: 0.05, expansion: 1, argument: -90, t0: 0 },
  { cx: 10, cy: 20, radius: 80, revolution: 3, expansion: 12, argument: 0, t0: 0 },
  { cx: -40.5, cy: 7.25, radius: 1500, revolution: 2.5, expansion: 0.5, argument: 30, t0: 0.1 },
];

/** The ends of the public ranges and the defaults: revolution 0.05, 3 and 1024 by expansion 0, 1 and 1000. */
const ENDS: Params[] = [0.05, 3, 1024].flatMap((revolution) =>
  [0, 1, 1000].flatMap((expansion) =>
    [0, 0.999].map((t0) => ({
      cx: 10,
      cy: 20,
      radius: 80,
      revolution,
      expansion,
      argument: 30,
      t0,
    })),
  ),
);

/** The spirals whose piece next to the centre differed from Inkscape's before #256. */
const CENTRE: Params[] = (
  [
    [-406.206, -268.001, 1326.874, 250.9563, 0.0657, -156.1244],
    [-341.126, -250.657, 1032.717, 0.2761, 5.3781, -244.5373],
    [59.775, -418.972, 40.776, 0.1546, 0.0012, -188.9218],
    [-208.3, -89.702, 1033.083, 225.5618, 0.1489, -53.389],
    [162.033, 486.129, 1888.025, 0.6895, 16.9255, -167.8902],
    [61.517, -58.111, 769.542, 816.3934, 0.146, 349.4883],
    [-128.715, -248.023, 441.762, 0.3422, 9.135, 115.9292],
    [15.926, -13.589, 1259.339, 0.613, 4.067, -232.5551],
  ] as [number, number, number, number, number, number][]
).map(([cx, cy, radius, revolution, expansion, argument]) => ({
  cx,
  cy,
  radius,
  revolution,
  expansion,
  argument,
  t0: 0,
}));

/** Each spiral's d as Inkscape's object-to-path writes it. */
function inkscape(spirals: Params[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), "spiral-"));
  const paths = spirals.map((p, i) => {
    const attrs = Object.entries({ ...p, argument: (p.argument * Math.PI) / 180 })
      .map(([k, v]) => `sodipodi:${k}="${v}"`)
      .join(" ");
    return `<path id="s${i}" sodipodi:type="spiral" ${attrs} d="M 0 0"/>`;
  });
  writeFileSync(
    join(dir, "in.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd">${paths.join("")}</svg>`,
  );
  execFileSync(
    "inkscape",
    [
      join(dir, "in.svg"),
      "--actions=select-all;object-to-path",
      "--export-plain-svg",
      "--export-type=svg",
      `--export-filename=${join(dir, "out.svg")}`,
    ],
    { stdio: "ignore" },
  );
  const out = readFileSync(join(dir, "out.svg"), "utf8");
  return spirals.map((_, i) => {
    const d = new RegExp(`<path\\s+id="s${i}"[^>]*?\\sd="([^"]*)"`, "s").exec(out)?.[1];
    if (d === undefined) throw new Error(`Inkscape wrote no d for spiral ${i}`);
    return d.replace(/\s+/g, " ");
  });
}

/** Whether two segments are the same to 0.01 units, or 1e-6 of a coordinate beyond 1e4. */
const same = (a: Segment | undefined, b: Segment | undefined) =>
  a !== undefined &&
  a.cmd === b?.cmd &&
  a.args.every((v, k) => {
    const want = b.args[k] ?? Number.NaN;
    return Math.abs(v - want) < Math.max(0.01, Math.abs(want) * 1e-6);
  });

/** Whether ours matches Inkscape's, segment by segment. */
const matches = (ours: Segment[], theirs: Segment[]) =>
  ours.length === theirs.length && ours.every((s, j) => same(s, theirs[j]));

/** Some point is non-finite or huge: the samples ran past t = 1 (ADR-0060). */
const huge = (segs: Segment[]) => segs.some((s) => s.args.some((v) => !(Math.abs(v) < 1e6)));

/** Points along segments [from, to) of a path, 32 per cubic, from the end of the one before. */
function polyline(segs: Segment[], from: number, to: number): Point[] {
  const start = (segs[from - 1]?.args.slice(-2) ?? [0, 0]) as Point;
  const out = [start];
  let [x, y] = start;
  for (const { cmd, args } of segs.slice(from, to)) {
    if (cmd === "C") {
      const [x1, y1, x2, y2, x3, y3] = args as [number, number, number, number, number, number];
      for (let i = 1; i <= 32; i++) {
        const t = i / 32;
        const u = 1 - t;
        out.push([
          u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
          u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
        ]);
      }
    } else out.push(args.slice(-2) as Point);
    [x, y] = out.at(-1) as Point;
  }
  return out;
}

/** The farthest any point of `a` lies from the polyline `b`. */
function farthest(a: Point[], b: Point[]): number {
  let worst = 0;
  for (const [px, py] of a) {
    let near = Number.POSITIVE_INFINITY;
    for (let i = 1; i < b.length; i++) {
      const [ax, ay] = b[i - 1] as Point;
      const [bx, by] = b[i] as Point;
      const dx = bx - ax;
      const dy = by - ay;
      const t = Math.max(
        0,
        Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)),
      );
      near = Math.min(near, Math.hypot(px - ax - t * dx, py - ay - t * dy));
    }
    worst = Math.max(worst, near);
  }
  return worst;
}

/** How far apart the two outlines lie where their segments differ, both ways round. */
function deviation(ours: Segment[], theirs: Segment[]): number {
  let head = 0;
  while (same(ours[head], theirs[head])) head++;
  let tail = 0;
  while (same(ours.at(-1 - tail), theirs.at(-1 - tail))) tail++;
  const a = polyline(ours, head, ours.length - tail);
  const b = polyline(theirs, head, theirs.length - tail);
  return Math.max(farthest(a, b), farthest(b, a));
}

const sampled = [...random(300, 777), ...random(400, 4242)];
const upper = random(600, 9157, true);
const all = [...SPECIAL, ...ENDS, ...sampled, ...upper];
const drawn = inkscape(all);
const results = all.map((p, i) => {
  const d = drawn[i] as string;
  const ours = shapeSegments({ type: "spiral", ...p });
  const theirs = normalizePath(d, "d");
  const ok = matches(ours, theirs);
  const out = !ok && huge(theirs) && huge(ours);
  return { p, d, ok, out, off: ok || out ? 0 : deviation(ours, theirs) };
});
const special = results.slice(0, SPECIAL.length);
const ends = results.slice(SPECIAL.length, SPECIAL.length + ENDS.length);
const first = results.slice(SPECIAL.length + ENDS.length, -upper.length);
const full = results.slice(-upper.length);
for (const [name, rs] of [
  ["first 700", first],
  ["full-range 600", full],
  ["range ends", ends],
] as const) {
  const differ = rs.filter((r) => !r.ok && !r.out);
  const worst = Math.max(0, ...differ.map((r) => r.off));
  console.log(
    `${name}: ${rs.filter((r) => r.ok).length} match, ${differ.length} differ (at most ${worst.toFixed(2)} units apart), ${rs.filter((r) => r.out).length} out of comparison`,
  );
  for (const r of differ) console.log("  differs:", r.off.toFixed(2), JSON.stringify(r.p));
  for (const r of rs.filter((r) => r.out)) console.log("  out of comparison:", JSON.stringify(r.p));
}
if (special.some((r) => !r.ok)) throw new Error("A special spiral differs");
if (ends.some((r) => !r.ok && !r.out)) throw new Error("A range end differs");
const centre = [...first, ...full].filter((r) =>
  CENTRE.some((c) => Object.entries(c).every(([k, v]) => r.p[k as keyof Params] === v)),
);
if (centre.length !== CENTRE.length) throw new Error("A centre spiral is no longer sampled");
// The special ones, the range ends short enough to keep, the first 30 matching samples of the
// second seed and the first 10 of the full-range one short enough to keep, and the centre ones
// short enough to keep.
const short = (r: (typeof results)[number], n: number) => r.ok && r.d.length < n;
const kept = [
  ...special,
  ...ends.filter((r) => short(r, 20000)),
  ...first
    .slice(300)
    .filter((r) => short(r, 2500))
    .slice(0, 30),
  ...full.filter((r) => short(r, 20000)).slice(0, 10),
  ...centre.filter((r) => short(r, 20000)),
];
writeFileSync(
  new URL("../src/spiral.inkscape.json", import.meta.url),
  `${JSON.stringify(
    kept.map((r) => ({ ...r.p, d: r.d })),
    null,
    2,
  )}\n`,
);
