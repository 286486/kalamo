import { type Document, type Gradient, type LeafNode, worldTransform } from "@kalamo/core";
import { dragHandle, dragVector, type Handle, hitHandle, layout, type Point } from "./annotator.ts";
import { dragged, type Press, SELECTION } from "./canvas.ts";
import {
  activeGradient,
  addStop,
  type Box,
  cancelPaint,
  DEFAULT_STOPS,
  type PaintUpdate,
  paintTargets,
  paintUpdates,
  placeOn,
  previewPaint,
  sendPaint,
  setColor,
} from "./gradient.ts";
import { useStore } from "./store.ts";
import type { CanvasTool } from "./toolbox.ts";
import { constrain } from "./tools.ts";

/** The leaf the Annotator shows on: the one selected leaf, when its active paint is a gradient. */
export function annotated(doc: Document, selection: string[], box: Box): LeafNode | null {
  const [only] = selection.length === 1 ? paintTargets(doc, selection) : [];
  return only && only.id === selection[0] && activeGradient(only, box) ? only : null;
}

/** A press: on a part of the Annotator, or a drag setting every target's vector. */
let gesture:
  | (Press & { last: Point } & (
        | { kind: "handle"; handle: Handle; node: LeafNode; g: Gradient }
        | { kind: "vector"; targets: LeafNode[] }
      ))
  | null = null;

/** What the gesture paints with the pointer at `to`, Shift held or not. */
function updatesAt(to: Point, shift: boolean): PaintUpdate[] {
  if (!gesture) return [];
  const { doc, viewport, fillStroke } = useStore.getState();
  if (!doc) return [];
  const [box, scale] = [fillStroke.active, viewport?.scale ?? 1];
  if (gesture.kind === "handle") {
    const { handle, node, g, start } = gesture;
    const next = dragHandle(g, handle, worldTransform(doc, node), start, to, scale);
    return paintUpdates([node], box, () => next);
  }
  const from = gesture.start;
  const [x, y] = shift ? constrain([from.x, from.y], [to.x, to.y]) : [to.x, to.y];
  return paintUpdates(gesture.targets, box, (g, n) => {
    // A solid paint takes the default gradient first, as in Illustrator.
    const base = g ?? placeOn(n, { type: "linear", stops: DEFAULT_STOPS });
    return dragVector(base, worldTransform(doc, n), from, { x, y });
  });
}

/** Opens the browser's colour picker for stop `index`, one Transaction when it is chosen. */
function pickColor(node: LeafNode, g: Gradient, index: number, box: Box) {
  const input = document.createElement("input");
  input.type = "color";
  input.value = (g.stops[index]?.color ?? "#000000").slice(0, 7).toLowerCase();
  const alpha = g.stops[index]?.color.slice(7) ?? "";
  const updates = () => {
    const stops = setColor(g.stops, index, input.value.toUpperCase() + alpha);
    return paintUpdates([node], box, () => ({ ...g, stops }));
  };
  input.addEventListener("input", () => previewPaint(updates()));
  input.addEventListener("change", () => {
    sendPaint(updates());
    input.remove();
  });
  input.style.cssText = "position:fixed;opacity:0;pointer-events:none";
  document.body.append(input);
  input.click();
}

/**
 * Illustrator's Gradient tool (ADR-0081): a drag sets the Selection's active paint's vector, and
 * on one selected leaf with a gradient it shows the Gradient Annotator, whose parts drag.
 */
