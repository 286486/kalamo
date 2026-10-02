import type { Document, PathEditInput } from "@kalamo/core";
import { cancelDrag, commitDrag, dragged, type Press } from "./canvas.ts";
import {
  anchorKey,
  anchorsOf,
  bendSegment,
  hasAnchors,
  localAnchors,
  localDelta,
  moveHandle,
  nearestSegment,
  parseKey,
  pick,
  plus,
  removeAnchorInputs,
  sameTarget,
  type Target,
} from "./direct.ts";
import { directTool } from "./directTool.ts";
import { editable } from "./selection.ts";
import { afterReverse, send, useStore, type Waited } from "./store.ts";
import type { CanvasTool, ToolEvent } from "./toolbox.ts";

/** The Add, Delete and Anchor Point tools (research 06 §1), and the Pen's Auto Add/Delete. */

type Point = [number, number];

/** One `path_edit` per path and one `delete`, for edits on Anchors, which drop the selected Anchors and segments. */
export function sendAnchorEdits(
  { edits, deleteIds }: ReturnType<typeof removeAnchorInputs>,
  w: Waited,
) {
  for (const input of edits) send({ type: "path_edit", input }, w);
  if (deleteIds.length > 0) send({ type: "delete", nodeIds: deleteIds });
  useStore.setState({ anchors: [], segments: [] });
}

/** The nearest segment of the paths `ids` within `tolerance`, as pick names one. */
function nearestOf(doc: Document, ids: string[], p: Point, tolerance: number) {
  let best: (Extract<Target, { kind: "segment" }> & { dist: number }) | null = null;
  for (const nodeId of ids) {
    const n = doc.nodes.get(nodeId);
    if (!hasAnchors(n) || !editable(doc, n)) continue;
    const hit = nearestSegment(anchorsOf(doc, n), ...p);
    if (hit && hit.dist <= tolerance && (!best || hit.dist < best.dist)) {
      best = { kind: "segment", nodeId, ...hit };
    }
  }
  return best;
}

/**
 * A click with the Add Anchor Point tool: an Anchor on the topmost segment within `tolerance`,
 * keeping its shape; `only` limits it to those paths. False when it hit no segment.
 */
export function addAnchorAt(doc: Document, p: Point, tolerance: number, only?: string[]): boolean {
  const scope = useStore.getState().isolated;
  const hit = only
    ? nearestOf(doc, only, p, tolerance)
    : pick(doc, { selection: [], anchors: [], x: p[0], y: p[1], tolerance, scope });
  if (hit?.kind !== "segment") return false;
  const { nodeId, subpath, segment } = hit;
  const n = doc.nodes.get(nodeId);
  const s = hasAnchors(n) ? localAnchors(n)[subpath] : undefined;
  const a = s?.anchors[segment];
  const b = s?.anchors[(segment + 1) % s.anchors.length];
  // nearestSegment reads a line as a cubic with its Handles on its ends; add_anchor's t on a line
  // runs along it.
  const line = !a?.handleOut && !b?.handleIn;
  const t = line ? 3 * hit.t ** 2 - 2 * hit.t ** 3 : hit.t;
  if (t <= 0 || t >= 1) return false;
  // Sent once a Reverse Path Direction press in flight is answered, on the segment chosen
  // (ADR-0110); another Actor's edit to the path meanwhile drops it (ADR-0109).
  const key = anchorKey(nodeId, subpath, segment);
  afterReverse(
    ({ doc: now, segments }, w) => {
      if (!now || segments.length === 0) return;
      const at = sameTarget({ ...hit, t }, doc, now);
      const ops = [{ op: "add_anchor" as const, subpath, segment: at.segment, t: at.t }];
      sendAnchorEdits({ edits: [{ nodeId, ops }], deleteIds: [] }, w);
    },
    { anchors: [], segments: [key] },
  );
  return true;
}

/**
 * A click with the Delete Anchor Point tool: removes the Anchor within `tolerance`, joining its
 * neighbours; `only` limits it to those paths. False when it hit no Anchor.
 */
