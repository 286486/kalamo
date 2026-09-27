import { fontWarnings, parseDocument, ZibelError } from "@zibel/core";
import { type OpenedFile, parseSvg, type Warning } from "./read.ts";

export { MAX_DEPTH, parseSvg } from "./read.ts";
export { docRect, type SvgOptions, scopeRect, svgRect, toSvg } from "./write.ts";

export type { OpenedFile, Warning };

/**
 * The largest SVG Zibel reads, in UTF-16 code units outside embedded images' data URLs, which
 * `readImage` caps one by one (REQUIREMENTS §6.7, ADR-0023).
 */
// ponytail: many embedded images are bounded only by the request and RPC limits (32 MiB).
export const SVG_LIMIT = 5 * 1024 * 1024;

/** The length of `text` without the values of `href="data:…"` and `xlink:href="data:…"`. */
const outsideImages = (text: string) =>
  [...text.matchAll(/href\s*=\s*(["'])data:[^"']*\1/g)].reduce(
    (n, m) => n - m[0].length,
    text.length,
  );

/**
 * Reads a file for Open or Place (ADR-0017): `.zibel.json` or SVG, told apart by content. `name` is the
 * file name, used for an SVG that names no Document.
 */
export function parseFile(
  content: string,
  { name }: { name?: string } = {},
): OpenedFile & { format: "svg" | "zibel_json" } {
  const text = content.replace(/^﻿/, "").trimStart();
  let file: OpenedFile;
  if (text.startsWith("{")) file = { ...parseDocument(text), warnings: [] };
  else if (text.startsWith("<")) {
    const size = outsideImages(text);
    if (size > SVG_LIMIT) {
      throw new ZibelError({
        code: "LIMIT_EXCEEDED",
        message: `The SVG is ${size} characters outside its embedded images; Zibel reads at most ${SVG_LIMIT}.`,
        hint: "Split the drawing into several files, or remove embedded images and unused defs.",
        path: "content",
      });
    }
    file = parseSvg(text, name);
  } else {
    throw new ZibelError({
      code: "INVALID_DOCUMENT",
      message: "The content is not an SVG or .zibel.json file.",
      hint: "Pass the text of an .svg file, or of a .zibel.json file as zibel_export returns it.",
      path: "content",
    });
  }
  // One per font, not per text: a file set in one missing font says so once.
  const fonts = new Map<string, Warning>();
  for (const w of fontWarnings(file.nodes)) if (!fonts.has(w.message)) fonts.set(w.message, w);
  const format = text.startsWith("<") ? "svg" : "zibel_json";
  return { ...file, format, warnings: [...file.warnings, ...fonts.values()] };
}