export const gradientTool: CanvasTool = {
  title: "Gradient Tool",
  shortcut: "G",
  icon: "M2 2 H14 V14 H2 Z M2 14 L14 2",
  iconFill: "none",
  cursor: "crosshair",
  down(e) {
    const { selection, fillStroke } = useStore.getState();
    const targets = paintTargets(e.doc, selection);
    if (targets.length === 0) return;
    const start = { x: e.x, y: e.y };
    const base = { start, moved: false, last: start };
    const node = annotated(e.doc, selection, fillStroke.active);
    const g = node && activeGradient(node, fillStroke.active);
    const handle =
      node &&
      g &&
      hitHandle(
        layout(g, worldTransform(e.doc, node), e.viewport.scale),
        start,
        e.viewport.scale,
        e.alt,
      );
    gesture =
      node && g && handle
        ? { ...base, kind: "handle", handle, node, g }
        : { ...base, kind: "vector", targets };
    useStore.setState({ notice: null });
    e.capture();
  },
  move(e) {
    if (!gesture) return;
    gesture.last = { x: e.x, y: e.y };
    if (dragged(gesture, e)) previewPaint(updatesAt(gesture.last, e.shift));
  },
  up(e) {
    const g = gesture;
    if (!g) return;
    const updates = g.moved ? updatesAt({ x: e.x, y: e.y }, e.shift) : [];
    gesture = null;
    const box = useStore.getState().fillStroke.active;
    if (g.moved) return sendPaint(updates);
    cancelPaint();
    if (g.kind !== "handle") return;
    // A click on the bar adds a stop there; a double-click on a stop opens its colour.
    if (g.handle.kind === "bar") {
      const { stops } = addStop(g.g.stops, g.handle.t);
      sendPaint(paintUpdates([g.node], box, () => ({ ...g.g, stops })));
    } else if (g.handle.kind === "stop" && e.clicks === 2) {
      pickColor(g.node, g.g, g.handle.index, box);
    }
  },
  cancel(redraw) {
    gesture = null;
    cancelPaint();
    redraw();
  },
  keyChange(key, redraw) {
    if (!gesture) return false;
    if (key.key === "Escape" && key.down) {
      gesture = null;
      cancelPaint();
      redraw();
      return true;
    }
    // Shift constrains a vector to 45° steps as it is pressed or released.
    if (key.key === "Shift" && gesture.moved) previewPaint(updatesAt(gesture.last, key.shift));
    return false;
  },
  draw(ctx, doc, scale) {
    const { tool, selection, fillStroke } = useStore.getState();
    if (tool !== "gradient") return;
    const node = annotated(doc, selection, fillStroke.active);
    const g = node && activeGradient(node, fillStroke.active);
    if (!node || !g) return;
    drawAnnotator(ctx, g, layout(g, worldTransform(doc, node), scale), scale);
  },
};

/** The Annotator, in document coordinates at `scale`, with screen-sized strokes and handles. */
function drawAnnotator(
  ctx: CanvasRenderingContext2D,
  g: Gradient,
  l: ReturnType<typeof layout>,
  scale: number,
) {
  const px = (n: number) => n / scale;
  ctx.save();
  ctx.lineWidth = px(1);
  ctx.strokeStyle = SELECTION;
  if (l.ellipse) {
    ctx.setLineDash([px(3), px(3)]);
    ctx.beginPath();
    for (const p of l.ellipse) ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // The bar: black under white, so it shows on any colour.
  for (const [color, width] of [
    ["#000000", 3],
    ["#FFFFFF", 1],
  ] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = px(width);
    ctx.beginPath();
    ctx.moveTo(l.origin.x, l.origin.y);
    ctx.lineTo(l.end.x, l.end.y);
    ctx.stroke();
  }
  ctx.lineWidth = px(1);
  ctx.strokeStyle = "#000000";
  const dot = (p: Point, r: number, fill: string) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(p.x, p.y, px(r), 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
  };
  const square = (p: Point, r: number, fill: string) => {
    ctx.fillStyle = fill;
    ctx.fillRect(p.x - px(r), p.y - px(r), px(2 * r), px(2 * r));
    ctx.strokeRect(p.x - px(r), p.y - px(r), px(2 * r), px(2 * r));
  };
  dot(l.origin, 4, "#FFFFFF");
  square(l.end, 3.5, "#000000");
  if (l.aspect) dot(l.aspect, 3, SELECTION);
  if (l.focus) dot(l.focus, 2.5, "#000000");
  g.stops.forEach((s, i) => {
    const p = l.stops[i] as Point;
    square(p, 4, s.color);
  });
  for (const m of l.midpoints) {
    if (!m) continue;
    ctx.fillStyle = "#FFFFFF";
    ctx.beginPath();
    ctx.moveTo(m.x, m.y - px(4));
    ctx.lineTo(m.x + px(4), m.y);
    ctx.lineTo(m.x, m.y + px(4));
    ctx.lineTo(m.x - px(4), m.y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}
