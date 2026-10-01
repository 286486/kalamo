// #203's layout check, as ADR-0084 ran it, for ADR-0095 (ADR-0085 ran it before the no-break joins,
// ADR-0087 before the EX, IN, B2 and ZW joins, ADR-0093 before the soft-hyphen joins, ADR-0094
// before the sign joins).
// Run from the repo root: `node --experimental-transform-types
// docs/research/10-latin-breaks/regress.ts <ref> [n]`. It lays out n random Area Types, 60,000 by
// default, with that ref's core, extracted to `out/`, and with this checkout's, and counts the texts
// whose `layoutText`, `glyphs`, `pointType` or `areaFrame` differ. Against 9d032c7, each changed text
// should hold one of `,.:;)]}` or a PR or PO character.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as next from "../../../packages/core/src/text.ts";

const [ref, count = "60000"] = process.argv.slice(2);
if (!ref) throw new Error("usage: regress.ts <ref> [n]");
const out = join(import.meta.dirname, "out", ref);
mkdirSync(out, { recursive: true });
execFileSync("sh", ["-c", `git archive ${ref} packages/core/src | tar -x -C ${out}`]);
const before: typeof next = await import(join(out, "packages/core/src/text.ts"));

let seed = 7;
const rnd = (k: number) => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return (seed >>> 8) % k;
};
const pick = <T>(a: readonly T[]) => a[rnd(a.length)] as T;
const WORDS = [
  "a",
  "the",
  "HHH",
  "well",
  "known",
  "state",
  "of",
  "art",
  "2026",
  "12",
  "5",
  "字",
  "中文",
  "「字」",
  "example",
  "com",
  "x",
  "Supercalifragilistic",
];
const JOIN = [
  ...[" ", " ", " ", " ", "/", "-", "–", "|", "‐", "‒", "‧", ".", "\n", "  ", ", "],
  ...["\u00A0", "\u2007", "\u202F", "\uFEFF", " \u00A0", "-\u00A0"],
  ...["!", "?", "? ", "…", "‥", "—", "——", " — ", "\u200B", "!)", "?\u200B"],
  ...["\u00AD", "\u00AD", "\u00AD\u00AD", "\u00AD ", "-\u00AD", "\u00AD)"],
  ...[")(", "](", "}", ",$", ":\\", ":", ".", ",", "$", "%", "%$", "$$", ")$", "(", ")", "}("],
];
const FRAMES = [
  undefined,
  undefined,
  // A U, a triangle and a neck, as #203 draws them.
  "M 0 0 L 200 0 L 200 300 L 80 300 L 80 80 L 40 80 L 40 300 L 0 300 Z",
  "M 0 0 L 240 0 L 120 300 Z",
  "M 0 0 L 30 0 L 30 100 L 200 100 L 200 300 L 0 300 Z",
];
/** The IS, CP, CL, PR and PO characters the words and joins draw. */
const NEW = /[,.:;)\]}$%]/;

let [changed, without, holding] = [0, 0, 0];
for (let i = 0; i < Number(count); i++) {
  let content = pick(WORDS);
  for (let k = rnd(25); k > 0; k--) content += pick(JOIN) + pick(WORDS);
  const len = [...content].length;
  const frame = pick(FRAMES);
  const fontSize = pick([10, 12, 14, 20]);
  const ranges = rnd(2)
    ? []
    : Array.from({ length: 1 + rnd(3) }, () => {
        const start = rnd(len);
        return {
          start,
          end: start + 1 + rnd(len - start),
          ...(rnd(2) ? { fontSize: pick([8, 20, 30, 40]) } : {}),
          ...(rnd(2) ? { tracking: pick([-100, 200, 500]) } : {}),
          ...(rnd(2) ? { fill: "#ff0000" } : {}),
        };
      });
  const text = {
    kind: "area" as const,
    x: 10,
    y: 20,
    width: frame ? (frame.includes("240") ? 240 : 200) : 40 + rnd(260),
    height: frame ? 300 : 30 + rnd(270),
    frame,
    content,
    fontSize,
    leading: pick([undefined, 15, 30]),
    tracking: pick([undefined, 0, 100]),
    alignment: pick([undefined, "center", "right", "justify"] as const),
    ranges: ranges.length ? ranges : undefined,
  };
  const laid = (m: typeof next) =>
    JSON.stringify([m.layoutText(text), m.glyphs(text), m.pointType(text), m.areaFrame(text)]);
  const has = NEW.test(content);
  if (has) holding++;
  if (laid(next) === laid(before)) continue;
  changed++;
  if (!has) {
    without++;
    if (without <= 5) console.log("changed without one:", JSON.stringify(text));
  }
}
console.log(
  `${count} texts, ${holding} hold IS, CP, CL, PR or PO; ${changed} changed, ${without} of them without one`,
);
