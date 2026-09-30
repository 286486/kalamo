// Kalamo's side of the rectangle cases in `probe.mjs` (#203): the same texts laid out by core's
// `layoutText` in the same 180 × 300 rectangle at (20, 40), in pt. Run from the repo root:
// `node --experimental-transform-types docs/research/09-shaped-bands/kalamo.ts`. It prints, for
// each `rect` text, each line's baseline and word count, then, for each threshold case, the frame
// height at which Kalamo first shows the line, 90 % of that line's leading (the rule before
// ADR-0083) and the line's baseline below the frame's top.
import { layoutText } from "../../../packages/core/src/text.ts";

const SIZE = 20;
const H = "HHH";
/** The Latin `rect` texts of `probe.mjs`'s TEXTS, each word a string at 20 pt or `[word, size]`. */
const TEXTS: Record<string, (string | [string, number])[]> = {
  "big-3rd": [H, H, [H, 40], ...Array(9).fill(H)],
  "big-4th": [H, H, H, [H, 40], ...Array(8).fill(H)],
  "big-5th": [H, H, H, H, [H, 40], ...Array(8).fill(H)],
  wide: [H, H, "H".repeat(40), H, H],
};

function text(words: (string | [string, number])[], leading: number | undefined, height: number) {
  let content = "";
  const ranges = [];
  for (const w of words) {
    if (content) content += " ";
    const [word, size] = typeof w === "string" ? [w, SIZE] : w;
    if (size !== SIZE)
      ranges.push({ start: content.length, end: content.length + word.length, fontSize: size });
    content += word;
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

for (const [name, words] of Object.entries(TEXTS)) {
  for (const leading of [undefined, 30]) {
    const { lines, overflow } = text(words, leading, 300);
    for (const l of lines) {
      const count = l.text.split(" ").filter(Boolean).length;
      console.log(`rect\t${name}\t${leading ?? "auto"}\t${l.y.toFixed(2)}\t${count}`);
    }
    if (overflow) console.log(`rect\t${name}\t${leading ?? "auto"}\toverflow\t${overflow}`);
  }
}

for (const size of [20, 40, 10]) {
  for (const leading of [undefined, 30]) {
    const words = [size === SIZE ? H : ([H, size] as [string, number])];
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
