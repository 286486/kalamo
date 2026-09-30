// Kalamo's side of the rectangle cases in `probe.mjs` (#203): the same texts laid out by core's
// `layoutText` in the same 180 × 300 rectangle at (20, 40), in pt. Run from the repo root:
// `node --experimental-transform-types docs/research/09-shaped-bands/kalamo.ts`. It prints, for
// each `rect` text, each line's baseline and word count, then, for each threshold case, the frame
// height at which Kalamo first shows the line, 90 % of that line's leading (the rule before
// ADR-0083) and the line's baseline below the frame's top.
// Then each `break` case's rows (#221), and it fails when they drift from `results.tsv`.
import { readFileSync } from "node:fs";
import { parsePath, pathBounds } from "../../../packages/core/src/path.ts";
import type { Rect } from "../../../packages/core/src/schema.ts";
import { layoutText } from "../../../packages/core/src/text.ts";

const SIZE = 20;
const H = "HHH";
type Word = string | [string, number];
/** `probe.mjs`'s TEXTS, each a list of paragraphs, each word a string at 20 pt or `[word, pt]`. */
const TEXTS: Record<string, Word[][]> = {
  heading: [
    [
      [H, 40],
      ["HH", 40],
    ],
    Array(12).fill(H),
  ],
  "big-3rd": [[H, H, [H, 40], ...Array(9).fill(H)]],
  "big-4th": [[H, H, H, [H, 40], ...Array(8).fill(H)]],
  "big-5th": [[H, H, H, H, [H, 40], ...Array(8).fill(H)]],
  cjk: [[H, "字", H, H, H, "字", H, H, H, H, "字", H]],
  "cjk-larger": [[H, "字", H, H, H, ["字", 30], H, H, H, H, "字", H]],
  wide: [[H, H, "H".repeat(40), H, H]],
};

function text(paragraphs: Word[][], leading: number | undefined, height: number) {
  let content = "";
  const ranges = [];
  for (const words of paragraphs) {
    if (content) content += "\n";
    words.forEach((w, i) => {
      if (i) content += " ";
      const [word, size] = typeof w === "string" ? [w, SIZE] : w;
      if (size !== SIZE)
        ranges.push({ start: content.length, end: content.length + word.length, fontSize: size });
      content += word;
    });
  }
  return layoutText({
    kind: "area",
    x: 20,
    y: 40,
    width: 180,
    height,
    content,
    fontSize: SIZE,
    leading,
    ranges,
  });
}

for (const [name, paragraphs] of Object.entries(TEXTS)) {
  for (const leading of [undefined, 30]) {
    const { lines, overflow } = text(paragraphs, leading, 300);
    for (const l of lines) {
      const count = l.text.split(" ").filter(Boolean).length;
      console.log(`rect\t${name}\t${leading ?? "auto"}\t${l.y.toFixed(2)}\t${count}`);
    }
    if (overflow) console.log(`rect\t${name}\t${leading ?? "auto"}\toverflow\t${overflow}`);
  }
}

for (const size of [20, 40, 10]) {
  for (const leading of [undefined, 30]) {
    const words: Word[][] = [[size === SIZE ? H : [H, size]]];
    let [lo, hi] = [0, 100];
    while (hi - lo > 0.0005) {
      const mid = (lo + hi) / 2;
      if (text(words, leading, mid).lines.length) hi = mid;
      else lo = mid;
    }
    const baseline = (text(words, leading, hi).lines[0]?.y ?? 0) - 40;
    const ninety = 0.9 * (leading ?? 1.2 * size);
    console.log(
      `threshold\t${size}px\t${leading ?? "auto"}\t${hi.toFixed(3)}\t${ninety.toFixed(3)}\t${baseline.toFixed(2)}`,
    );
  }
}

