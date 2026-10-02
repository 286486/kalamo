import {
  createDocument,
  createNodes,
  fileTextWarnings,
  KalamoError,
  parseDocument,
  readImage,
} from "@kalamo/core";
import { type ConvertedImages, type OpenedFile, parseSvg } from "./read.ts";

export { type ConvertedImages, MAX_DEPTH, parseSvg, resolveLinks } from "./read.ts";
export { docRect, type SvgOptions, scopeRect, svgRect, toSvg } from "./write.ts";

export type { OpenedFile };

/**
 * The largest SVG Kalamo reads, in UTF-16 code units outside embedded images' data URLs, which
 * `readImage` caps one by one (REQUIREMENTS §6.7, ADR-0023).
 */
export const SVG_LIMIT = 5 * 1024 * 1024;

/** The length of `text` without the values of `href="data:…"` and `xlink:href="data:…"`. */
const outsideImages = (text: string) =>
  [...text.matchAll(/href\s*=\s*(["'])data:[^"']*\1/g)].reduce(
    (n, m) => n - m[0].length,
    text.length,
  );

const PREDEFINED_CHARS: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

/**
 * The `href` of each embedded image in SVG text, as the parsed attribute holds it: XML's
 * attribute-value normalisation applied, trimmed. The keys a `ConvertedImages` takes (ADR-0100).
 */
export const embeddedImages = (text: string) =>
  [...text.matchAll(/href\s*=\s*(["'])(\s*data:[^"']*)\1/g)].map(([, , value = ""]) =>
    value
      .replace(/[\t\n\r]/g, " ")
      .replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(lt|gt|amp|quot|apos));/g, (_, hex, dec, name) =>
        name
          ? (PREDEFINED_CHARS[name] ?? "")
          : String.fromCodePoint(parseInt(hex ?? dec, hex ? 16 : 10)),
      )
      .trim(),
  );

// XML 1.0's Name production.
const START =
  ":A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}";
const NAME = `[${START}][${START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F\\u2040]*`;
// Tempered, not lazy: a lazy match inside the star backtracks exponentially when no DOCTYPE follows.
const PROLOG =
  /(?:<\?(?:[^?]|\?(?!>))*\?>|<!--(?:[^-]|-(?!->))*-->|\s)*<!DOCTYPE\s+[^\s[>]+(?:\s+(?:SYSTEM|PUBLIC)(?:\s*(?:"[^"]*"|'[^']*'))+)?\s*\[/y;
/** One token of an internal subset: a declaration, comment, PI, PE reference or whitespace. */
const SUBSET =
  /\s+|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!(?:[^"'>]|"[^"]*"|'[^']*')*>|(%)[^;\s]*;|(\])\s*>/y;
const ENTITY = new RegExp(`^<!ENTITY\\s+(${NAME})\\s([\\s\\S]*)>$`, "u");
const PLAIN = /^\s*(?:"([^"&%<]*)"|'([^'&%<]*)')\s*$/;
const PREDEFINED = new Set(["lt", "gt", "amp", "quot", "apos"]);
/** What the parser leaves as written, and the references it expands. */
const REFERENCE = new RegExp(
  `<!--[\\s\\S]*?(?:-->|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>|$)|<\\?[\\s\\S]*?(?:\\?>|$)|&(${NAME});`,
  "gu",
);

/**
 * Expands the general internal entities of the DOCTYPE whose values are plain text, which xmldom cannot
 * (ADR-0017): Illustrator's legacy SVG export declares its namespaces and Entity-Reference styles so.
 * A value holds no `&`, `%` or `<`, so nothing nests, and the growth is capped at `SVG_LIMIT`. Other
 * references stay for xmldom to refuse.
 */
function expandEntities(text: string): string {
  PROLOG.lastIndex = 0;
  if (!PROLOG.test(text)) return text;
  const values = new Map<string, string>();
  const seen = new Set<string>();
  SUBSET.lastIndex = PROLOG.lastIndex;
  let end: number | undefined;
  for (let m = SUBSET.exec(text); m; m = SUBSET.exec(text)) {
    // XML stops reading declarations at an unread parameter entity.
    if (m[1]) return text;
    if (m[2]) {
      end = SUBSET.lastIndex;
      break;
    }
    const [, name, rest = ""] = ENTITY.exec(m[0]) ?? [];
    if (!name || seen.has(name)) continue;
    // The first declaration binds the name, even one that is not expanded.
    seen.add(name);
    const plain = PLAIN.exec(rest);
    const value = plain?.[1] ?? plain?.[2];
    if (value !== undefined && !PREDEFINED.has(name)) {
      values.set(name, value.replace(/"/g, "&quot;").replace(/'/g, "&apos;"));
    }
  }
  if (end === undefined || !values.size) return text;
  let growth = 0;
  const rest = text.slice(end).replace(REFERENCE, (m, name?: string) => {
    const value = name === undefined ? undefined : values.get(name);
    if (value === undefined) return m;
    growth += value.length - m.length;
    if (growth > SVG_LIMIT) {
      throw new KalamoError({
        code: "LIMIT_EXCEEDED",
        message: `The file's entities expand past ${SVG_LIMIT} characters, at &${name};.`,
        hint: "Save the SVG without entity references (in Illustrator, CSS Properties other than Entity References), or re-save it from Inkscape.",
        path: "content",
      });
    }
    return value;
  });
  return text.slice(0, end) + rest;
}

/**
 * A PNG, JPEG or GIF data URL as a new Document (ADR-0098): one Artboard at the origin at its pixel
 * size, and `Layer 1` holding the Image that fills it. Named by `name` without its extension, a
 * converted WebP's `.webp` included (ADR-0100).
 */
function openImage(src: string, name = ""): OpenedFile {
  const file = readImage(src, "content");
  const { width, height } = file;
  const { doc, defaultLayerId } = createDocument({
    id: "",
    name: name.replace(/\.(png|jpe?g|gif|webp)$/i, "") || "Untitled",
    artboards: [{ width, height }],
  });
  // resolveImages renames the key to the file's hash.
  const key = "content";
  doc.images.set(key, file);
  createNodes(doc, [
    { type: "image", parentId: defaultLayerId, src: key, x: 0, y: 0, width, height },
  ]);
  const { artboards, nodes } = doc;
  return {
    name: doc.name,
    artboards,
    nodes: [...nodes.values()],
    images: new Map([[key, file]]),
    warnings: [],
  };
}

/**
 * Reads a file for Open or Place (ADR-0017): `.kalamo.json`, SVG or, for Open, a bitmap's data URL
 * (ADR-0098), told apart by content. `name` is the file name, used for an SVG that names no
 * Document and for a bitmap; `converted`, an SVG's embedded images the Worker converted (ADR-0100).
 */
export function parseFile(
  content: string,
  { name, converted }: { name?: string; converted?: ConvertedImages } = {},
): OpenedFile & { format: "svg" | "kalamo_json" | "image" } {
  const text = content.replace(/^﻿/, "").trimStart();
  if (/^data:/i.test(text)) return { ...openImage(text, name), format: "image" };
  let file: OpenedFile;
  if (text.startsWith("{")) file = { ...parseDocument(text), warnings: [] };
  else if (text.startsWith("<")) {
    const size = outsideImages(text);
    if (size > SVG_LIMIT) {
      throw new KalamoError({
        code: "LIMIT_EXCEEDED",
        message: `The SVG is ${size} characters outside its embedded images; Kalamo reads at most ${SVG_LIMIT}.`,
        hint: "Split the drawing into several files, or remove embedded images and unused defs.",
        path: "content",
      });
    }
    file = parseSvg(expandEntities(text), name, converted);
  } else {
    throw new KalamoError({
      code: "INVALID_DOCUMENT",
      message: "The content is not an SVG or .kalamo.json file.",
      hint: "Pass the text of an .svg file, of a .kalamo.json file as kalamo_export returns it, or a data: URL of a PNG, JPEG, GIF or WebP.",
      path: "content",
    });
  }
  const format = text.startsWith("<") ? "svg" : "kalamo_json";
  const warnings = [...file.warnings, ...fileTextWarnings(file.nodes)];
  return { ...file, format, warnings };
}
