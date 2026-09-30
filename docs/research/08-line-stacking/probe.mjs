// Measures where Inkscape 1.2.2 draws each line of Latin text holding CJK (#199). Run from the repo
// root: `node docs/research/08-line-stacking/probe.mjs`. Each case is an SVG in `out/` next to this
// file. Every line starts with an "H" in a tspan of its own, whose bottom, from `--query-all`, is the
// line's baseline. Fonts are the bundled ones, through fonts.conf as `pnpm roundtrip` sets them.
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
const TOP = 40;
const X = 20;
/** Source Sans 3's and Noto Sans SC's em-box ascents, as core's FAMILIES has them. */
const [SOURCE, NOTO] = [1000 / 1326, 0.88];

/**
 * A text's lines, each a list of runs: a string in the text's style, or `{ cjk, size }` for CJK that
 * falls back to Noto Sans SC, optionally at a larger size.
 */
const TEXTS = {
  "cjk-second": [["line one"], [{ cjk: "字字" }, " two"], ["three"], ["four"]],
  "cjk-first": [[{ cjk: "字字" }, " one"], ["two"], ["three"], ["four"]],
  "cjk-larger": [["line one"], [{ cjk: "字字", size: 30 }, " two"], ["three"], ["four"]],
  latin: [["line one"], ["two"], ["three"], ["four"]],
};

/**
 * The SVG forms tried. `lh` is the text's `line-height`; `run` the extra style of a CJK run's tspan,
 * given the text's leading (undefined for Auto) and the run's size; `family` the text's
 * `font-family`.
 */
const FORMS = {
  // What Kalamo writes before #199.
  current: { lh: (l) => (l ? `${l}px` : "1.2"), run: () => "" },
  // An absolute line-height on the text.
  absolute: { lh: (l) => `${l ?? 1.2 * SIZE}px`, run: () => "" },
  // Noto Sans SC first, so it sets the strut. Its Latin then draws in Noto Sans SC.
  "noto-first": {
    lh: (l) => (l ? `${l}px` : "1.2"),
    run: () => "",
    family: "'Noto Sans SC', 'Source Sans 3'",
  },
  // Each fallback run's line-height shrunk by what its em box's ascent exceeds the strut's, twice,
  // so its inline box lies inside a Source Sans 3 box of its size and leading. Rounded down: a box
  // a thousandth above the strut needs its whole leading in the frame.
  "run-line-height": {
    lh: (l) => (l ? `${l}px` : "1.2"),
    run: (l, size) => {
      const floor = (v) => Math.floor(v * 1000) / 1000;
      return `line-height:${l ? `${floor(l - 2 * (NOTO - SOURCE) * size)}px` : floor(1.2 - 2 * (NOTO - SOURCE))}`;
    },
  },
  // The same run rounded to the nearest thousandth, which lands a hair above the strut at 30 px.
  "run-line-height-rounded": {
    lh: (l) => (l ? `${l}px` : "1.2"),
    run: (l, size) =>
      `line-height:${l ? `${+(l - 2 * (NOTO - SOURCE) * size).toFixed(3)}px` : +(1.2 - 2 * (NOTO - SOURCE)).toFixed(3)}`,
  },
};

const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
function svg(kind, form, lines, leading, height) {
  const f = FORMS[form];
  const tspans = lines.map((runs, i) => {
    const body = runs
      .map((r) =>
        typeof r === "string"
          ? esc(r)
          : `<tspan style="${[r.size && `font-size:${r.size}px`, f.run(leading, r.size ?? SIZE)].filter(Boolean).join(";")}">${esc(r.cjk)}</tspan>`,
      )
      .join("");
    const nl = kind === "area" && i < lines.length - 1 ? "&#10;" : "";
    const role = kind === "point" ? ` sodipodi:role="line" x="${X}" y="${TOP + i * 24}"` : "";
    return `<tspan${role}><tspan id="h${i}">H</tspan>${body}${nl}</tspan>`;
  });
  const shape = kind === "area" ? `shape-inside:url(#frame);white-space:pre;` : "";
  const at = kind === "point" ? ` x="${X}" y="${TOP}"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" width="400" height="400" viewBox="0 0 400 400">
<rect id="frame" x="${X}" y="${TOP}" width="300" height="${height}" fill="none"/>
<text id="t"${at} font-family="${f.family ?? "Source Sans 3"}" font-size="${SIZE}" style="${shape}font-kerning:none;line-height:${f.lh(leading)}" xml:space="preserve">${tspans.join("")}</text>
</svg>`;
}

/** Each probe's baseline, or null when Inkscape draws no line there. */
function baselines(file, n) {
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
    const r = rows.get(`h${i}`);
    return r && r[3] > 0 ? +(r[1] + r[3]).toFixed(2) : null;
  });
}

const only = process.argv[2];
for (const kind of ["point", "area"]) {
  for (const leading of [undefined, 30]) {
    for (const [name, lines] of Object.entries(TEXTS)) {
      for (const form of Object.keys(FORMS)) {
        if (only && !`${kind} ${name} ${form}`.includes(only)) continue;
        const file = join(OUT, `${kind}-${name}-${leading ?? "auto"}-${form}.svg`);
        writeFileSync(file, svg(kind, form, lines, leading, 300));
        const b = baselines(file, lines.length);
        const steps = b
          .slice(1)
          .map((y, i) => (y === null || b[i] === null ? null : +(y - b[i]).toFixed(2)));
        console.log(
          `${kind}\t${leading ?? "auto"}\t${name}\t${form}\tfirst ${b[0] === null ? "-" : +(b[0] - TOP).toFixed(2)}\tsteps ${steps.join(" ")}`,
        );
      }
    }
  }
}

/** The least frame height, to 0.01, at which Inkscape shows line `k` of an Area Type. */
function threshold(form, lines, leading, k) {
  let [lo, hi] = [0, 300];
  while (hi - lo > 0.01) {
    const mid = (lo + hi) / 2;
    const file = join(OUT, "threshold.svg");
    writeFileSync(file, svg("area", form, lines, leading, mid));
    if (baselines(file, lines.length)[k] === null) lo = mid;
    else hi = mid;
  }
  return +hi.toFixed(2);
}
if (!only || only === "thresholds") {
  for (const leading of [undefined, 30]) {
    for (const name of ["cjk-first", "cjk-second", "latin"]) {
      for (const form of ["current", "run-line-height", "run-line-height-rounded"]) {
        const t = [0, 1, 2].map((k) => threshold(form, TEXTS[name], leading, k));
        console.log(
          `threshold\t${leading ?? "auto"}\t${name}\t${form}\tshows lines 1-3 from ${t.join(" ")}`,
        );
      }
    }
  }
}