// A unit wider than its span (#221): `probe.mjs`'s BREAKS, each line of each band as a `break` row
// of `results.tsv` has it, its spans joined, then an `overflow` row for what does not fit.
const arm = (w: number) => `M 20 40 L ${20 + w} 40 L ${20 + w} 120 L 320 120 L 320 340 L 20 340 Z`;
const PATHS: Record<string, string> = {
  U: "M 20 40 L 140 40 L 140 120 L 200 120 L 200 40 L 320 40 L 320 340 L 20 340 Z",
  triangle: "M 20 40 L 320 40 L 170 340 Z",
  slant: "M 20 40 L 200 40 L 200 340 L 120 340 Z",
  neck: "M 20 40 L 50 40 L 50 100 L 320 100 L 320 340 L 20 340 Z",
};
const frameOf = (name: string) => {
  const d = PATHS[name] ?? (name.startsWith("arm") ? arm(Number(name.slice(3))) : undefined);
  if (d) return { frame: d, ...(pathBounds(parsePath(d, "d")) as Rect) };
  return { x: 20, y: 40, width: Number(name.slice(4)), height: 300 };
};
const WIDE = `${H} ${H} ${"H".repeat(40)} ${H} ${H}`;
type Break = [string, string, string, (number | undefined)[]?, object?];
const BREAKS: Break[] = [
  ...["rect180", "U", "triangle", "slant", "neck"].map((f): Break => [f, "wide", WIDE]),
  ...[95, 97, 119, 121].map((w): Break => [`rect${w}`, "wide", WIDE]),
  ...[90, 110, 120].map((w): Break => [`arm${w}`, "mid", `${"H".repeat(15)} ${H} ${H}`]),
  ["rect180", "tracked", WIDE, [undefined, 30], { tracking: 100 }],
  ["rect180", "cjk-unit", `${H} 字${"」".repeat(11)} ${H}`, [undefined]],
  ["rect180", "noto", WIDE, [undefined, 30], { fontFamily: "Noto Sans SC" }],
  ["rect10", "narrow", "HHHHH", [2]],
  // The word's last 20 H's, from 28, are 40 pt.
  ...["rect180", "slant"].map(
    (f): Break => [
      f,
      "big-tail",
      WIDE,
      [undefined, 30],
      { ranges: [{ start: 28, end: 48, fontSize: 40 }] },
    ],
  ),
];
const kalamo = new Map<string, string>();
for (const [frameName, name, content, leadings = [undefined, 30], extra = {}] of BREAKS) {
  for (const leading of leadings) {
    const { lines, overflow } = layoutText({
      kind: "area",
      ...frameOf(frameName),
      content,
      fontSize: SIZE,
      leading,
      ...extra,
    });
    const rows: { y: number; x: number; text: string }[] = [];
    for (const l of lines) {
      const last = rows.at(-1);
      if (last && last.y === l.y) last.text += l.text;
      else rows.push({ y: l.y, x: l.x, text: l.text });
    }
    const id = `break\t${frameName}\t${name}\t${leading ?? "auto"}`;
    const out = rows.map((r) => `${id}\t${r.y.toFixed(2)}\t${+r.x.toFixed(2)}\t${r.text}`);
    // Inkscape writes an overflowing line at the frame's left.
    if (overflow) out.push(`${id}\toverflow\t${frameOf(frameName).x}\t${overflow}`);
    for (const row of out) console.log(row);
    kalamo.set(id, out.join("\n"));
  }
}

// Drift guard: every case gives Inkscape's rows in `results.tsv` exactly, so a case edited here or in
// `probe.mjs` alone fails the run. Only ADR-0084's model differences are compared less: in
// `big-tail` at leading 30 a 40 pt line sits by Illustrator's leading, so each line's characters
// compare but not where it sits, and `slant big-tail` at Auto sizes its first band whole.
const compared = (id: string, rows: string) => {
  if (id === "break\tslant\tbig-tail\tauto") return "";
  if (!id.endsWith("\tbig-tail\t30")) return rows;
  return rows
    .split("\n")
    .map((row) => {
      const [, , , , baseline, , text] = row.split("\t");
      return `${baseline === "overflow" ? "overflow" : "line"}\t${text}`;
    })
    .join("\n");
};
const inkscape = new Map<string, string>();
for (const row of readFileSync(new URL("results.tsv", import.meta.url), "utf8").split("\n")) {
  if (!row.startsWith("break\t")) continue;
  const id = row.split("\t").slice(0, 4).join("\t");
  inkscape.set(id, inkscape.has(id) ? `${inkscape.get(id)}\n${row}` : row);
}
const drift = [...new Set([...inkscape.keys(), ...kalamo.keys()])].filter((id) => {
  const [a, b] = [inkscape.get(id), kalamo.get(id)];
  return a === undefined || b === undefined || compared(id, a) !== compared(id, b);
});
if (drift.length) throw new Error(`break cases differ from results.tsv: ${drift.join(", ")}`);
