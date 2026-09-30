// Kalamo's `lineBreakUnits` against Pango 1.50.12 on random strings (#222, ADR-0085). Run from the
// repo root: `node --experimental-transform-types docs/research/10-latin-breaks/check.ts [latin|cjk]`.
// It prints each difference by the rule Kalamo leaves out. `latin` draws from Latin letters, digits,
// spaces, `/-–‐‒|()"'.,$%`, a combining mark, Hebrew and CJK; `cjk` from ADR-0064's alphabet.
import { execFileSync } from "node:child_process";
import { lineBreakUnits } from "../../../packages/core/src/line-break.ts";

const POOLS = {
  latin: [..."abcxyz0123  /-–‐‒|()\"'.,$%́אב字中「」，。"],
  cjk: [..."字中文我かなカナっャ한국「」（）『』，。、！？ー々・!),.:;?]}\"'-/|([{$%abc0123 "],
};
const pool = POOLS[(process.argv[2] ?? "latin") as keyof typeof POOLS];
let seed = 1;
const rnd = (k: number) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) % k;
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
  for (const u of units.slice(0, -1)) at.add((i += [...u].length));
  return at;
};
const CJK = /[　-〿぀-ヿ一-鿿가-힯！-ￜ]/u;
const MARK = /\p{M}/u;
const counts = new Map<string, number>();
let differ = 0;
strings.forEach((s, k) => {
  const cps = [...s];
  const [p, q] = [breaks(pango[k] as string[]), breaks(lineBreakUnits(s))];
  let d = false;
  for (let i = 1; i < cps.length; i++) {
    if (p.has(i) === q.has(i)) continue;
    d = true;
    let j = i - 1;
    while (j > 0 && MARK.test(cps[j] as string)) j--;
    const [base, next] = [cps[j] as string, cps[i] as string];
    const rule = /\s/.test(cps[i - 1] as string)
      ? "a space before it: LB13 to LB16, across spaces"
      : j === 0 && MARK.test(base)
        ? "a mark starting the string"
        : CJK.test(base) || CJK.test(next) || CJK.test(cps[i - 1] as string)
          ? "a CJK neighbour: ADR-0064's pairs"
          : /[-/|‐‒–]/.test(base)
            ? `after / - or BA: ${base}|${next}`
            : /[.,:;)\]}$%]/.test(base) && /[0-9([{$%]/.test(next)
              ? "IS, CL, CP, PR or PO before NU, OP, PR or PO"
              : /[!?]/.test(base)
                ? "EX before anything"
                : /[\]}]/.test(base) && /\p{L}/u.test(next)
                  ? "CL before a letter"
                  : `other: ${base}|${next}`;
    counts.set(rule, (counts.get(rule) ?? 0) + 1);
  }
  if (d) differ++;
});
console.log(`${strings.length} strings, ${differ} with a break that differs from Pango's`);
for (const [rule, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(n, rule);
