// `pnpm roundtrip`: each fixture Document goes Zibel → SVG → Inkscape → Zibel through a local
// `wrangler dev` and must come back equal (ADR-0017, REQUIREMENTS §7.2); a painted Group transformed
// in Inkscape must come back as zibel_node_transform leaves it (ADR-0043). Needs `inkscape` ≥ 1.2.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { httpCall } from "./agent-benchmarks/mcp.ts";
import { startServer } from "./wrangler.ts";

const PORT = 8791;
const STATE = ".wrangler/roundtrip";
const FIXTURES = join(import.meta.dirname, "documents");
const WHITE = "#FFFFFF";
/** Fails a hung Inkscape (a display or font-cache probe) instead of the CI job's 6 h limit. */
const TIMEOUT_MS = 120_000;
/** A pixel differs when a channel is off by more than this; a fixture fails at 1% of pixels. */
const TOLERANCE = 32;
const MAX_DIFFERENT = 0.01;
/** The inkscape fixture's painted Group (ADR-0043), which the edit passes transform in Inkscape. */
const PAINTED = "01M38T29SXC0NTA1NERSGR0VP0";
/** Inkscape edits whose matrix, written on the Group's <g>, must import as node_transform (#108). */
const EDITS = {
  "rotate+scale": "transform-rotate:30;transform-scale:2",
  flip: "object-flip-horizontal",
};

// Inkscape must draw text in the bundled font, as resvg does (ADR-0013), not a system fallback.
const FONTS_CONF = resolve(STATE, "fonts.conf");
mkdirSync(STATE, { recursive: true });
writeFileSync(
  FONTS_CONF,
  `<?xml version="1.0"?>
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>${resolve(import.meta.dirname, "../packages/render/fonts")}</dir>
  <cachedir>${resolve(STATE, "fontconfig")}</cachedir>
</fontconfig>
`,
);

interface Doc {
  name: string;
  artboards: Record<string, unknown>[];
  nodes: Record<string, unknown>[];
  /** Each image file by id, as a data URL (ADR-0023). */
  images?: Record<string, string>;
}

function inkscape(...args: string[]) {
  const run = spawnSync("inkscape", args, {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    env: { ...process.env, FONTCONFIG_FILE: FONTS_CONF },
  });
  if (run.error) throw run.error;
  // Inkscape writes Gtk warnings to stderr on every call, so only the exit code tells.
  if (run.status !== 0) throw new Error(`inkscape ${args.join(" ")}: ${run.stderr}`);
  return run.stdout;
}

/** The first way `got` differs from `want`, naming the field; undefined when equal. */
function firstDifference(want: Doc, got: Doc): string | undefined {
  const show = JSON.stringify;
  const fields = (path: string, a: Record<string, unknown>, b: Record<string, unknown>) => {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
      if (key !== "index" && show(a[key]) !== show(b[key]))
        return `${path}.${key}: ${show(b[key])}, want ${show(a[key])}`;
  };
  if (want.name !== got.name) return `name: ${show(got.name)}, want ${show(want.name)}`;
  if (want.artboards.length !== got.artboards.length)
    return `artboards: ${got.artboards.length}, want ${want.artboards.length}`;
  for (const [i, a] of want.artboards.entries()) {
    const diff = fields(`artboards[${i}]`, a, got.artboards[i] ?? {});
    if (diff) return diff;
  }
  const byId = new Map(got.nodes.map((n) => [n.id, n]));
  for (const a of want.nodes) {
    const b = byId.get(a.id);
    if (!b) return `nodes[${a.id}]: missing`;
    const diff = fields(`nodes[${a.id}]`, a, b);
    if (diff) return diff;
  }
  const extra = got.nodes.find((n) => !want.nodes.some((a) => a.id === n.id));
  if (extra) return `nodes[${extra.id}]: not in the original`;
  // Ids are the files' hashes, so equal ids mean Inkscape kept every byte.
  const files = (doc: Doc) => show(Object.keys(doc.images ?? {}));
  if (files(want) !== files(got)) return `images: ${files(got)}, want ${files(want)}`;
  // Fractional indexes may be renumbered; only the order of each parent's children must hold.
  const order = (doc: Doc, parentId: unknown) =>
    doc.nodes
      .filter((n) => n.parentId === parentId)
      .sort((a, b) => ((a.index as string) < (b.index as string) ? -1 : 1))
      .map((n) => n.id);
  for (const parentId of new Set(want.nodes.map((n) => n.parentId))) {
    const [a, b] = [order(want, parentId), order(got, parentId)];
    if (show(a) !== show(b)) return `children of ${parentId}: ${show(b)}, want ${show(a)}`;
  }
}

