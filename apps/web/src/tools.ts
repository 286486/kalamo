import type { Document, NodeInput } from "@zibel/core";
import type { PenPath } from "./receive.ts";
import { editable, placeParent } from "./selection.ts";
import { DEFAULT_FILL_STROKE, type State, send, useStore } from "./store.ts";

/** The Tools panel's tools. Their keys stay here, not in the menu table (ADR-0031). */
export type Tool = "selection" | "zoom" | "pen";
export const TOOL_KEYS: Record<string, Tool> = { V: "selection", Z: "zoom", P: "pen" };

/** The Fill and Stroke boxes (F-DRAW-12): what new art is painted with; null is None. */
export interface FillStroke {
  fill: string | null;
  stroke: string | null;
  active: "fill" | "stroke";
}

/** The Fill and Stroke boxes' keys, as in Illustrator, or null for another key. */
export function fillStrokeKey(p: FillStroke, keys: string): FillStroke | null {
  switch (keys) {
    case "D":
      return { ...DEFAULT_FILL_STROKE, active: p.active };
    case "X":
      return { ...p, active: p.active === "fill" ? "stroke" : "fill" };
    case "Shift+X":
      return { ...p, fill: p.stroke, stroke: p.fill };
    case "/":
      return { ...p, [p.active]: null };
    default:
      return null;
  }
}

type Point = [number, number];

/** Corner Anchors joined by straight segments. */
export const pathD = (points: Point[], closed: boolean) =>
  points.map(([x, y], i) => `${i ? "L" : "M"} ${x} ${y}`).join(" ") + (closed ? " Z" : "");

/** The `create` input for a finished path: the current Fill and Stroke, in placeParent's Layer. */
export function penNode(
  s: Pick<State, "selection" | "fillStroke"> & { doc: Document },
  pen: PenPath,
): NodeInput | null {
  const { fill, stroke } = s.fillStroke;
  const parentId = placeParent(s.doc, s.selection);
  // Illustrator refuses to draw into a hidden or locked Layer.
  if (!parentId || !editable(s.doc, s.doc.nodes.get(parentId))) return null;
  return {
    type: "path",
    parentId,
    d: pathD(pen.points, pen.closed),
    appearance: {
      fills: fill ? [{ color: fill }] : [],
      strokes: stroke ? [{ color: stroke, width: 1 }] : [],
    },
  };
}

/** The path the Pen is drawing, not yet sent. */
export const drawing = (s: State) => (s.pen?.commandId === null ? s.pen : null);

/**
 * Finishes the path the Pen is drawing and sends it as one `create` (ADR-0032). A single Anchor
 * would be a Stray Point, invisible, so it is dropped instead.
 */
export function finishPen(closed = false) {
  const s = useStore.getState();
  const pen = drawing(s);
  if (!pen) return;
  const done = { ...pen, closed };
  const node = s.doc && pen.points.length >= 2 ? penNode({ ...s, doc: s.doc }, done) : null;
  if (!node) {
    useStore.setState({
      pen: null,
      ...(pen.points.length >= 2 && {
        notice: "The Layer is hidden or locked; nothing was drawn.",
      }),
    });
    return;
  }
  const commandId = send({ type: "create", nodes: [node] });
  useStore.setState({ pen: { ...done, commandId } });
}

/** A Pen click: closes on the first Anchor, within `tolerance` pt, or places a Corner Anchor. */
export function penClick(p: Point, tolerance: number) {
  const pen = drawing(useStore.getState());
  const [first] = pen?.points ?? [];
  if (pen && first && pen.points.length >= 2) {
    if (Math.hypot(p[0] - first[0], p[1] - first[1]) <= tolerance) return finishPen(true);
  }
  useStore.setState({
    pen: { points: [...(pen?.points ?? []), p], closed: false, commandId: null },
  });
}

/** Ctrl+Z while drawing removes the last Anchor locally; false when not drawing. */
export function undoAnchor(): boolean {
  const pen = drawing(useStore.getState());
  if (!pen) return false;
  const points = pen.points.slice(0, -1);
  useStore.setState({ pen: points.length > 0 ? { ...pen, points } : null });
  return true;
}

/** Switching tools finishes the path the Pen is drawing, as in Illustrator. */
export function setTool(tool: Tool) {
  finishPen();
  useStore.setState({ tool });
}
