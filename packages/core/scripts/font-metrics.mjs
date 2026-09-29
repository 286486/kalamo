// Writes src/source-sans-3.ts and src/noto-sans-sc.ts from the bundled fonts:
// `node packages/core/scripts/font-metrics.mjs`. Rerun it whenever a font in packages/render/fonts changes.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/** Each bundled face by its style name (ADR-0028), and its file's suffix. */
const FILES = {
  Regular: "Regular",
  Italic: "It",
  Bold: "Bold",
  "Bold Italic": "BoldIt",
  Black: "Black",
  "Black Italic": "BlackIt",
};
/** Noto Sans SC's two faces (ADR-0063). */
const NOTO_FILES = { Regular: "Regular", Bold: "Bold" };

function read(file) {
  const b = readFileSync(new URL(`../../render/fonts/${file}`, import.meta.url));
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tables = {};
  for (let i = 0; i < v.getUint16(4); i++) {
    const o = 12 + i * 16;
    tables[b.toString("latin1", o, o + 4)] = v.getUint32(o + 8);
  }
  const { head, hhea, hmtx, cmap, "OS/2": os2, glyf, loca, "CFF ": cff } = tables;
  const numberOfHMetrics = v.getUint16(hhea + 34);
  // Glyphs past numberOfHMetrics repeat the last advance.
  const advance = (glyph) => v.getUint16(hmtx + Math.min(glyph, numberOfHMetrics - 1) * 4);

  // The (3, 10) subtable, format 12: groups of consecutive code points mapped to consecutive glyphs.
  let sub;
  for (let i = 0; i < v.getUint16(cmap + 2); i++) {
    const o = cmap + 4 + i * 8;
    if (v.getUint16(o) === 3 && v.getUint16(o + 2) === 10) sub = cmap + v.getUint32(o + 4);
  }
  if (sub === undefined || v.getUint16(sub) !== 12)
    throw new Error(`${file}: no (3, 10) format 12 cmap.`);
  const advances = {};
  for (let i = 0; i < v.getUint32(sub + 12); i++) {
    const o = sub + 16 + i * 12;
    const [start, end, glyph] = [v.getUint32(o), v.getUint32(o + 4), v.getUint32(o + 8)];
    for (let c = start; c <= end; c++) advances[c] = advance(glyph + c - start);
  }
  // OS/2's typographic ascender and descender, which Inkscape sizes a line by (ADR-0064).
  const vertical = {
    unitsPerEm: v.getUint16(head + 18),
    ascender: v.getInt16(os2 + 68),
    descender: v.getInt16(os2 + 70),
  };
  const notdefPath = glyf === undefined ? cffNotdef(v, cff) : glyfNotdef(v, head, loca, glyf);
  return { vertical, face: { notdef: advance(0), notdefPath, advances } };
}

/** A number as SVG path data writes it. */
const num = (n) => String(Math.round(n * 100) / 100);

/**
 * Glyph 0's outline from a TrueType `glyf` table, as SVG path data in font units, y up: each
 * contour's on-curve points joined by lines, and by quadratics through its off-curve points.
 */
