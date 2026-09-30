// Kalamo's `lineBreakUnits` against Pango 1.50.12 on random strings (#222, ADR-0085; #224, ADR-0086).
// Run from the repo root: `node --experimental-transform-types docs/research/10-latin-breaks/check.ts
// [latin|cjk] [ref]`. It prints each difference by the rule Kalamo leaves out. `latin` draws from
// Latin letters, digits, spaces, U+00A0, U+202F, `/-–‐‒|()"'.,$%`, a combining mark, Hebrew and CJK;
// `cjk` from ADR-0064's alphabet.
// With a git ref, such as 2070333 or f14ce8c, it also counts the strings whose breaks changed from
// that ref's `line-break.ts`, and the changed positions where Kalamo now differs from Pango or that
// are neither after `/`, `-` or BA without a CJK neighbour (ADR-0085) nor beside a no-break space
// (ADR-0086).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lineBreakUnits } from "../../../packages/core/src/line-break.ts";

const POOLS = {
  latin: [..."abcxyz0123  \u00A0\u202F/-–‐‒|()\"'.,$%́אב字中「」，。"],
  cjk: [..."字中文我かなカナっャ한국「」（）『』，。、！？ー々・!),.:;?]}\"'-/|([{$%abc0123 "],
};
const [poolName = "latin", ref] = process.argv.slice(2);
const pool = POOLS[poolName as keyof typeof POOLS];
let seed = 1;
const rnd = (k: number) => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return (seed >>> 8) % k;
};
const strings = Array.from({ length: 20_000 }, () =>
  Array.from({ length: 2 + rnd(10) }, () => pool[rnd(pool.length)]).join(""),
);
const pango: string[][] = execFileSync("python3", [new URL("pango.py", import.meta.url).pathname], {
  input: strings.map((s) => JSON.stringify(s)).join("\n"),
  maxBuffer: 1 << 28,
})
  .toString()
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

const breaks = (units: string[]) => {
  const at = new Set<number>();
  let i = 0;
  for (const u of units.slice(0, -1)) {
    i += [...u].length;
    at.add(i);
  }
  return at;
};
const CJK = /[　-〿぀-ヿ一-鿿가-힯！-ￜ]/u;
const MARK = /\p{M}/u;
const BREAK_AFTER = /[-/|‐‒–]/;
const GLUE = /[\u00A0\u202F]/;

/** A position's neighbours: the character before it, its base before any marks, and the next. */
interface At {
  prev: string;
  base: string;
  next: string;
  leadingMark: boolean;
}
const at = (cps: string[], i: number): At => {
  let j = i - 1;
  while (j > 0 && MARK.test(cps[j] as string)) j--;
  const base = cps[j] as string;
  return {
    prev: cps[i - 1] as string,
    base,
    next: cps[i] as string,
    leadingMark: j === 0 && MARK.test(base),
  };
};
const cjkNeighbour = ({ prev, base, next }: At) =>
  CJK.test(base) || CJK.test(next) || CJK.test(prev);

/** The rule a difference from Pango falls under: the first that matches. */
const RULES: [string, (a: At) => boolean][] = [
  [
    "a space before it: LB13 to LB16, across spaces",
    (a) => /\s/.test(a.prev) && !GLUE.test(a.prev),
  ],
  ["beside a no-break space", (a) => GLUE.test(a.prev) || GLUE.test(a.next)],
  ["a mark starting the string", (a) => a.leadingMark],
  ["a CJK neighbour: ADR-0064's pairs", cjkNeighbour],
  ["after / - or BA", (a) => BREAK_AFTER.test(a.base)],
  [
    "IS, CL, CP, PR or PO before NU, OP, PR or PO",
    (a) => /[.,:;)\]}$%]/.test(a.base) && /[0-9([{$%]/.test(a.next),
  ],
  ["EX before anything", (a) => /[!?]/.test(a.base)],
  ["CL before a letter", (a) => /[\]}]/.test(a.base) && /\p{L}/u.test(a.next)],
];

const counts = new Map<string, number>();
let differ = 0;
strings.forEach((s, k) => {
  const cps = [...s];
  const [p, q] = [breaks(pango[k] as string[]), breaks(lineBreakUnits(s))];
  let d = false;
  for (let i = 1; i < cps.length; i++) {
    if (p.has(i) === q.has(i)) continue;
    d = true;
    const a = at(cps, i);
    const rule = RULES.find(([, test]) => test(a))?.[0] ?? "other";
    const key =
      rule === "after / - or BA" || rule === "other" ? `${rule}: ${a.base}|${a.next}` : rule;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (d) differ++;
});
console.log(`${strings.length} strings, ${differ} with a break that differs from Pango's`);
for (const [rule, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(n, rule);

if (ref) {
  const out = join(import.meta.dirname, "out");
  mkdirSync(out, { recursive: true });
  const file = join(out, `line-break-${ref}.ts`);
  writeFileSync(file, execFileSync("git", ["show", `${ref}:packages/core/src/line-break.ts`]));
  const before: typeof lineBreakUnits = (await import(file)).lineBreakUnits;
  let [changed, positions, removed, other] = [0, 0, 0, 0];
  strings.forEach((s, k) => {
    const cps = [...s];
    const [m, q, p] = [breaks(before(s)), breaks(lineBreakUnits(s)), breaks(pango[k] as string[])];
    let c = false;
    for (let i = 1; i < cps.length; i++) {
      if (m.has(i) === q.has(i)) continue;
      c = true;
      positions++;
      if (m.has(i)) removed++;
      const a = at(cps, i);
      const latin = BREAK_AFTER.test(a.base) && !cjkNeighbour(a);
      const glue = GLUE.test(a.prev) || GLUE.test(a.next);
      if (!(latin || glue) || p.has(i) !== q.has(i)) other++;
    }
    if (c) changed++;
  });
  console.log(
    `against ${ref}: ${changed} strings change at ${positions} positions, ${removed} of them a removed break, ${other} not a Pango-matching break after / - or BA without a CJK neighbour or beside a no-break space`,
  );
}
