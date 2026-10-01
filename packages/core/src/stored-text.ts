import { KalamoError } from "./errors.ts";
import { edgesOf, windsTwice } from "./frame.ts";
import { formatPath, parsePath, pathBounds, round3, type Segment } from "./path.ts";
import type { Alignment, CharacterRange, Rect } from "./schema.ts";
import { canonicalRanges, type OwnAttributes, storedAutoSize } from "./text.ts";

type Code = "INVALID_INPUT" | "INVALID_PATCH";

/** Whether every subpath of `segments` is closed with Z. */
export const allSubpathsClosed = (segments: Segment[]) =>
  segments.at(-1)?.cmd === "Z" &&
  segments.every((s, i) => s.cmd !== "M" || i === 0 || segments[i - 1]?.cmd === "Z");

/**
 * A shaped Area Type's frame, normalized, and its bounds to 3 decimals, which the text stores as
 * its `x, y, width, height` (ADR-0078). Refuses open or empty path data, and an evenodd outline
 * whose holes the frame's nonzero inside would fill.
 */
export function shapedFrame(
  segments: Segment[],
  path: string,
  code: Code = "INVALID_INPUT",
  fillRule: "nonzero" | "evenodd" = "nonzero",
): { frame: string } & Rect {
  const invalid = (message: string, hint: string) => new KalamoError({ code, message, hint, path });
  if (!allSubpathsClosed(segments)) {
    throw invalid(
      "The frame is open: Area Type flows only inside a closed path.",
      "End every subpath with Z, or use a closed Live Shape or Path.",
    );
  }
  // The bounds of the frame as stored, to 3 decimals, so a file reads back the same (ADR-0078).
  const frame = formatPath(segments);
  const exact = pathBounds(parsePath(frame, path));
  const b = exact && {
    x: round3(exact.x),
    y: round3(exact.y),
    width: round3(exact.width),
    height: round3(exact.height),
  };
  if (!b || b.width <= 0 || b.height <= 0) {
    throw invalid("The frame encloses no area.", "Give the frame a width and a height.");
  }
  if (fillRule === "evenodd" && windsTwice(edgesOf(frame))) {
    throw invalid(
      "The frame's holes wind the same way as its outline: the evenodd rule leaves them empty, but a frame's inside is nonzero.",
      "Reverse each hole's direction so it winds against the outline, or frame the text in a shape without holes.",
    );
  }
  return { frame, ...b };
}

/**
 * Auto Size belongs to rectangular Area Type (ADR-0092): Point Type and a shaped frame have none.
 * The schema refinements word it for their boundary; `refuseMisplacedAutoSize` refuses it on a
 * write.
 */
export const autoSizeMisplaced = (t: { kind?: string; frame?: unknown; autoSize?: unknown }) =>
  t.autoSize !== undefined && (t.kind !== "area" || t.frame !== undefined);

/**
 * Refuses a misplaced Auto Size in node_update's words: create and Open refuse it at their parse
 * first, and node_update checks it before its merge too, so it is named before any value its
 * per-type schema refuses.
 */
export function refuseMisplacedAutoSize(
  t: Parameters<typeof autoSizeMisplaced>[0],
  path: string,
  code: Code,
) {
  if (autoSizeMisplaced(t)) {
    throw new KalamoError({
      code,
      message: "Auto Size belongs to a rectangular frame.",
      hint: "Send frame: null with it to make the frame the rectangle of its bounds.",
      path: `${path}.autoSize`,
    });
  }
}

/** A text shape on its way in: a shaped frame's bounds may be missing or stale. */
type Storable = OwnAttributes & {
  kind?: "point" | "area";
  frame?: string | undefined;
  autoSize?: boolean | undefined;
  alignment?: Alignment | undefined;
  ranges?: Parameters<typeof canonicalRanges>[0];
};
type Stored<T> = Omit<T, "ranges"> & { ranges?: CharacterRange[] };

/**
 * A text Node's stored form, for node_create, node_update after its merge patch, and Open
 * (ADR-0077, ADR-0078, ADR-0029, ADR-0092): left alignment dropped, a shaped frame normalized with
 * its bounds as `x, y, width, height`, Character Ranges canonical and Auto Size's height fitted.
 * Errors carry `code` and name their key under `path`.
 */
export function storedText<T extends Storable>(t: T, path: string, code: Code): Stored<T> {
  refuseMisplacedAutoSize(t, path, code);
  const { alignment, ranges, ...rest } = t;
  const text = { ...rest, ...(alignment !== undefined && alignment !== "left" && { alignment }) };
  if (text.frame !== undefined) {
    Object.assign(text, shapedFrame(parsePath(text.frame, `${path}.frame`), `${path}.frame`, code));
  }
  // The order matters: Auto Size lays out the frame's width with canonical ranges, and callers
  // paint what this returns, so a default gradient spans the fitted bounds.
  const canonical = canonicalRanges(ranges, `${path}.ranges`, text);
  const stored = { ...text, ...(canonical && { ranges: canonical }) };
  return storedAutoSize(
    stored as typeof stored & Parameters<typeof storedAutoSize>[0],
  ) as Stored<T>;
}