function glyfNotdef(v, head, loca, glyf) {
  const start = v.getInt16(head + 50) ? v.getUint32(loca) : v.getUint16(loca) * 2;
  let o = glyf + start;
  const contours = v.getInt16(o);
  if (contours < 0) throw new Error("A composite .notdef is not supported.");
  o += 10;
  const ends = Array.from({ length: contours }, (_, i) => v.getUint16(o + 2 * i));
  o += 2 * contours;
  o += 2 + v.getUint16(o);
  const count = (ends.at(-1) ?? -1) + 1;
  const flags = [];
  while (flags.length < count) {
    const f = v.getUint8(o++);
    flags.push(f);
    if (f & 8) for (let r = v.getUint8(o++); r > 0; r--) flags.push(f);
  }
  // Each coordinate is a byte with its sign in `same`, else a repeat when `same` is set, else an int16.
  const coords = (short, same) => {
    let c = 0;
    return flags.map((f) => {
      if (f & short) c += (f & same ? 1 : -1) * v.getUint8(o++);
      else if (!(f & same)) {
        c += v.getInt16(o);
        o += 2;
      }
      return c;
    });
  };
  const xs = coords(2, 16);
  const ys = coords(4, 32);
  let d = "";
  let first = 0;
  for (const end of ends) {
    const pts = [];
    for (let i = first; i <= end; i++) pts.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) === 1 });
    first = end + 1;
    // Start on an on-curve point; two off-curve points in a row imply one between them.
    const k = pts.findIndex((p) => p.on);
    if (k < 0) throw new Error("A .notdef contour with no on-curve point is not supported.");
    const ring = [...pts.slice(k), ...pts.slice(0, k), pts[k]];
    d += `M${num(ring[0].x)} ${num(ring[0].y)}`;
    for (let i = 1; i < ring.length; i++) {
      const p = ring[i];
      if (p.on) {
        if (!ring[i - 1].on) continue;
        d += `L${num(p.x)} ${num(p.y)}`;
        continue;
      }
      const next = ring[i + 1];
      const to = next.on ? next : { x: (p.x + next.x) / 2, y: (p.y + next.y) / 2 };
      d += `Q${num(p.x)} ${num(p.y)} ${num(to.x)} ${num(to.y)}`;
    }
    d += "Z";
  }
  return d;
}

/**
 * Glyph 0's outline from a `CFF ` table, as SVG path data in font units, y up: its Type 2
 * charstring run with the global and its Font DICT's local subroutines. Hints are skipped.
 */
