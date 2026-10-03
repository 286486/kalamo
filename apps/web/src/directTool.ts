import { type Anchor, type Document, formatPath, fromAnchors, type Rect } from "@kalamo/core";
import {
  ARROW,
  cancelDrag,
  dragged,
  drawMarquee,
  type Mods,
  type Press,
  rectOf,
  SELECTION,
  sendPreview,
} from "./canvas.ts";
import {
  allKeys,
  anchorKey,
  anchorsOf,
  hasAnchors,
  marqueeAnchors,
  moveAnchors,
  moveHandle,
  moveSegment,
  parseKey,
  pick,
  segmentHandles,
  splitWhole,
  type Target,
  targetKeys,
  targetNode,
} from "./direct.ts";
import type { Preview } from "./receive.ts";
import { combine, hitTest } from "./selection.ts";
import { afterReverse, useStore } from "./store.ts";
import type { CanvasTool } from "./toolbox.ts";

/** Direct Selection hits an Anchor, Handle or segment within 2 screen px (research §4). */
const DIRECT_HIT = 2;

/**
 * A press on the canvas: moving objects or drawing a marquee, as the Selection tool does, or
 * dragging Anchors, or one Handle or segment, which the store keeps as `grabbed` so a Reverse Path
 * Direction press's answer renumbers them (ADR-0110); `last` is its latest move.
 */
type Gesture = Press & { last?: { dx: number; dy: number; alt: boolean } } & (
    | { kind: "move"; nodeIds: string[] }
    | { kind: "marquee"; mods: Mods }
    | { kind: "anchors" }
    | { kind: "target" }
  );
let gesture: Gesture | null = null;
let marqueeRect: Rect | null = null;

const anchorTarget = (key: string): Target => ({ kind: "anchor", key });
const anchorKeys = (grabbed: Target[]) => grabbed.flatMap((t) => targetKeys(t).anchors);

/** The preview of `g`'s latest move of `grabbed` on `doc`, as `sendPreview` sends it. */
function dragOf(g: Gesture, doc: Document, grabbed: Target[]): Partial<Preview> | null {
  if (!g.last || g.kind === "marquee") return null;
  const { dx, dy, alt } = g.last;
  if (g.kind === "move") return { drag: { nodeIds: g.nodeIds, dx, dy, commandId: null } };
  const keys = g.kind === "anchors" ? anchorKeys(grabbed) : [];
  // Paths with every Anchor selected move whole, so a Live Shape stays live; the rest by their
  // Anchors.
  const { whole, partial } = splitWhole(doc, keys);
  const t = g.kind === "target" ? grabbed[0] : null;
  const inputs =
    g.kind === "anchors"
      ? moveAnchors(doc, partial, dx, dy)
      : [
          t?.kind === "handle"
            ? moveHandle(doc, t.key, t.which, dx, dy, alt)
            : t?.kind === "segment"
              ? moveSegment(doc, t.nodeId, t.subpath, t.segment, t.t, dx, dy)
              : null,
        ].filter((input) => input !== null);
  return {
    drag: whole.length > 0 ? { nodeIds: whole, dx, dy, commandId: null } : null,
    edit: inputs.length > 0 ? { inputs, commandIds: null } : null,
  };
}

