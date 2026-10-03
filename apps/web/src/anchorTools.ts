import type { Document, PathEditInput } from "@kalamo/core";
import { cancelDrag, dragged, type Press, sendPreview } from "./canvas.ts";
import {
  alongLine,
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
  type Renumbering,
  removeAnchorInputs,
  type Target,
  targetKeys,
  targetNode,
} from "./direct.ts";
import { directTool } from "./directTool.ts";
import { editable } from "./selection.ts";
import { afterReverse, renumbers, send, useStore, type Waited } from "./store.ts";
import type { CanvasTool, ToolEvent } from "./toolbox.ts";

/** The Add, Delete and Anchor Point tools (research 06 §1), and the Pen's Auto Add/Delete. */

type Point = [number, number];

/**
 * One `path_edit` per path and one `delete`, for edits on Anchors, which drop the selected Anchors
 * and segments. `known` says how a `set_d` renumbers its path, which its answer renumbers the keys
 * by (#298).
 */
export function sendAnchorEdits(
  {
    edits,
    deleteIds,
    known = [],
  }: ReturnType<typeof removeAnchorInputs> & { known?: Renumbering[] },
  w: Waited,
) {
  for (const input of edits) {
    const id = send({ type: "path_edit", input }, w);
    const r = known.find((k) => k.nodeId === input.nodeId);
    if (r) renumbers(id, r);
  }
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
  if (hit?.kind !== "segment" || hit.t <= 0 || hit.t >= 1) return false;
  const { nodeId, subpath, segment, t } = hit;
  // Sent once a Reverse Path Direction press in flight is answered, on the segment chosen
  // (ADR-0110); another Actor's edit to the path meanwhile drops it (ADR-0109). The target's `t` is
  // nearestSegment's, as every target's is, so the answer to the person's own Add Anchor click
  // that splits the segment puts it on the half clicked (#298).
  afterReverse(
    ({ doc: now, target: at }, w) => {
      const n = now?.nodes.get(nodeId);
      const s = hasAnchors(n) && at?.kind === "segment" ? localAnchors(n)[at.subpath] : undefined;
      if (!s || at?.kind !== "segment") return;
      const a = s.anchors[at.segment];
      const b = s.anchors[(at.segment + 1) % s.anchors.length];
      const along = !a?.handleOut && !b?.handleIn ? alongLine(at.t) : at.t;
      const ops = [
        { op: "add_anchor" as const, subpath: at.subpath, segment: at.segment, t: along },
      ];
      sendAnchorEdits({ edits: [{ nodeId, ops }], deleteIds: [] }, w);
    },
    { target: { kind: "segment", nodeId, subpath, segment, t } },
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
  // Sent once a Reverse Path Direction press in flight is answered, on the Anchor chosen, which the
  // answer renumbers (ADR-0110); another Actor's edit to the path meanwhile drops it (ADR-0109).
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
 * An Anchor Point tool press: on an Anchor, a Handle it shows, or a segment, which the store keeps
 * as `grabbed` (ADR-0110); `last` is its latest move.
 */
let gesture: (Press & { last?: { d: Point; shift: boolean } }) | null = null;

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
    gesture = { start: { x: e.x, y: e.y }, moved: false };
    useStore.setState({ grabbed: [target] });
    // Its Handles show while they are pulled out, as Direct Selection shows a selected Anchor's
    // or segment's.
    if (target.kind !== "handle") {
      useStore.setState({ selection: [targetNode(target)], ...targetKeys(target) });
    }
  },
  move(e) {
    const g = gesture;
    const d = g && dragged(g, e);
    if (!g || !d) return;
    const [t] = useStore.getState().grabbed;
    if (!t) return;
    g.last = { d, shift: e.shift };
    const input = dragInput(e.doc, t, d, e.shift);
    useStore.setState({ edit: input && { inputs: [input], commandIds: null } });
  },
  up() {
    const g = gesture;
    gesture = null;
    const [grabbed] = useStore.getState().grabbed;
    useStore.setState({ grabbed: [] });
    if (!g || !grabbed) return;
    // Sent once a Reverse Path Direction press in flight is answered, from the Document then, on
    // what the gesture grabbed (ADR-0110); another Actor's edit to its path meanwhile drops it
    // (ADR-0109).
    const { last } = g;
    afterReverse(
      ({ doc: now, target: t }, w) => {
        const input =
          now && t && (last ? dragInput(now, t, last.d, last.shift) : clickInput(now, t));
        if (input) sendPreview({ edit: { inputs: [input], commandIds: null } }, w);
      },
      { target: grabbed, previewed: true },
    );
  },
  cancel(redraw) {
    gesture = null;
    useStore.setState({ grabbed: [] });
    cancelDrag();
    redraw();
  },
  drawSelected,
};