function cffNotdef(v, cff) {
  const offset = (o, size) => {
    let r = 0;
    for (let i = 0; i < size; i++) r = r * 256 + v.getUint8(o + i);
    return r;
  };
  const index = (o) => {
    const n = v.getUint16(o);
    if (n === 0) return { items: [], end: o + 2 };
    const size = v.getUint8(o + 2);
    const base = o + 2 + (n + 1) * size;
    const at = (i) => base + offset(o + 3 + i * size, size);
    return { items: Array.from({ length: n }, (_, i) => [at(i), at(i + 1)]), end: at(n) };
  };
  const dict = ([start, end]) => {
    const d = {};
    let operands = [];
    for (let o = start; o < end; ) {
      const b = v.getUint8(o);
      if (b <= 21) {
        const op = b === 12 ? 1200 + v.getUint8(o + 1) : b;
        o += b === 12 ? 2 : 1;
        d[op] = operands;
        operands = [];
      } else if (b === 28) {
        operands.push(v.getInt16(o + 1));
        o += 3;
      } else if (b === 29) {
        operands.push(v.getInt32(o + 1));
        o += 5;
      } else if (b === 30) {
        // A real, which no offset this reads is.
        for (o++; (v.getUint8(o) & 15) !== 15 && v.getUint8(o) >> 4 !== 15; o++);
        o++;
        operands.push(0);
      } else if (b <= 246) {
        operands.push(b - 139);
        o++;
      } else if (b <= 250) {
        operands.push((b - 247) * 256 + v.getUint8(o + 1) + 108);
        o += 2;
      } else {
        operands.push(-(b - 251) * 256 - v.getUint8(o + 1) - 108);
        o += 2;
      }
    }
    return d;
  };
  const names = index(cff + v.getUint8(cff + 2));
  const top = index(names.end);
  const strings = index(top.end);
  const global = index(strings.end).items;
  const topDict = dict(top.items[0]);
  const at = (o) => [cff + o[0], cff + o[1]];
  const charstrings = index(cff + topDict[17][0]).items;
  // A CID-keyed font takes its Private DICT from the Font DICT FDSelect gives glyph 0.
  let priv = topDict[18];
  if (topDict[1236]) {
    const select = cff + topDict[1237][0];
    const format = v.getUint8(select);
    const fd = format === 0 ? v.getUint8(select + 1) : v.getUint8(select + 5);
    priv = dict(index(cff + topDict[1236][0]).items[fd])[18];
  }
  const [size, privOffset] = priv;
  const privDict = dict(at([privOffset, privOffset + size]));
  const local = privDict[19] ? index(cff + privOffset + privDict[19][0]).items : [];
  const bias = (subrs) => (subrs.length < 1240 ? 107 : subrs.length < 33900 ? 1131 : 32768);

  let d = "";
  let [x, y] = [0, 0];
  let stack = [];
  let stems = 0;
  let open = false;
  let widthRead = false;
  const moveTo = (dx, dy) => {
    if (open) d += "Z";
    [x, y] = [x + dx, y + dy];
    d += `M${num(x)} ${num(y)}`;
    open = true;
  };
  const lineTo = (dx, dy) => {
    [x, y] = [x + dx, y + dy];
    d += `L${num(x)} ${num(y)}`;
  };
  const curveTo = (a, b, c, e, f, g) => {
    const [x1, y1] = [x + a, y + b];
    const [x2, y2] = [x1 + c, y1 + e];
    [x, y] = [x2 + f, y2 + g];
    d += `C${num(x1)} ${num(y1)} ${num(x2)} ${num(y2)} ${num(x)} ${num(y)}`;
  };
  // The first stack-clearing operator may take the width first; this outline ignores it.
  const width = (even) => {
    if (!widthRead && stack.length % 2 === (even ? 1 : 0)) stack.shift();
    widthRead = true;
  };
  const run = ([start, end]) => {
    for (let o = cff + start; o < cff + end; ) {
      const b = v.getUint8(o);
      if (b >= 32 || b === 28) {
        if (b === 28) {
          stack.push(v.getInt16(o + 1));
          o += 3;
        } else if (b <= 246) {
          stack.push(b - 139);
          o++;
        } else if (b <= 250) {
          stack.push((b - 247) * 256 + v.getUint8(o + 1) + 108);
          o += 2;
        } else if (b <= 254) {
          stack.push(-(b - 251) * 256 - v.getUint8(o + 1) - 108);
          o += 2;
        } else {
          stack.push(v.getInt32(o + 1) / 65536);
          o += 5;
        }
        continue;
      }
      o++;
      const s = stack;
      switch (b) {
        case 1:
        case 3:
        case 18:
        case 23:
          width(true);
          stems += s.length / 2;
          stack = [];
          break;
        case 19:
        case 20:
          width(true);
          stems += s.length / 2;
          o += Math.ceil(stems / 8);
          stack = [];
          break;
        case 21:
          width(true);
          moveTo(s.at(-2), s.at(-1));
          stack = [];
          break;
        case 22:
          width(false);
          moveTo(s.at(-1), 0);
          stack = [];
          break;
        case 4:
          width(false);
          moveTo(0, s.at(-1));
          stack = [];
          break;
        case 5:
          for (let i = 0; i < s.length; i += 2) lineTo(s[i], s[i + 1]);
          stack = [];
          break;
        case 6:
        case 7:
          for (let i = 0; i < s.length; i++) {
            if ((i % 2 === 0) === (b === 6)) lineTo(s[i], 0);
            else lineTo(0, s[i]);
          }
          stack = [];
          break;
        case 8:
          for (let i = 0; i + 6 <= s.length; i += 6) curveTo(...s.slice(i, i + 6));
          stack = [];
          break;
        case 24:
          for (let i = 0; i + 6 <= s.length - 2; i += 6) curveTo(...s.slice(i, i + 6));
          lineTo(s.at(-2), s.at(-1));
          stack = [];
          break;
        case 25:
          for (let i = 0; i < s.length - 6; i += 2) lineTo(s[i], s[i + 1]);
          curveTo(...s.slice(-6));
          stack = [];
          break;
        case 26:
        case 27: {
          // vvcurveto and hhcurveto: an optional first cross offset, then curves along one axis.
          let i = s.length % 4 === 1 ? 1 : 0;
          let cross = i ? s[0] : 0;
          for (; i + 4 <= s.length; i += 4) {
            const [a, bb, c, e] = s.slice(i, i + 4);
            if (b === 26) curveTo(cross, a, bb, c, 0, e);
            else curveTo(a, cross, bb, c, e, 0);
            cross = 0;
          }
          stack = [];
          break;
        }
        case 30:
        case 31: {
          // vhcurveto and hvcurveto: curves alternating between vertical and horizontal tangents.
          let vertical = b === 30;
          for (let i = 0; i + 4 <= s.length; i += 4) {
            const last = s.length - i === 5 ? s[i + 4] : 0;
            const [a, bb, c, e] = s.slice(i, i + 4);
            if (vertical) curveTo(0, a, bb, c, e, last);
            else curveTo(a, 0, bb, c, last, e);
            vertical = !vertical;
          }
          stack = [];
          break;
        }
        case 10:
        case 29: {
          const subrs = b === 10 ? local : global;
          const i = stack.pop() + bias(subrs);
          if (run([subrs[i][0] - cff, subrs[i][1] - cff]) === "end") return "end";
          break;
        }
        case 11:
          return;
        case 14:
          width(false);
          if (open) d += "Z";
          open = false;
          return "end";
        default:
          throw new Error(`Charstring operator ${b} is not supported in a .notdef.`);
      }
    }
  };
  run([charstrings[0][0] - cff, charstrings[0][1] - cff]);
  return d;
}

