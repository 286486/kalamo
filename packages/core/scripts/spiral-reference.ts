// Measures shapeSegments' spirals against Inkscape's (ADR-0060) and writes src/spiral.inkscape.json:
// `node --experimental-transform-types packages/core/scripts/spiral-reference.ts`. Needs Inkscape
// 1.2.2 on PATH. Rerun it when the spiral geometry changes.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePath, type Segment, shapeSegments } from "../src/path.ts";

type Params = Record<
  "cx" | "cy" | "radius" | "revolution" | "expansion" | "argument" | "t0",
  number
>;

/** Random spirals from a seed, across the ranges ADR-0060 measured. */
function random(n: number, seed: number): Params[] {
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
    return {
      cx: round(pick(-500, 500), 3),
      cy: round(pick(-500, 500), 3),
      radius: round(log(0.5, 3000), 3),
      revolution: round(log(0.05, k === 5 ? 200 : 30), 4),
      expansion: round(k === 0 ? log(0.001, 1) : k === 1 ? log(5, 60) : log(0.1, 6), 4),
      argument: round(pick(-400, 400), 4),
      t0: round(k < 3 ? 0 : pick(0, 0.999), 5),
    };
  });
}

/** Round numbers and the ends of each range. */
const SPECIAL: Params[] = [
  { cx: 100, cy: 100, radius: 50, revolution: 3, expansion: 1, argument: 0, t0: 0 },
  { cx: 0, cy: 0, radius: 0, revolution: 3, expansion: 1, argument: 0, t0: 0 },
  { cx: 10, cy: 20, radius: 80, revolution: 3, expansion: 0, argument: 45, t0: 0 },
  { cx: 10, cy: 20, radius: 80, revolution: 3, expansion: 1, argument: 0, t0: 0.999 },
  { cx: 10, cy: 20, radius: 80, revolution: 0.05, expansion: 1, argument: -90, t0: 0 },
  { cx: 10, cy: 20, radius: 80, revolution: 3, expansion: 12, argument: 0, t0: 0 },
  { cx: -40.5, cy: 7.25, radius: 1500, revolution: 2.5, expansion: 0.5, argument: 30, t0: 0.1 },
];

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

/** Whether ours matches Inkscape's to 0.01 units, or 1e-6 of a coordinate beyond 1e4. */
const matches = (ours: Segment[], theirs: Segment[]) =>
  ours.length === theirs.length &&
  ours.every(
    (s, j) =>
      s.cmd === theirs[j]?.cmd &&
      s.args.every((v, k) => {
        const want = theirs[j]?.args[k] ?? Number.NaN;
        return Math.abs(v - want) < Math.max(0.01, Math.abs(want) * 1e-6);
      }),
  );

const sampled = [...random(300, 777), ...random(400, 4242)];
const all = [...SPECIAL, ...sampled];
const drawn = inkscape(all);
const results = all.map((p, i) => {
  const d = drawn[i] as string;
  return { p, d, ok: matches(shapeSegments({ type: "spiral", ...p }), normalizePath(d, "d")) };
});
const missed = results.slice(SPECIAL.length).filter((r) => !r.ok);
console.log(
  `${sampled.length - missed.length} of ${sampled.length} sampled spirals match Inkscape`,
);
for (const r of missed) console.log("differs:", JSON.stringify(r.p));
if (results.slice(0, SPECIAL.length).some((r) => !r.ok))
  throw new Error("A special spiral differs");
// The special ones, and the first 30 matching samples of the second seed short enough to keep.
const kept = [
  ...results.slice(0, SPECIAL.length),
  ...results
    .slice(SPECIAL.length + 300)
    .filter((r) => r.ok && r.d.length < 2500)
    .slice(0, 30),
];
writeFileSync(
  new URL("../src/spiral.inkscape.json", import.meta.url),
  `${JSON.stringify(
    kept.map((r) => ({ ...r.p, d: r.d })),
    null,
    2,
  )}\n`,
);