/** Every number at the Document's 3 decimals (REQUIREMENTS §6.5), as export writes widths. */
const rounded = (doc: Doc): Doc =>
  JSON.parse(JSON.stringify(doc), (_, v) =>
    typeof v === "number" ? Math.round(v * 1000) / 1000 || 0 : v,
  );

/** The matrix Inkscape wrote on the `<g>` of the Node `id`, as zibel_node_transform takes it. */
function matrixOn(svg: string, id: string): number[] {
  const g = new RegExp(`<g\\s[^>]*\\bid="z-${id}"[^>]*>`).exec(svg)?.[0] ?? "";
  const m = /\btransform="matrix\(([^)]*)\)"/
    .exec(g)?.[1]
    ?.split(/[\s,]+/)
    .map(Number);
  if (m?.length !== 6 || !m.every(Number.isFinite)) throw new Error(`no matrix on z-${id}: ${g}`);
  return m;
}

interface Image {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Decodes an RGBA8 non-interlaced PNG, what resvg writes and Inkscape does with RGBA_8. */
function decodePng(png: Buffer): Image {
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  for (let pos = 8; pos < png.length; pos += 12 + png.readUInt32BE(pos)) {
    const type = png.toString("latin1", pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + png.readUInt32BE(pos));
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0)
        throw new Error(
          `PNG is not RGBA8: depth ${data[8]}, colour ${data[9]}, interlace ${data[12]}`,
        );
    } else if (type === "IDAT") idat.push(data);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1);
    const row = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? (out[row + i - 4] ?? 0) : 0;
      const b = y ? (out[row - stride + i] ?? 0) : 0;
      const c = i >= 4 && y ? (out[row - stride + i - 4] ?? 0) : 0;
      const p = a + b - c;
      const paeth =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter ?? 0] ?? 0;
      out[row + i] = ((src[i] ?? 0) + predictor) & 255;
    }
  }
  return { width, height, data: out };
}

/** The share of pixels where any channel differs by more than TOLERANCE. */
function differentPixels(a: Image, b: Image): number {
  if (a.width !== b.width || a.height !== b.height)
    throw new Error(`resvg ${a.width}x${a.height} px, Inkscape ${b.width}x${b.height} px`);
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4)
    for (let k = 0; k < 4; k++)
      if (Math.abs((a.data[i + k] ?? 0) - (b.data[i + k] ?? 0)) > TOLERANCE) {
        n++;
        break;
      }
  return n / (a.width * a.height);
}

