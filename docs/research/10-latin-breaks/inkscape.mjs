// Where Inkscape 1.2.2 wraps each of ADR-0085's ten Area Type frames (#222) and ADR-0087's ten (#224).
// Run from the repo root: `node docs/research/10-latin-breaks/inkscape.mjs`, which prints
// `inkscape.tsv`. Each frame is a `<rect>` 300 tall, 12 px Source Sans 3, `font-kerning:none`,
// `line-height:1.2`, and its `text-align` if any, as export writes an Area Type. Inkscape flows it
// and saves it to `out/`, and each line is the text and `x` of a line tspan.
// Fonts are the bundled ones, through fonts.conf as `pnpm roundtrip` sets them.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const HERE = import.meta.dirname;
const OUT = join(HERE, "out");
const FONTS = resolve(HERE, "../../../packages/render/fonts");
mkdirSync(OUT, { recursive: true });
const conf = join(OUT, "fonts.conf");
writeFileSync(
  conf,
  `<?xml version="1.0"?><fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include><dir>${FONTS}</dir><cachedir>${OUT}/fontconfig</cachedir></fontconfig>`,
);

/** Each frame's width, text and alignment: `text.test.ts` asserts Kalamo's lines equal these. */
const FRAMES = [
  [120, "See https://example.com/a/very/long/path/that/fits/no/line for details."],
  [60, "aaaa well-known state-of-the-art"],
  [60, "xxxxxxxx a–bbbbb"],
  [60, "xxxxx aa|bbbbbbbb"],
  [40, "xxx -abc -5 a-(b) a-$5"],
  [45, "xxxx a-́bcd"],
  [60, "xxxxx aa/12345678"],
  [60, "xxxxx 1a/12345678"],
  [60, "xxxxx 12/12345678"],
  [60, "xxxxx aa-12345678"],
  [60, "xxxxx aa\u00A0bbbbbbbb"],
  [60, "xxxxx 10\u00A0km/h"],
  [60, "xxxxx aa\u202Fbbbbbbbb"],
  [60, "xxxxx aa\u2007bbbbbbbb"],
  [60, "xxxxx aaaaaaaaa\u00A0bbbb", "end"],
  [60, "xxxxx aaaaaaaaa\u202Fbbbb", "end"],
  [60, "xxxxx aaaaaaaaa\u2007bbbb", "end"],
  [60, "xxxxx aaaaaaaaa\uFEFFbbbb", "end"],
  [60, "xxxxx aaaaaaaaa bbbb", "end"],
  [60, "xxxxx aaaaaaaaaabbbb", "end"],
];

const xml = (t) => t.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
const decode = (t) =>
  t.replace(/&(?:#(\d+)|(\w+));/g, (_, n, e) =>
    n ? String.fromCodePoint(Number(n)) : { amp: "&", lt: "<", gt: ">", quot: '"' }[e],
  );

console.log("width\ttext\talign\tlines\tx");
for (const [i, [width, text, align]] of FRAMES.entries()) {
  const [svg, saved] = [join(OUT, `${i}.svg`), join(OUT, `${i}.saved.svg`)];
  writeFileSync(
    svg,
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><defs><rect id="f" x="0" y="0" width="${width}" height="300"/></defs><text font-family="Source Sans 3" font-size="12" style="shape-inside:url(#f);white-space:pre;font-kerning:none;line-height:1.2${align ? `;text-align:${align}` : ""}" xml:space="preserve">${xml(text)}</text></svg>`,
  );
  const run = spawnSync("inkscape", ["--export-type=svg", `--export-filename=${saved}`, svg], {
    encoding: "utf8",
    env: { ...process.env, FONTCONFIG_FILE: conf },
  });
  if (run.status !== 0) throw new Error(`inkscape: ${run.stderr}`);
  // Inkscape saves one tspan per line, each holding its line's text.
  const body = /<text\b[^>]*>([\s\S]*?)<\/text>/.exec(readFileSync(saved, "utf8"))?.[1] ?? "";
  const tspans = [...body.matchAll(/<tspan\b([^>]*)>([\s\S]*?)<\/tspan>/g)];
  const lines = tspans.map(([, , t]) => decode(t.replace(/<[^>]*>/g, "")));
  const xs = tspans.map(([, attrs]) => Number(/\bx="([^"]*)"/.exec(attrs)?.[1]));
  console.log(
    `${width}\t${JSON.stringify(text)}\t${align ?? ""}\t${JSON.stringify(lines)}\t${JSON.stringify(xs)}`,
  );
}