/** Illustrator's white arrow: Anchors, Handles and segments (research §4). */
export const directTool: CanvasTool = {
  title: "Direct Selection Tool",
  shortcut: "A",
  icon: ARROW,
  cursor: "default",
  /**
   * A shown Handle, an Anchor, a segment, inside a filled path (all its Anchors), or a marquee.
   * Shift adds or removes, without a drag.
   */
  down(e) {
    const { doc } = e;
    const { selection, anchors, segments, isolated: scope } = useStore.getState();
    const start = { x: e.x, y: e.y };
    const mods = { shift: e.shift, alt: e.alt };
    useStore.setState({ notice: null });
    const tolerance = DIRECT_HIT / e.viewport.scale;
    const target = pick(doc, { selection, anchors, segments, ...start, tolerance, scope });
    const leaf = target
      ? null
      : hitTest(e.ctx, doc, start.x, start.y, tolerance, { leaf: true, scope });
    const nodeId = target ? targetNode(target) : leaf;
    const node = doc.nodes.get(nodeId ?? "");
    const keys =
      target?.kind === "anchor" ? [target.key] : !target && hasAnchors(node) ? allKeys(node) : [];
    const segment =
      target?.kind === "segment" ? anchorKey(target.nodeId, target.subpath, target.segment) : null;
    const segmentKeys = segment ? [segment] : [];
    if (nodeId && mods.shift) {
      const shown = selection.includes(nodeId) ? selection : [...selection, nodeId];
      useStore.setState({
        selection: shown,
        anchors: combine(anchors, keys, mods),
        segments: combine(segments, segmentKeys, mods),
      });
      return;
    }
    e.capture();
    const g = { start, moved: false };
    let grabbed: Target[] = [];
    if (target?.kind === "handle") {
      gesture = { ...g, kind: "target" };
      grabbed = [target];
    } else if (nodeId) {
      // Pressing a selected Anchor or segment, or inside a path whose Anchors are all selected,
      // keeps the selection, so all of it moves; a segment selects no Anchor.
      const kept =
        (keys.length > 0 && keys.every((k) => anchors.includes(k))) ||
        (!!segment && segments.includes(segment));
      if (!kept) useStore.setState({ selection: [nodeId], anchors: keys, segments: segmentKeys });
      const moving = kept ? anchors : keys;
      if (target?.kind === "segment") {
        gesture = { ...g, kind: "target" };
        grabbed = [target];
      } else if (moving.length > 0) {
        gesture = { ...g, kind: "anchors" };
        grabbed = moving.map(anchorTarget);
      } else gesture = { ...g, kind: "move", nodeIds: [nodeId] };
    } else {
      gesture = { ...g, kind: "marquee", mods };
    }
    const current = gesture;
    useStore.setState({ grabbed, regrab: (doc, held) => current && dragOf(current, doc, held) });
  },
  move(e) {
    const g = gesture;
    const d = g && dragged(g, e);
    if (!g || !d) return;
    const [dx, dy] = d;
    if (g.kind === "marquee") {
      marqueeRect = rectOf(g.start, e);
      e.redraw();
      return;
    }
    g.last = { dx, dy, alt: e.alt };
    const drag = dragOf(g, e.doc, useStore.getState().grabbed);
    if (drag) useStore.setState(drag);
  },
  up(e) {
    const g = gesture;
    gesture = null;
    const { grabbed } = useStore.getState();
    useStore.setState({ grabbed: [], regrab: null });
    if (g?.kind === "marquee") {
      // A marquee selects Anchors; the Selection is the paths they are on.
      const { selection, anchors, segments, isolated } = useStore.getState();
      const keys = g.moved && marqueeRect ? marqueeAnchors(e.doc, marqueeRect, isolated) : [];
      const next = combine(anchors, keys, g.mods);
      const paths = next.map((k) => parseKey(k).nodeId);
      const kept = g.mods.shift ? selection : [];
      useStore.setState({
        anchors: next,
        segments: g.mods.shift ? segments : [],
        selection: [...new Set([...kept, ...paths])],
      });
      marqueeRect = null;
      e.redraw();
    } else if (g?.moved && (g.kind === "move" || grabbed.length > 0)) {
      // Sent once a Reverse Path Direction press in flight is answered, from the Document then, on
      // what is still grabbed. What it holds is renumbered as the keys are, and another Actor's edit
      // to its path meanwhile drops it, as it drops the keys (ADR-0109, ADR-0110).
      const [grabbedTarget] = grabbed;
      afterReverse(
        ({ doc: now, anchors, target }, w) => {
          if (!now) return;
          if (g.kind === "target" && !target) return;
          const held = g.kind === "anchors" ? anchors.map(anchorTarget) : target ? [target] : [];
          sendPreview(dragOf(g, now, held), w);
        },
        {
          ...(g.kind === "target" && grabbedTarget
            ? { target: grabbedTarget }
            : { anchors: g.kind === "anchors" ? anchorKeys(grabbed) : [], segments: [] }),
          previewed: true,
        },
      );
    }
  },
  cancel(redraw) {
    gesture = null;
    marqueeRect = null;
    useStore.setState({ grabbed: [], regrab: null });
    redraw();
    cancelDrag();
  },
  draw(ctx, _doc, scale) {
    if (marqueeRect) drawMarquee(ctx, marqueeRect, scale);
  },
  /**
   * Its outline and Anchors, hollow unless selected. A selected segment is drawn thicker; it and a
   * selected Anchor show their Handles.
   */
  drawSelected(ctx, doc, node, scale) {
    if (!hasAnchors(node)) return false;
    const { anchors, segments } = useStore.getState();
    const r = 2.5 / scale;
    const subpaths = anchorsOf(doc, node);
    ctx.stroke(new Path2D(formatPath(fromAnchors(subpaths))));
    const shown = new Set<string>();
    for (const key of segments.filter((k) => parseKey(k).nodeId === node.id)) {
      const ends = segmentHandles(doc, key).map((h) => {
        shown.add(`${h.key} ${h.which}`);
        const { subpath, index } = parseKey(h.key);
        return subpaths[subpath]?.anchors[index] as Anchor;
      });
      if (ends.length === 0) continue;
      ctx.save();
      ctx.lineWidth *= 2;
      ctx.stroke(new Path2D(formatPath(fromAnchors([{ closed: false, anchors: ends }]))));
      ctx.restore();
    }
    for (const [k, s] of subpaths.entries()) {
      for (const [i, a] of s.anchors.entries()) {
        const [ax, ay] = a.anchor;
        const key = anchorKey(node.id, k, i);
        const on = anchors.includes(key);
        const handles = (["handleIn", "handleOut"] as const)
          .filter((which) => on || shown.has(`${key} ${which}`))
          .map((which) => a[which]);
        for (const h of handles) {
          if (!h) continue;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.lineTo(h[0], h[1]);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(h[0], h[1], r, 0, 2 * Math.PI);
          ctx.fillStyle = SELECTION;
          ctx.fill();
        }
        ctx.fillStyle = on ? SELECTION : "#FFFFFF";
        ctx.fillRect(ax - r, ay - r, 2 * r, 2 * r);
        ctx.strokeRect(ax - r, ay - r, 2 * r, 2 * r);
      }
    }
    return true;
  },
};
