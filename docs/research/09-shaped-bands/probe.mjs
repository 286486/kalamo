// Measures where Inkscape 1.2.2 draws each word of a shaped Area Type (`shape-inside` a path) whose
// lines mix sizes or hold CJK (#200). Run from the repo root: `node
// docs/research/09-shaped-bands/probe.mjs`, which prints `results.tsv`. Each case is an SVG in
// `out/` next to this file. Every word is a tspan of its own; its ink box from `--query-all` gives
// its left edge and, for a word of H's, its baseline. Fonts are the bundled ones, through fonts.conf
// as `pnpm roundtrip` sets them.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const HERE = import.meta.dirname;
const OUT = join(HERE, "out");
const FONTS = resolve(HERE, "../../../packages/render/fonts");
mkdirSync(OUT, { recursive: true });
const conf = join(OUT, "fonts.conf");
const accept = ["NotoSansSC", "NotoSansKR"].map(
  (f) =>
    `<acceptfont><pattern><patelt name="file"><string>${FONTS}/${f}-Regular.otf</string></patelt></pattern></acceptfont>`,
);
const reject = ["zh-cn", "zh-tw", "ja", "ko"].map(
  (l) =>
    `<rejectfont><pattern><patelt name="lang"><string>${l}</string></patelt></pattern></rejectfont>`,
);
writeFileSync(
  conf,
  `<?xml version="1.0"?><fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include><dir>${FONTS}</dir><selectfont>${accept.join("")}${reject.join("")}</selectfont><match target="pattern"><edit name="family" mode="append" binding="weak"><string>Noto Sans SC</string><string>Noto Sans KR</string></edit></match><cachedir>${OUT}/fontconfig</cachedir></fontconfig>`,
);

const SIZE = 20;
/** Source Sans 3's and Noto Sans SC's em-box ascents, as core's FAMILIES has them. */
const [SOURCE, NOTO] = [1000 / 1326, 0.88];
/** An "H" at 20 px starts 1.8 right of its origin: its left side bearing, 0.09 em. */
const LSB = 0.09;

/** The frames, path data in the SVG's own coordinates. */
const FRAMES = {
  // A U whose two arms, 120 wide and 80 deep, give their bands two spans.
  U: "M 20 40 L 140 40 L 140 120 L 200 120 L 200 40 L 320 40 L 320 340 L 20 340 Z",
  // A triangle whose bands narrow downward.
  triangle: "M 20 40 L 320 40 L 170 340 Z",
  // A left edge slanting right, x = 20 + (y − 40) / 3: a line starts where it is at its band's bottom.
  slant: "M 20 40 L 200 40 L 200 340 L 120 340 Z",
  // A neck 30 wide above y 100, too narrow for any word.
  neck: "M 20 40 L 50 40 L 50 100 L 320 100 L 320 340 L 20 340 Z",
};

const H = "HHH";
const big = (w = H, size = 40) => ({ w, size });
const cjk = (w = "字", size) => ({ w, size, cjk: true });
/** Each text's paragraphs, each a list of words: a string at 20 px, or a larger or CJK run. */
const TEXTS = {
  // A heading paragraph at 40 px, then body text.
  heading: [[big(), big("HH")], Array(12).fill(H)],
  // A 40 px word on the first line: its band is sized by it.
  "big-3rd": [[H, H, big(), ...Array(9).fill(H)]],
  // A 40 px word that does not fit after three: the first line is sized by it all the same.
  "big-4th": [[H, H, H, big(), ...Array(8).fill(H)]],
  // A 40 px word that ends a first line of four 20 px words: once it sizes the band, only three fit.
  "big-5th": [[H, H, H, H, big(), ...Array(8).fill(H)]],
  // CJK in Noto Sans SC beside Source Sans 3, exported with ADR-0080's run line-height.
  cjk: [[H, cjk(), H, H, H, cjk(), H, H, H, H, cjk(), H]],
  // The same with a 30 px CJK run.
  "cjk-larger": [[H, cjk(), H, H, H, cjk("字", 30), H, H, H, H, cjk(), H]],
};

