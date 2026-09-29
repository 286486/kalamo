// `pnpm roundtrip`: each fixture Document goes Zibel → SVG → Inkscape → Zibel through a local
// `wrangler dev` and must come back equal (ADR-0017, REQUIREMENTS §7.2); a painted Group transformed
// in Inkscape must come back as zibel_node_transform leaves it (ADR-0043). Needs `inkscape` ≥ 1.2.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { httpCall } from "./agent-benchmarks/mcp.ts";
import { decodePng, type Image } from "./png.ts";
import { startServer } from "./wrangler.ts";

const PORT = 8791;
const STATE = ".wrangler/roundtrip";
const FIXTURES = join(import.meta.dirname, "documents");
const WHITE = "#FFFFFF";
/** Fails a hung Inkscape (a display or font-cache probe) instead of the CI job's 6 h limit. */
const TIMEOUT_MS = 120_000;
/** A pixel differs when a channel is off by more than this. */
const TOLERANCE = 32;
/** The share of a region's pixels that may differ (ADR-0017): twice the worst measured baseline
 * for vector art, and for a text or Image under what one hidden word differs by. */
const BUDGET = { vector: 0.007, text: 0.15 };
/** Text and Image bounds grow by this, in pt, to cover antialiasing, besides their Strokes. */
const MARGIN = 2;
/** The inkscape fixture's painted Group (ADR-0043), which the edit passes transform in Inkscape. */
const PAINTED = "01M38T29SXC0NTA1NERSGR0VP0";
/** Nodes that resvg draws hidden against Inkscape's no-edit PNG: each must fail its own region. */
const PROBES = { star: "01M38T29SRR0VNDNVMBERSTAR0", Bold: "01M38T29SVTYPE0000000000B0" };
/** Inkscape edits whose matrix, written on the Group's <g>, must import as node_transform (#108). */
const EDITS = {
  "rotate+scale": "transform-rotate:30;transform-scale:2",
  flip: "object-flip-horizontal",
};