async function main() {
  const version = spawnSync("inkscape", ["--version"], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
  });
  if ((version.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    console.log("roundtrip: skipped, inkscape is not on PATH");
    return 0;
  }
  const [, major = 0, minor = 0] =
    /Inkscape (\d+)\.(\d+)/.exec(version.stdout ?? "")?.map(Number) ?? [];
  if (major < 1 || (major === 1 && minor < 2)) {
    console.log(
      `roundtrip: needs Inkscape ≥ 1.2, found ${version.stdout?.trim() || version.error}`,
    );
    return 1;
  }

  const server = await startServer(PORT, STATE);
  let failed = 0;
  try {
    const call = httpCall(`http://127.0.0.1:${PORT}/mcp`, "dev-token-a");
    const open = async (content: string) =>
      (await call("zibel_doc_open", { content })).structuredContent as {
        docId: string;
        name: string;
        warnings: { code: string }[];
      };
    const text = async (args: object) => (await call("zibel_export", args)).content[0]?.text ?? "";
    /** resvg's PNG of `docId`, the whole Document or `rect`, into `dir`; returns the rect drawn. */
    const resvg = async (dir: string, docId: string, rect?: object) => {
      const png = await call("zibel_export", {
        docId,
        format: "png",
        background: WHITE,
        ...(rect && { scope: { rect } }),
      });
      writeFileSync(join(dir, "resvg.png"), Buffer.from(png.content[0]?.data ?? "", "base64"));
      return png.structuredContent.viewport.docRect as object;
    };
    /** Inkscape's PNG of `svg` at 1 px per pt, against resvg's in `dir`: the share that differs. */
    const inkscapeDiff = (dir: string, svg: string) => {
      inkscape(
        "--export-type=png",
        "-C",
        "-d",
        "72",
        `--export-background=${WHITE}`,
        "--export-background-opacity=1",
        "--export-png-color-mode=RGBA_8",
        `--export-filename=${join(dir, "inkscape.png")}`,
        svg,
      );
      return differentPixels(
        decodePng(readFileSync(join(dir, "resvg.png"))),
        decodePng(readFileSync(join(dir, "inkscape.png"))),
      );
    };
    for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith(".zibel.json"))) {
      const fixture = file.slice(0, -".zibel.json".length);
      const dir = join(STATE, fixture);
      mkdirSync(join(dir, "inkscape"), { recursive: true });
      let line: string;
      try {
        const original = await open(readFileSync(join(FIXTURES, file), "utf8"));
        const { docId } = original;
        // Inkscape names the Document after the file it reads, and Open reads the name back from it.
        const exported = await text({ docId, format: "svg" });
        writeFileSync(join(dir, `${original.name}.svg`), exported);
        // Saved over its input: Inkscape rewrites a relative link against the folder it saves to.
        const saved = join(dir, "inkscape", `${original.name}.svg`);
        writeFileSync(saved, exported);
        inkscape("--export-type=svg", `--export-filename=${saved}`, saved);
        const reopened = await open(readFileSync(saved, "utf8"));
        const [want, got] = await Promise.all(
          [original, reopened].map(
            async (d) => JSON.parse(await text({ docId: d.docId, format: "zibel_json" })) as Doc,
          ),
        );
        // A missing link warns on every Open; firstDifference still catches a lost src or file.
        const warnings = reopened.warnings.filter((w) => w.code !== "IMAGE_LINK_MISSING");
        const structure = warnings.length
          ? `warnings: ${JSON.stringify(warnings)}`
          : firstDifference(want, got);

        // resvg's PNG of the whole Document, and Inkscape's of an export framed to the same rect:
        // -C draws the viewBox at 1 px per pt, which --export-area (in px) does not.
        const docRect = await resvg(dir, docId);
        const pixelsSvg = join(dir, "pixels.svg");
        writeFileSync(pixelsSvg, await text({ docId, format: "svg", scope: { rect: docRect } }));
        const ratio = inkscapeDiff(dir, pixelsSvg);
        const pixels = `pixels ${(ratio * 100).toFixed(2)}%${ratio < MAX_DIFFERENT ? "" : " FAIL"}`;
        if (structure || ratio >= MAX_DIFFERENT) failed++;
        line = [`structure ${structure ? `FAIL ${structure}` : "pass"}`, pixels].join("  ");
      } catch (e) {
        failed++;
        line = `FAIL  ${(e as Error).message}`;
      }
      console.log(`${fixture.padEnd(12)}  ${line}`);
      if (
        !JSON.parse(readFileSync(join(FIXTURES, file), "utf8")).nodes.some(
          (n: Doc["nodes"][number]) => n.id === PAINTED,
        )
      )
        continue;
      for (const [edit, actions] of Object.entries(EDITS)) {
        try {
          const original = await open(readFileSync(join(FIXTURES, file), "utf8"));
          const { docId } = original;
          const editDir = join(dir, edit);
          mkdirSync(join(editDir, "pixels"), { recursive: true });
          // The same edit on the whole export, which Open reads, and on one framed to the whole
          // Document, which Inkscape draws: the whole export's viewBox is one Artboard.
          const docRect = await resvg(editDir, docId);
          const inInkscape = async (saved: string, scope?: object) => {
            writeFileSync(saved, await text({ docId, format: "svg", ...(scope && { scope }) }));
            inkscape(
              `--actions=select-by-id:z-${PAINTED};${actions};export-filename:${saved};export-do`,
              saved,
            );
            return readFileSync(saved, "utf8");
          };
          const edited = await inInkscape(join(editDir, `${original.name}.svg`));
          const framed = join(editDir, "pixels", `${original.name}.svg`);
          await inInkscape(framed, { rect: docRect });
          const reopened = await open(edited);
          await call("zibel_node_transform", {
            docId,
            nodeIds: [PAINTED],
            matrix: matrixOn(edited, PAINTED),
            pivot: { x: 0, y: 0 },
            scaleStrokes: true,
          });
          const [want, got] = await Promise.all(
            [original, reopened].map(async (d) =>
              rounded(JSON.parse(await text({ docId: d.docId, format: "zibel_json" })) as Doc),
            ),
          );
          const warnings = reopened.warnings.filter((w) => w.code !== "IMAGE_LINK_MISSING");
          const structure = warnings.length
            ? `warnings: ${JSON.stringify(warnings)}`
            : firstDifference(want, got);
          await resvg(editDir, reopened.docId, docRect);
          const ratio = inkscapeDiff(editDir, framed);
          const pixels = `pixels ${(ratio * 100).toFixed(2)}%${ratio < MAX_DIFFERENT ? "" : " FAIL"}`;
          if (structure || ratio >= MAX_DIFFERENT) failed++;
          line = [`structure ${structure ? `FAIL ${structure}` : "pass"}`, pixels].join("  ");
        } catch (e) {
          failed++;
          line = `FAIL  ${(e as Error).message}`;
        }
        console.log(`${`${fixture} ${edit}`.padEnd(12)}  ${line}`);
      }
    }
  } finally {
    server.stop();
  }
  return failed ? 1 : 0;
}

process.exit(await main());
