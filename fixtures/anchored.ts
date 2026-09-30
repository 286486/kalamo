/**
 * What the round trip's text-budget predicates read of a text's full view (`kalamo_node_get` with
 * detail full).
 */
export interface TextView {
  kind?: string;
  content?: string;
  alignment?: string;
  tracking?: number;
  ranges?: { start: number; end: number; fontSize?: number; tracking?: number }[];
}

/**
 * Whether Inkscape 1.2.2 anchors a line of this text away from the layout (ADR-0077): a centred or
 * right-aligned Point Type with a line before its last that ends in whitespace (any character
 * JavaScript's `/\s/` matches), or whose last character tracks, by the text's tracking or a
 * Character Range's. Inkscape anchors such a line as if its trailing whitespace and the tracking
 * after its last character counted; its last line, and a line ending in an untracked character,
 * it anchors as the layout does.
 */
export function anchoredBeforeLast(v: TextView): boolean {
  if (v.kind === "area" || (v.alignment !== "center" && v.alignment !== "right")) return false;
  const chars = [...(v.content ?? "")];
  /** The tracking of the character at code point `i`: its range's, else the text's. */
  const tracking = (i: number) =>
    v.ranges?.find((r) => r.start <= i && i < r.end && r.tracking !== undefined)?.tracking ??
    v.tracking ??
    0;
  // Every hard return closes a line before the last.
  return chars.some((c, i) => {
    if (c !== "\n" || i === 0 || chars[i - 1] === "\n") return false;
    return /\s/.test(chars[i - 1] as string) || tracking(i - 1) !== 0;
  });
}