export function deleteAnchorAt(
  doc: Document,
  p: Point,
  tolerance: number,
  only?: string[],
): boolean {
  const hit = pick(doc, {
    selection: only ?? [],
    anchors: [],
    x: p[0],
    y: p[1],
    tolerance,
    scope: useStore.getState().isolated,
  });
  if (hit?.kind !== "anchor" || (only && !only.includes(parseKey(hit.key).nodeId))) return false;
  // The key is renumbered as the Direct Selection's are until a press in flight is answered.
  afterReverse(
    ({ doc: now, anchors }, w) => {
      if (now && anchors.length > 0) sendAnchorEdits(removeAnchorInputs(now, anchors), w);
    },
    { anchors: [hit.key], segments: [] },
  );
  return true;
}

const drawSelected = directTool.drawSelected;

/** Alt toggles between the Add and Delete Anchor Point tools. */
const clickTool = (add: boolean) => (e: ToolEvent) => {
  const tolerance = 3 / e.viewport.scale;
  useStore.setState({ notice: null });
  if (add !== e.alt) addAnchorAt(e.doc, [e.x, e.y], tolerance);
  else deleteAnchorAt(e.doc, [e.x, e.y], tolerance);
};

export const addAnchorTool: CanvasTool = {
  title: "Add Anchor Point Tool",
  shortcut: "+",
  group: "pen",
  icon: "M8 1 L12 8 L10 14 H6 L4 8 Z M8 1 V8 M11 2 H15 M13 0 V4",
  cursor: "crosshair",
  down: clickTool(true),
  drawSelected,
};

export const deleteAnchorTool: CanvasTool = {
  title: "Delete Anchor Point Tool",
  shortcut: "-",
  group: "pen",
  icon: "M8 1 L12 8 L10 14 H6 L4 8 Z M8 1 V8 M11 2 H15",
  cursor: "crosshair",
  down: clickTool(false),
  drawSelected,
};

/**
 * An Anchor Point tool press: on an Anchor, a Handle it shows, or a segment, as `from` numbers it;
 * `last` is its latest move.
 */
let gesture: (Press & Target & { from: Document; last?: { d: Point; shift: boolean } }) | null =
  null;

/** What `t` holds, as Direct Selection keys, which a press's answer renumbers (ADR-0110). */
const keysOf = (t: Target) =>
  t.kind === "segment"
    ? { anchors: [], segments: [anchorKey(t.nodeId, t.subpath, t.segment)] }
    : { anchors: [t.key], segments: [] };

/** The edit dragging `t` by `d` in document coordinates makes on `doc`. */
function dragInput(doc: Document, t: Target, [dx, dy]: Point, shift: boolean) {
  if (t.kind === "anchor") return pullHandles(doc, t.key, dx, dy);
  if (t.kind === "handle") return moveHandle(doc, t.key, t.which, dx, dy, true);
  return bendSegment(doc, t.nodeId, t.subpath, t.segment, t.t, dx, dy, shift);
}

/** The edit a click on `t` makes on `doc`: an Anchor's Handles or a Handle retracted. */
function clickInput(doc: Document, t: Target): PathEditInput | null {
  if (t.kind === "segment") return null;
  const { nodeId, subpath, index } = parseKey(t.key);
  const n = doc.nodes.get(nodeId);
  const a = hasAnchors(n) ? localAnchors(n)[subpath]?.anchors[index] : undefined;
  if (t.kind === "anchor" ? !a?.handleIn && !a?.handleOut : !a?.[t.which]) return null;
  return {
    nodeId,
    ops: [
      t.kind === "anchor"
        ? { op: "set_point_type", subpath, index, type: "corner" }
        : { op: "set_handles", subpath, index, [t.which]: null },
    ],
  };
}

/**
 * Dragging out of the Anchor `key` by (dx, dy) in document coordinates: Smooth, its outgoing
 * Handle at the pointer and the incoming one mirrored, as the Pen places one. An open subpath's
 * Endpoint has one Handle, which follows the pointer.
 */
