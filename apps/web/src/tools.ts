import {
  type BareAnchor,
  type Document,
  formatPath,
  fromAnchors,
  type NodeInput,
} from "@zibel/core";
import type { PenPath } from "./receive.ts";
import { editable, placeParent } from "./selection.ts";
import { DEFAULT_FILL_STROKE, type State, send, useStore } from "./store.ts";
import type { Tool, ToolEvent } from "./toolbox.ts";

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

/** The path's `d`: its Anchors, curved where they have Handles. */
export const pathD = (anchors: BareAnchor[], closed: boolean) =>
  formatPath(fromAnchors([{ closed, anchors }]));

/** `p` moved onto the nearest line through `from` at a multiple of 45°. */
export function constrain(from: Point, p: Point): Point {
  const [dx, dy] = [p[0] - from[0], p[1] - from[1]];
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const [ux, uy] = [Math.cos(angle), Math.sin(angle)];
  const length = dx * ux + dy * uy;
  // Rounded, so the diagonal's cos and sin do not leave 1e-15 in `d`.
  const at = (v: number) => Math.round(v * 1e9) / 1e9;
  return [at(from[0] + ux * length), at(from[1] + uy * length)];
}

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
    d: pathD(pen.anchors, pen.closed),
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
  const node = s.doc && pen.anchors.length >= 2 ? penNode({ ...s, doc: s.doc }, done) : null;
  if (!node) {
    useStore.setState({
      pen: null,
      ...(pen.anchors.length >= 2 && {
        notice: "The Layer is hidden or locked; nothing was drawn.",
      }),
    });
    return;
  }
  const commandId = send({ type: "create", nodes: [node] });
  useStore.setState({ pen: { ...done, commandId } });
}

/** The Pen's modifiers while its button is down. */
export type PenMods = Pick<ToolEvent, "shift" | "alt" | "ctrl" | "space">;

/**
 * The Anchor the Pen's button is down on, at `index`, and the pointer's last position. It is one
 * just placed, the last Anchor pressed again, or the first Anchor, which closes the path on release.
 * `broken` is set once Alt broke the Handles, which stay broken for the rest of the press.
 */
let press: {
  kind: "place" | "last" | "close";
  index: number;
  at: Point;
  broken?: boolean;
} | null = null;

export const penPressed = () => press !== null;
export const penClosing = () => press?.kind === "close";

const near = (a: Point, b: Point, tolerance: number) =>
  Math.hypot(a[0] - b[0], a[1] - b[1]) <= tolerance;

/**
 * A Pen press (research 06 §1): on the first Anchor it will close the path, on the last it removes
 * that Anchor's outgoing Handle, and anywhere else it places a Corner Anchor, which a drag then
 * makes Smooth. Shift constrains the new segment to 45°.
 */
export function penDown(p: Point, tolerance: number, shift = false) {
  const pen = drawing(useStore.getState());
  const anchors = pen?.anchors ?? [];
  const first = anchors[0];
  const last = anchors.at(-1);
  if (first && anchors.length >= 2 && near(p, first.anchor, tolerance)) {
    press = { kind: "close", index: 0, at: p };
  } else if (pen && last && near(p, last.anchor, tolerance)) {
    press = { kind: "last", index: anchors.length - 1, at: p };
    useStore.setState({ pen: { ...pen, anchors: anchors.with(-1, { ...last, handleOut: null }) } });
  } else {
    press = { kind: "place", index: anchors.length, at: p };
    const anchor = last && shift ? constrain(last.anchor, p) : p;
    useStore.setState({
      pen: {
        anchors: [...anchors, { anchor, handleIn: null, handleOut: null }],
        closed: false,
        commandId: null,
      },
    });
  }
}

/**
 * A drag of the press to `p`. It pulls the outgoing Handle and the incoming one mirrors it: Alt
 * leaves the incoming Handle where it is (a Corner, Illustrator's cusp), Ctrl keeps its length, and Shift constrains
 * the Handle to 45°. Space moves the Anchor with its Handles instead. On the last Anchor only the
 * outgoing Handle moves; closing, Alt leaves the outgoing one and shapes the closing segment.
 */
export function penDrag(p: Point, mods: PenMods) {
  const pen = drawing(useStore.getState());
  const a = press && pen?.anchors[press.index];
  if (!press || !pen || !a) return;
  const [dx, dy] = [p[0] - press.at[0], p[1] - press.at[1]];
  press.at = p;
  // Illustrator's documented order is to release Alt, then the button: the cusp stays.
  press.broken ||= mods.alt;
  const alt = press.broken;
  const [x, y] = a.anchor;
  const out = mods.shift ? constrain(a.anchor, p) : p;
  const [ox, oy] = [out[0] - x, out[1] - y];
  const mirror: Point = [x - ox, y - oy];
  let next: BareAnchor;
  if (mods.space) {
    const by = (h: Point | null): Point | null => h && [h[0] + dx, h[1] + dy];
    next = { anchor: [x + dx, y + dy], handleIn: by(a.handleIn), handleOut: by(a.handleOut) };
  } else if (press.kind === "close" && alt) next = { ...a, handleIn: mirror };
  else if (press.kind === "last" || alt) next = { ...a, handleOut: out };
  else if (mods.ctrl && a.handleIn) {
    const k = Math.hypot(a.handleIn[0] - x, a.handleIn[1] - y) / (Math.hypot(ox, oy) || 1);
    next = { ...a, handleIn: [x - ox * k, y - oy * k], handleOut: out };
  } else next = { ...a, handleIn: mirror, handleOut: out };
  useStore.setState({ pen: { ...pen, anchors: pen.anchors.with(press.index, next) } });
}

/** Drops the press, leaving what it placed. */
export const penCancel = () => {
  press = null;
};

/** Releasing the Pen: a press on the first Anchor closes the path. */
export function penUp() {
  const closing = press?.kind === "close";
  press = null;
  if (closing) finishPen(true);
}

/** Ctrl+Z while drawing removes the last Anchor locally; false when not drawing. */
export function undoAnchor(): boolean {
  const pen = drawing(useStore.getState());
  if (!pen) return false;
  const anchors = pen.anchors.slice(0, -1);
  useStore.setState({ pen: anchors.length > 0 ? { ...pen, anchors } : null });
  return true;
}

/** Switching tools finishes the path the Pen is drawing, as in Illustrator, and drops selected Anchors. */
export function setTool(tool: Tool) {
  finishPen();
  useStore.setState({ tool, anchors: [] });
}