const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
/** ADR-0080's run line-height for a CJK run of `size` under `leading` (undefined for Auto). */
const runLineHeight = (leading, size) => {
  const floor = (v) => Math.floor(v * 1000) / 1000;
  return leading
    ? `${floor(leading - 2 * (NOTO - SOURCE) * size)}px`
    : floor(1.2 - 2 * (NOTO - SOURCE));
};

function svg(frame, paragraphs, leading) {
  let n = 0;
  const body = paragraphs
    .map((words) =>
      words
        .map((w) => {
          const { w: t, size, cjk: isCjk } = typeof w === "string" ? { w } : w;
          const css = [
            size && `font-size:${size}px`,
            isCjk && `line-height:${runLineHeight(leading, size ?? SIZE)}`,
          ].filter(Boolean);
          return `<tspan id="w${n++}"${css.length ? ` style="${css.join(";")}"` : ""}>${esc(t)}</tspan>`;
        })
        .join(" "),
    )
    .join("&#10;");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">
<defs><path id="frame" d="${frame}"/></defs>
<text id="t" font-family="Source Sans 3" font-size="${SIZE}" style="shape-inside:url(#frame);white-space:pre;font-kerning:none;line-height:${leading ? `${leading}px` : "1.2"}" xml:space="preserve">${body}</text>
</svg>`;
}

/** Each word's ink box `[x, y, width, height]`, or null where Inkscape draws it nowhere. */
function boxes(file, n) {
  const run = spawnSync("inkscape", ["--query-all", file], {
    encoding: "utf8",
    env: { ...process.env, FONTCONFIG_FILE: conf },
  });
  const rows = new Map(
    run.stdout
      .trim()
      .split("\n")
      .map((r) => r.split(","))
      .map(([id, ...v]) => [id, v.map(Number)]),
  );
  return Array.from({ length: n }, (_, i) => {
    const r = rows.get(`w${i}`);
    return r && r[3] > 0 ? r : null;
  });
}

/** How far a 字's ink reaches below its baseline, in its em, from the U frame's lines. */
const CJK_DROP = 0.0791;

/**
 * The lines Inkscape draws: each line's baseline, from its words of H's, and its words, each as
 * its index, its origin's x (its ink's left less the H's side bearing) and its size.
 */
function lines(words, b) {
  const out = [];
  words.forEach((w, i) => {
    const { size = SIZE, cjk: isCjk } = typeof w === "string" ? {} : w;
    const box = b[i];
    if (!box) return;
    const bottom = box[1] + box[3];
    const y = isCjk ? bottom - CJK_DROP * size : bottom;
    const x = isCjk ? box[0] : box[0] - LSB * size;
    const last = out.at(-1);
    // A word left of the one before or on another baseline starts a line, and so does a gap wider
    // than a space, which starts the band's next span.
    if (!last || Math.abs(y - last.y) > 1 || x < last.end || x - last.end > 0.5 * size) {
      out.push({ y, exact: false, words: [], end: 0 });
    }
    const l = out.at(-1);
    if (!isCjk && !l.exact) [l.y, l.exact] = [y, true];
    l.words.push(`${i}${size === SIZE ? "" : `@${size}`}${isCjk ? "cjk" : ""}:${+x.toFixed(2)}`);
    l.end = box[0] + box[2];
  });
  return out.map((l) => ({ ...l, y: l.exact ? +l.y.toFixed(2) : `~${+l.y.toFixed(1)}` }));
}

const only = process.argv[2];
for (const [frameName, frame] of Object.entries(FRAMES)) {
  for (const [name, paragraphs] of Object.entries(TEXTS)) {
    for (const leading of [undefined, 30]) {
      const id = `${frameName}-${name}-${leading ?? "auto"}`;
      if (only && !id.includes(only)) continue;
      const file = join(OUT, `${id}.svg`);
      writeFileSync(file, svg(frame, paragraphs, leading));
      const words = paragraphs.flat();
      for (const l of lines(words, boxes(file, words.length))) {
        console.log(`${frameName}\t${name}\t${leading ?? "auto"}\t${l.y}\t${l.words.join(" ")}`);
      }
    }
  }
}