export function pullHandles(
  doc: Document,
  key: string,
  dx: number,
  dy: number,
): PathEditInput | null {
  const { nodeId, subpath, index } = parseKey(key);
  const n = doc.nodes.get(nodeId);
  const s = hasAnchors(n) ? localAnchors(n)[subpath] : undefined;
  const a = s?.anchors[index];
  if (!n || !s || !a || s.anchors.length < 2) return null;
  const d = localDelta(doc, n, dx, dy);
  const out = plus(a.anchor, d);
  const back = plus(a.anchor, [-d[0], -d[1]]);
  const open = !s.closed;
  const last = open && index === s.anchors.length - 1;
  const handleIn = open && index === 0 ? {} : { handleIn: last ? out : back };
  const handleOut = last ? {} : { handleOut: out };
  return { nodeId, ops: [{ op: "set_handles", subpath, index, ...handleIn, ...handleOut }] };
}

/**
 * Anchor Point (Shift+C): clicking an Anchor retracts its Handles, making it Corner; dragging out
 * of one pulls out Smooth Handles; dragging a selected Anchor's Handle moves it alone, breaking
 * the pair, and clicking its end retracts it; dragging a segment bends it, Shift into a semicircle.
 */
export const anchorPointTool: CanvasTool = {
  title: "Anchor Point Tool",
  shortcut: "Shift+C",
  group: "pen",
  icon: "M2 13 L8 3 L14 13 M5 3 H11",
  cursor: "default",
  down(e) {
    const { selection, anchors, segments, isolated } = useStore.getState();
    useStore.setState({ notice: null });
    const tolerance = 3 / e.viewport.scale;
    const target = pick(e.doc, {
      selection,
      anchors,
      segments,
      x: e.x,
      y: e.y,
      tolerance,
      scope: isolated,
    });
    if (!target) return;
    e.capture();
    const g = { start: { x: e.x, y: e.y }, moved: false, from: e.doc };
    gesture = { ...g, ...target };
    // Its Handles show while they are pulled out, as Direct Selection shows a selected Anchor's
    // or segment's.
    if (target.kind === "anchor") {
      const { nodeId } = parseKey(target.key);
      useStore.setState({ selection: [nodeId], anchors: [target.key], segments: [] });
    } else if (target.kind === "segment") {
      const key = anchorKey(target.nodeId, target.subpath, target.segment);
      useStore.setState({ selection: [target.nodeId], anchors: [], segments: [key] });
    }
  },
  move(e) {
    const g = gesture;
    const d = g && dragged(g, e);
    if (!g || !d) return;
    g.last = { d, shift: e.shift };
    // A press answered mid-drag keeps the drag on what it grabbed (ADR-0110).
    const input = dragInput(e.doc, sameTarget(g, g.from, e.doc), d, e.shift);
    useStore.setState({ edit: input && { inputs: [input], commandIds: null } });
  },
  up() {
    const g = gesture;
    gesture = null;
    if (!g) return;
    // Sent once a Reverse Path Direction press in flight is answered, from the Document then, on
    // what the gesture grabbed (ADR-0110); another Actor's edit to its path meanwhile drops it
    // (ADR-0109).
    const { last } = g;
    const keys = keysOf(g);
    afterReverse(({ doc: now, anchors, segments }, w) => {
      const t = now && anchors.length + segments.length > 0 ? sameTarget(g, g.from, now) : null;
      const input = now && t && (last ? dragInput(now, t, last.d, last.shift) : clickInput(now, t));
      if (!input) {
        if (last) cancelDrag();
        return;
      }
      if (last) {
        useStore.setState({ edit: { inputs: [input], commandIds: null } });
        commitDrag(w);
        return;
      }
      const commandIds = [send({ type: "path_edit", input }, w)];
      useStore.setState({ edit: { inputs: [input], commandIds } });
    }, keys);
  },
  cancel(redraw) {
    gesture = null;
    cancelDrag();
    redraw();
  },
  drawSelected,
};