const faces = {};
let vertical;
for (const [style, file] of Object.entries(FILES)) {
  const font = read(`SourceSans3-${file}.ttf`);
  // One set of vertical metrics serves every face, so they must agree.
  if (vertical && JSON.stringify(vertical) !== JSON.stringify(font.vertical))
    throw new Error(`${file}: vertical metrics differ from Regular's.`);
  vertical = font.vertical;
  faces[style] = font.face;
}
const out = new URL("../src/source-sans-3.ts", import.meta.url);
writeFileSync(
  out,
  `// Generated by scripts/font-metrics.mjs from the SourceSans3-*.ttf files; do not edit.\n\n` +
    `/** Source Sans 3's bundled faces in font units: the shared typographic ascender and descender, and each face's advance width by code point, and its \`.notdef\`'s advance and outline as SVG path data, y up. */\n` +
    `export const SOURCE_SANS_3 = ${JSON.stringify({ family: "Source Sans 3", ...vertical, faces })} as const;\n`,
);

// Noto Sans SC's advances as runs of consecutive code points sharing one: 30,166 of its 30,890 are
// 1000 wide.
const noto = {};
let notoVertical;
for (const [style, file] of Object.entries(NOTO_FILES)) {
  const { vertical: v, face } = read(`NotoSansSC-${file}.otf`);
  if (v.unitsPerEm !== vertical.unitsPerEm) throw new Error(`${file}: unitsPerEm differs.`);
  if (notoVertical && JSON.stringify(notoVertical) !== JSON.stringify(v))
    throw new Error(`${file}: vertical metrics differ from Regular's.`);
  notoVertical = v;
  const runs = [];
  for (const [c, a] of Object.entries(face.advances).map(([c, a]) => [Number(c), a])) {
    const last = runs.at(-1);
    if (last && last[0] + last[1] === c && last[2] === a) last[1]++;
    else runs.push([c, 1, a]);
  }
  noto[style] = { notdef: face.notdef, notdefPath: face.notdefPath, runs };
}
const notoOut = new URL("../src/noto-sans-sc.ts", import.meta.url);
writeFileSync(
  notoOut,
  `// Generated by scripts/font-metrics.mjs from the NotoSansSC-*.otf files; do not edit.\n\n` +
    `/** Noto Sans SC's bundled faces in font units: the shared typographic ascender and descender, each face's \`.notdef\` advance and outline as SVG path data, y up, and its advances as sorted runs of [first code point, count, advance]. */\n` +
    `export const NOTO_SANS_SC: { ascender: number; descender: number; faces: Record<"Regular" | "Bold", { notdef: number; notdefPath: string; runs: [number, number, number][] }> } = ${JSON.stringify({ ascender: notoVertical.ascender, descender: notoVertical.descender, faces: noto })};\n`,
);
execFileSync("pnpm", ["biome", "format", "--write", out.pathname, notoOut.pathname], {
  stdio: "inherit",
});
