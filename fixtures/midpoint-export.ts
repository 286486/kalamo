/**
 * `MIDPOINT_DOC` opened, and the midpoint edits of its export, for the Vitest tests. `pnpm roundtrip`
 * edits the app's own export instead, so only Vitest loads this and its imports of core and io.
 */
import { type Document, parseDocument } from "../packages/core/src/index.ts";
import { toSvg } from "../packages/io/src/index.ts";
import { MIDPOINT_DOC, midpointEdits } from "./midpoint-edits.ts";

/** `MIDPOINT_DOC` as a Document. */
export function midpointDocument(): Document {
  const file = parseDocument(MIDPOINT_DOC);
  return { id: "", version: 1, rev: 0, ...file, nodes: new Map(file.nodes.map((n) => [n.id, n])) };
}

/** Each edit of the Document's export, by name. */
export const exportedMidpointEdits = () => midpointEdits(toSvg(midpointDocument()));