// Inkscape must draw text in the bundled font, as resvg does (ADR-0013), not a system fallback:
// CJK falls back to the bundled Noto Sans SC even where the system has its own CJK fonts, as CI's
// Inkscape install pulls in (#167).
const FONTS_CONF = resolve(STATE, "fonts.conf");
const cjk = ["zh-cn", "zh-tw", "ja", "ko"].map(
  (lang) =>
    `<rejectfont><pattern><patelt name="lang"><string>${lang}</string></patelt></pattern></rejectfont>`,
);
mkdirSync(STATE, { recursive: true });
writeFileSync(
  FONTS_CONF,
  `<?xml version="1.0"?>
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>${resolve(import.meta.dirname, "../packages/render/fonts")}</dir>
  <selectfont>
    <acceptfont><pattern><patelt name="family"><string>Noto Sans SC</string></patelt></pattern></acceptfont>
    ${cjk.join("\n    ")}
  </selectfont>
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

/**
 * Each Area Type's shown lines in `svg` by Node id: the text of each line tspan whose baseline lies
 * in the frame. Inkscape writes its overflow one ascent below the frame, and Zibel's has no `y`.
 */
function areaLines(svg: string): Map<string, string[]> {
  const attr = (tag: string, name: string) =>
    Number(new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]);
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"' };
  const decode = (t: string) =>
    t.replace(/&(?:#(\d+)|(\w+));/g, (_, n, e) =>
      n ? String.fromCodePoint(Number(n)) : entities[e],
    );
  const out = new Map<string, string[]>();
  const texts =
    /<text\b[^>]*\sid="z-([^"]+)"[^>]*shape-inside:url\(#area-z-[^>]*>([\s\S]*?)<\/text>/g;
  for (const [, id, body] of svg.matchAll(texts)) {
    const rect = new RegExp(`<rect\\b[^>]*\\sid="area-z-${id}"[^>]*>`).exec(svg)?.[0] ?? "";
    const bottom = attr(rect, "y") + attr(rect, "height");
    const lines: string[] = [];
    let [depth, line, shown] = [0, "", false];
    for (const [token, end, attrs, empty] of (body ?? "").matchAll(
      /<(\/?)tspan\b([^>]*?)(\/?)>|[^<]+/g,
    )) {
      if (!token.startsWith("<")) {
        line += decode(token);
        continue;
      }
      if (depth === 0 && !end) [line, shown] = ["", attr(attrs ?? "", "y") <= bottom];
      depth += end ? -1 : empty ? 0 : 1;
      if (depth === 0 && shown) lines.push(line);
    }
    out.set(id as string, lines);
  }
  return out;
}

/** The first Area Type whose shown lines Inkscape breaks differently from `exported` (ADR-0064). */
function lineDifference(exported: string, saved: string): string | undefined {
  const got = areaLines(saved);
  for (const [id, want] of areaLines(exported)) {
    const show = JSON.stringify;
    if (show(got.get(id)) !== show(want))
      return `lines of ${id}: ${show(got.get(id))}, want ${show(want)}`;
  }
}

/** An RGBA8 PNG of `image`, unfiltered. */
function encodePng({ width, height, data }: Image): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "latin1");
    body.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++)
    raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

type Rect = { x: number; y: number; width: number; height: number };
const contains = (r: Rect, x: number, y: number) =>
  r.x <= x && x < r.x + r.width && r.y <= y && y < r.y + r.height;

interface Region {
  name: string;
  kind: keyof typeof BUDGET;
  /** What a text region holds: a text's first 16 characters, or an Image's name. */
  subject?: string;
  /** Pixels in the region, and those of them that differ. */
  area: number;
  differ: number;
}

/** A pixel in no region: counted by no budget. */
const UNCHECKED = 0xffff;

/** Each pixel's index into `regions`: each Artboard's and then outside Artboards' vector region,
 * then a text region for each text or Image on each of them. */
interface RegionMap {
  regions: Region[];
  of: Uint16Array;
  docRect: Rect;
}

const share = (r: Region) => r.differ / r.area;
const percent = (n: number) => `${Number((n * 100).toFixed(2))}%`;
const label = (r: Region) => [r.name, r.kind, r.subject].filter(Boolean).join(" ");
const against = (r: Region) => `${percent(share(r))} of ${percent(BUDGET[r.kind])}`;
const describe = (r: Region) => `${label(r)} ${r.differ} px of ${r.area} (${against(r)})`;

/** Counts the pixels where any channel differs by more than TOLERANCE into each region of `map`,
 * and draws them in magenta over a faded copy of resvg's PNG, as `diff`. */
async function compare(
  map: RegionMap,
  resvgPng: string,
  inkscapePng: string,
  diff: string,
): Promise<Region[]> {
  const [a, b] = (await Promise.all(
    [resvgPng, inkscapePng].map((f) => decodePng(readFileSync(f))),
  )) as [Image, Image];
  if (a.width !== b.width || a.height !== b.height)
    throw new Error(`resvg ${a.width}x${a.height} px, Inkscape ${b.width}x${b.height} px`);
  if (a.width !== map.docRect.width || a.height !== map.docRect.height)
    throw new Error(`PNG ${a.width}x${a.height} px, want the docRect at 1 px per pt`);
  const regions = map.regions.map((r) => ({ ...r, differ: 0 }));
  const out = new Uint8Array(a.data.length);
  for (let i = 0; i < a.data.length; i += 4) {
    let differs = false;
    for (let k = 0; k < 4; k++)
      differs ||= Math.abs((a.data[i + k] ?? 0) - (b.data[i + k] ?? 0)) > TOLERANCE;
    const region = regions[map.of[i / 4] ?? 0];
    if (differs && region) region.differ++;
    for (let k = 0; k < 3; k++)
      out[i + k] = differs ? ([255, 0, 255][k] ?? 0) : 191 + ((a.data[i + k] ?? 0) >> 2);
    out[i + 3] = 255;
  }
  writeFileSync(diff, encodePng({ width: a.width, height: a.height, data: out }));
  return regions;
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
    /** The regions of the Document `docId` in its PNG of `docRect`, at 1 px per pt: each pixel
     * goes to the first Artboard holding it, and there to text when it is in the bounds of a
     * drawn text or Image grown by MARGIN and half the widest Stroke on it or a container above. */
    const regionMap = async (docId: string, docRect: Rect): Promise<RegionMap> => {
      const doc = JSON.parse(await text({ docId, format: "zibel_json" })) as Doc;
      const views = (
        await call("zibel_node_get", {
          docId,
          nodeIds: doc.nodes.map((n) => n.id),
          detail: "full",
        })
      ).structuredContent.nodes as {
        id: string;
        type: string;
        parentId: string | null;
        visible: boolean;
        visibleBounds?: Rect | null;
        worldTransform?: number[];
        name: string;
        content?: string;
        src?: string;
        appearance?: { strokes?: { width: number }[] };
      }[];
      const byId = new Map(views.map((v) => [v.id, v]));
      const rects: { rect: Rect; subject: string; unchecked: boolean }[] = [];
      for (const v of views) {
        if ((v.type !== "text" && v.type !== "image") || !v.visibleBounds) continue;
        const chain = [];
        for (let n: typeof v | undefined = v; n; n = byId.get(n.parentId ?? "")) chain.push(n);
        if (!chain.every((n) => n.visible)) continue;
        // visibleBounds already holds the Node's own Stroke; a container's outlines it as well.
        const stroke = Math.max(
          0,
          ...chain.slice(1).flatMap((n) => {
            const [a = 1, b = 0, c = 0, d = 1] = n.worldTransform ?? [];
            return (n.appearance?.strokes ?? []).map(
              (s) => s.width * Math.sqrt(Math.abs(a * d - b * c)),
            );
          }),
        );
        const grow = MARGIN + stroke / 2;
        const { x, y, width, height } = v.visibleBounds;
        rects.push({
          rect: { x: x - grow, y: y - grow, width: width + 2 * grow, height: height + 2 * grow },
          subject: JSON.stringify(
            (v.content ?? (v.name || v.id)).replace(/\s+/g, " ").slice(0, 16),
          ),
          // Inkscape draws its own icon for a missing link (ADR-0042): no budget covers it.
          unchecked: v.type === "image" && !v.src,
        });
      }
      const names = [...doc.artboards.map((a) => String(a.name)), "outside Artboards"];
      const frames = doc.artboards.map((a) => a.frame as Rect);
      // Each Artboard's vector region, then each text or Image on each Artboard as it is met.
      const regions: Region[] = names.map((name) => ({ name, kind: "vector", area: 0, differ: 0 }));
      const index = new Map<string, number>();
      const of = new Uint16Array(docRect.width * docRect.height);
      for (let py = 0; py < docRect.height; py++)
        for (let px = 0; px < docRect.width; px++) {
          const [x, y] = [docRect.x + px + 0.5, docRect.y + py + 0.5];
          const found = frames.findIndex((f) => contains(f, x, y));
          const artboard = found < 0 ? frames.length : found;
          const t = rects.findIndex((r) => contains(r.rect, x, y));
          const rect = rects[t];
          let i = artboard;
          if (rect?.unchecked) i = UNCHECKED;
          else if (rect) {
            const key = `${artboard} ${t}`;
            i = index.get(key) ?? regions.length;
            if (i === regions.length) {
              index.set(key, i);
              const name = names[artboard] as string;
              regions.push({ name, kind: "text", subject: rect.subject, area: 0, differ: 0 });
            }
          }
          of[py * docRect.width + px] = i;
          if (regions[i]) regions[i].area++;
        }
      return { regions, of, docRect };
    };
    /** The regions over budget, and the region closest to its budget. */
    const judge = (regions: Region[]) => {
      const counted = regions.filter((r) => r.area);
      const over = counted.filter((r) => share(r) > BUDGET[r.kind]);
      const load = (r: Region) => share(r) / BUDGET[r.kind];
      const worst = counted.reduce((w, r) => (load(r) > load(w) ? r : w));
      return { over, worst };
    };
    /** One fixture line, counting it as failed when either check fails. */
    const report = (structure: string | undefined, regions: Region[]) => {
      const { over, worst } = judge(regions);
      if (structure || over.length) failed++;
      const pixels = over.length
        ? `pixels FAIL ${over.map(describe).join(", ")}`
        : `pixels pass (worst ${label(worst)} ${against(worst)})`;
      return [`structure ${structure ? `FAIL ${structure}` : "pass"}`, pixels].join("  ");
    };
    /** resvg's PNG of `docId`, the whole Document or `rect`, into `dir`; returns the rect drawn. */
    const resvg = async (dir: string, docId: string, rect?: Rect) => {
      const png = await call("zibel_export", {
        docId,
        format: "png",
        background: WHITE,
        ...(rect && { scope: { rect } }),
      });
      writeFileSync(join(dir, "resvg.png"), Buffer.from(png.content[0]?.data ?? "", "base64"));
      return png.structuredContent.viewport.docRect as Rect;
    };
    /** Inkscape's PNG of `svg` at 1 px per pt, against resvg's in `dir`, by region of `map`. */
    const inkscapeDiff = (dir: string, svg: string, map: RegionMap) => {
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
      return compare(map, join(dir, "resvg.png"), join(dir, "inkscape.png"), join(dir, "diff.png"));
    };
    for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith(".zibel.json"))) {
      const fixture = file.slice(0, -".zibel.json".length);
      const json = readFileSync(join(FIXTURES, file), "utf8");
      const dir = join(STATE, fixture);
      mkdirSync(join(dir, "inkscape"), { recursive: true });
      let line: string;
      const probes: string[] = [];
      try {
        const original = await open(json);
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
          : (firstDifference(want, got) ?? lineDifference(exported, readFileSync(saved, "utf8")));

        // resvg's PNG of the whole Document, and Inkscape's of an export framed to the same rect:
        // -C draws the viewBox at 1 px per pt, which --export-area (in px) does not.
        const docRect = await resvg(dir, docId);
        const pixelsSvg = join(dir, "pixels.svg");
        writeFileSync(pixelsSvg, await text({ docId, format: "svg", scope: { rect: docRect } }));
        const map = await regionMap(docId, docRect);
        line = report(structure, await inkscapeDiff(dir, pixelsSvg, map));

        // Each probe hidden from resvg must fail on its own Artboard and region kind. The probes
        // are the edit target's fixture's: there a missing one fails, as a buried one does.
        const probing = want.nodes.some((n) => n.id === PAINTED);
        for (const [probe, nodeId] of Object.entries(probing ? PROBES : {})) {
          try {
            const [view] = (
              await call("zibel_node_get", { docId, nodeIds: [nodeId], detail: "full" })
            ).structuredContent.nodes as { visibleBounds: Rect | null }[];
            const b = view?.visibleBounds;
            if (!b) throw new Error("draws nothing");
            const px = Math.floor(b.x + b.width / 2 - docRect.x);
            const py = Math.floor(b.y + b.height / 2 - docRect.y);
            const at = px >= 0 && px < docRect.width && py >= 0 ? py * docRect.width + px : -1;
            const copy = await open(json);
            await call("zibel_node_update", {
              docId: copy.docId,
              updates: [{ nodeId, patch: { visible: false } }],
            });
            const probeDir = join(dir, "probes", probe);
            mkdirSync(probeDir, { recursive: true });
            await resvg(probeDir, copy.docId, docRect);
            const regions = await compare(
              map,
              join(probeDir, "resvg.png"),
              join(dir, "inkscape.png"),
              join(probeDir, "diff.png"),
            );
            const own = regions[map.of[at] ?? UNCHECKED];
            if (!own) throw new Error("its centre is in no region");
            const detected = judge(regions).over.includes(own);
            if (!detected) failed++;
            const under = `${label(own)} ${percent(share(own))} under ${percent(BUDGET[own.kind])}`;
            probes.push(
              `probe ${probe}: ${detected ? `detected (${describe(own)})` : `not detected, ${under}`}`,
            );
          } catch (e) {
            failed++;
            probes.push(`probe ${probe}: FAIL ${(e as Error).message}`);
          }
        }
      } catch (e) {
        failed++;
        line = `FAIL  ${(e as Error).message}`;
      }
      console.log(`${fixture.padEnd(12)}  ${line}`);
      for (const probe of probes) console.log(`${fixture.padEnd(12)}  ${probe}`);
      if (!JSON.parse(json).nodes.some((n: Doc["nodes"][number]) => n.id === PAINTED)) continue;
      for (const [edit, actions] of Object.entries(EDITS)) {
        try {
          const original = await open(json);
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
          const matrix = matrixOn(edited, PAINTED);
          // Inkscape draws the framed file, so it must carry the edit Open read.
          const drawn = matrixOn(await inInkscape(framed, { rect: docRect }), PAINTED);
          if (drawn.join() !== matrix.join())
            throw new Error(`framed edit ${drawn}, want ${matrix}`);
          const reopened = await open(edited);
          await call("zibel_node_transform", {
            docId,
            nodeIds: [PAINTED],
            matrix,
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
          const map = await regionMap(reopened.docId, docRect);
          line = report(structure, await inkscapeDiff(editDir, framed, map));
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
