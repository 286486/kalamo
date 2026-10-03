import {
  applyTo,
  type BareAnchor,
  type Document,
  fidelityTolerance,
  fitInk,
  formatPath,
  fromAnchors,
  invert,
  type Node,
  type PathEditInput,
  toAnchors,
  worldTransform,
} from "@kalamo/core";
import { cancelDrag } from "./canvas.ts";
import { anchorKey, anchorsOf, hasAnchors, localAnchors, nearestSegment } from "./direct.ts";
import { editable } from "./selection.ts";
import { getItem } from "./storage.ts";
import { afterReverse, send, useStore } from "./store.ts";
import { constrain, near, pathD, sendNewArt } from "./tools.ts";

/** The Pencil (research 06 §3): Ink fitted on release, as one `create` or one `path_edit`. */

type Point = [number, number];
/** A cubic from p0 to p3; no Handles is a line. */
type Seg = [Point, Point | null, Point | null, Point];

/** Pencil Tool Options: per browser, not Document state. Distances are in screen px. */
export interface PencilOptions {
  /** 0 Accurate to 100 Smooth, in five stops. */
  fidelity: number;
  fillNew: boolean;
  keepSelected: boolean;
  close: boolean;
  closeWithin: number;
  editSelected: boolean;
  editWithin: number;
}

/** Illustrator's defaults (research 06 §3). */
export const DEFAULT_PENCIL: PencilOptions = {
  fidelity: 50,
  fillNew: false,
  keepSelected: true,
  close: true,
  closeWithin: 15,
  editSelected: true,
  editWithin: 12,
};

const KEY = "kalamo:pencil" as const;
/** Set once saved, so a blocked storage still keeps them for the page. */
let saved: PencilOptions | null = null;

/** The saved options, read once per page; a stored value of the wrong type is its default. */
export function pencilOptions(): PencilOptions {
  if (saved) return saved;
  let stored: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(getItem(KEY) ?? "{}");
    if (value && typeof value === "object") stored = value as Record<string, unknown>;
  } catch {
    // Storage blocked or garbled: the defaults.
  }
  saved = Object.fromEntries(
    Object.entries(DEFAULT_PENCIL).map(([k, v]) => {
      const got = stored[k];
      const ok = typeof got === typeof v && (typeof got !== "number" || Number.isFinite(got));
      return [k, ok ? got : v];
    }),
  ) as unknown as PencilOptions;
  return saved;
}

/** The Fill new Pencil paths get: the current one only if Fill new pencil strokes is on. */
export const pencilFill = (fill: string | null) => (pencilOptions().fillNew ? fill : null);

export function savePencilOptions(o: PencilOptions) {
  try {
    localStorage.setItem(KEY, JSON.stringify(o));
  } catch {
    // Storage blocked: the options last for this page only.
  }
  saved = o;
}

const lerp = (a: Point, b: Point, t: number): Point => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];
const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** de Casteljau: the cubic's two halves at t. */
function split([p0, c1, c2, p3]: Seg, t: number): [Seg, Seg] {
  if (!c1 && !c2) {
    const m = lerp(p0, p3, t);
    return [
      [p0, null, null, m],
      [m, null, null, p3],
    ];
  }
  const [h1, h2] = [c1 ?? p0, c2 ?? p3];
  const [ab, bc, cd] = [lerp(p0, h1, t), lerp(h1, h2, t), lerp(h2, p3, t)];
  const [abc, bcd] = [lerp(ab, bc, t), lerp(bc, cd, t)];
  const m = lerp(abc, bcd, t);
  return [
    [p0, ab, abc, m],
    [m, bcd, cd, p3],
  ];
}

const segsOf = ({ closed, anchors }: { closed: boolean; anchors: BareAnchor[] }): Seg[] =>
  (closed ? anchors : anchors.slice(0, -1)).map((a, i) => {
    const b = anchors[(i + 1) % anchors.length] as BareAnchor;
    return [a.anchor, a.handleOut, b.handleIn, b.anchor];
  });

const reverse = (segs: Seg[]): Seg[] => segs.map(([a, b, c, d]): Seg => [d, c, b, a]).reverse();

/** The segments from u0 to u1, where segment k's t is at k + t; a closed subpath's u1 may wrap. */
function piece(segs: Seg[], u0: number, u1: number): Seg[] {
  const n = segs.length;
  const out: Seg[] = [];
  for (let k = Math.floor(u0); k < u1; k++) {
    const [a, b] = [Math.max(u0 - k, 0), Math.min(u1 - k, 1)];
    if (b - a < 1e-9) continue;
    let s = segs[k % n] as Seg;
    if (b < 1) s = split(s, b)[0];
    if (a > 0) s = split(s, a / b)[1];
    out.push(s);
  }
  return out;
}

/** The point at u, round a closed subpath. */
function pointAt(segs: Seg[], u: number, closed: boolean): Point {
  const n = segs.length;
  const v = closed ? ((u % n) + n) % n : Math.max(0, Math.min(n, u));
  const k = Math.min(Math.floor(v), n - 1);
  const t = v - k;
  return t <= 0 ? (segs[k] as Seg)[0] : split(segs[k] as Seg, t)[0][3];
}

/**
 * Where a nearestSegment hit is, as piece counts it. It reads a line as a cubic with its Handles on
 * its ends, whose t runs along it as 3t² − 2t³.
 */
function param(segs: Seg[], { segment, t }: { segment: number; t: number }) {
  const [, c1, c2] = segs[segment] as Seg;
  return segment + (c1 || c2 ? t : 3 * t * t - 2 * t * t * t);
}

/** Segments joined end to start as one subpath; a closed one's last end is its first Anchor. */
function toSubpath(segs: Seg[], closed: boolean) {
  const [first] = segs;
  if (!first) return null;
  const anchors: BareAnchor[] = [{ anchor: first[0], handleIn: null, handleOut: null }];
  for (const [, c1, c2, p3] of segs) {
    (anchors.at(-1) as BareAnchor).handleOut = c1;
    anchors.push({ anchor: p3, handleIn: c2, handleOut: null });
  }
  if (closed && anchors.length > 2) {
    const last = anchors.pop() as BareAnchor;
    (anchors[0] as BareAnchor).handleIn = last.handleIn;
  }
  return { closed: closed && anchors.length > 1, anchors };
}

/** The Ink fitted as one open run of segments. */
function fitted(ink: Point[], tolerance: number): Seg[] {
  const [sub] = toAnchors(fitInk(ink, tolerance, { closed: false }));
  return sub ? segsOf(sub) : [];
}

const distinct = (ink: Point[]) => ink.some((p) => dist(p, ink[0] as Point) > 1e-9);

/**
 * Ink that starts within `reach` of a selected path edits the nearest: from an open subpath's
 * Endpoint it extends it, closing it when it ends within `closeWithin` of the other Endpoint; from
 * elsewhere on it, it redraws the part it runs along, up to where it comes back within `reach`, or
 * to the end it heads for. All in document coordinates; null when it starts on no selected path,
 * or never leaves `reach` of where it started on one, which would cut the path at a wiggle.
 */
export function pencilEdit(
  doc: Document,
  selection: string[],
  ink: Point[],
  tolerance: number,
  reach: number,
  closeWithin: number | null,
): PathEditInput | null {
  const start = ink[0] as Point;
  const end = ink.at(-1) as Point;
  const hits = selection.flatMap((nodeId) => {
    const n = doc.nodes.get(nodeId);
    if (!hasAnchors(n) || !editable(doc, n)) return [];
    const subpaths = anchorsOf(doc, n);
    const hit = nearestSegment(subpaths, ...start);
    return hit && hit.dist <= reach ? [{ nodeId, n, subpaths, hit }] : [];
  });
  const nearest = hits.sort((a, b) => a.hit.dist - b.hit.dist)[0];
  if (!nearest) return null;
  const { nodeId, n, subpaths, hit } = nearest;
  const sub = subpaths[hit.subpath] as (typeof subpaths)[number];
  const segs = segsOf(sub);
  const count = segs.length;
  const { closed } = sub;
  const at = (u: number) => pointAt(segs, u, closed);
  const first = (sub.anchors[0] as BareAnchor).anchor;
  const last = (sub.anchors.at(-1) as BareAnchor).anchor;
  let uA = param(segs, hit);
  // The nearer Endpoint within reach.
  const [toFirst, toLast] = [dist(start, first), dist(start, last)];
  if (!closed && Math.min(toFirst, toLast) <= reach) uA = toLast <= toFirst ? count : 0;
  const extend = !closed && (uA === 0 || uA === count);
  if (!distinct([at(uA), ...ink.slice(1)])) return null;
  if (!extend && ink.every((p) => dist(p, start) <= reach)) return null;
  // The Ink from the path, to `to` if it ends on it.
  const run = (to: Point | null) => fitted([at(uA), ...ink.slice(1, -1), to ?? end], tolerance);

  let result: Seg[];
  let shut = closed;
  if (extend) {
    const other = uA === 0 ? last : first;
    shut = closeWithin !== null && ink.length > 2 && near(end, other, closeWithin);
    const tail = run(shut ? other : null);
    // Closing from the first Endpoint runs the Ink backwards from the last.
    if (uA === count) result = [...segs, ...tail];
    else result = shut ? [...segs, ...reverse(tail)] : [...reverse(tail), ...segs];
  } else {
    const back = nearestSegment([sub], ...end);
    const uB = back && back.dist <= reach && ink.length > 2 ? param(segs, back) : null;
    // Which way along the path the Ink heads from its start.
    const ahead = ink.find((p) => dist(p, start) >= reach) ?? end;
    const [p, q] = [at(uA - 1e-3), at(uA + 1e-3)];
    const forward =
      (q[0] - p[0]) * (ahead[0] - start[0]) + (q[1] - p[1]) * (ahead[1] - start[1]) >= 0;
    const tail = run(uB === null ? null : at(uB));
    if (closed && uB !== null) {
      result = forward
        ? [...tail, ...piece(segs, uB, uA < uB ? uA + count : uA)]
        : [...piece(segs, uA, uB < uA ? uB + count : uB), ...reverse(tail)];
    } else if (closed) {
      shut = false;
      const around = piece(segs, uA, uA + count);
      result = forward ? [...around, ...tail] : [...reverse(tail), ...around];
    } else if (uB !== null) {
      result =
        uB >= uA
          ? [...piece(segs, 0, uA), ...tail, ...piece(segs, uB, count)]
          : [...piece(segs, 0, uB), ...reverse(tail), ...piece(segs, uA, count)];
    } else {
      result = forward
        ? [...piece(segs, 0, uA), ...tail]
        : [...reverse(tail), ...piece(segs, uA, count)];
    }
  }
  const redrawn = toSubpath(result, shut);
  if (!redrawn) return null;
  // Back into the path's own coordinates; its other subpaths stay as they are.
  const m = invert(worldTransform(doc, n));
  const local = (p: Point | null) => p && applyTo(m, p[0], p[1]);
  const anchors = redrawn.anchors.map((a) => ({
    anchor: applyTo(m, ...a.anchor),
    handleIn: local(a.handleIn),
    handleOut: local(a.handleOut),
  }));
  const all: { closed: boolean; anchors: BareAnchor[] }[] = localAnchors(n);
  all[hit.subpath] = { closed: redrawn.closed, anchors };
  return { nodeId, ops: [{ op: "set_d", d: formatPath(fromAnchors(all)) }] };
}

/**
 * The finished drag's Ink, at the zoom `scale`: its tolerance and distances are in screen px, as
 * Illustrator's are. Ink starting on a selected path edits it; any other becomes a new path,
 * closed when its ends are within the close distance.
 */
export function pencilResult(
  doc: Document,
  selection: string[],
  ink: Point[],
  o: PencilOptions,
  scale: number,
): { edit: PathEditInput } | { path: { anchors: BareAnchor[]; closed: boolean } } | null {
  if (!distinct(ink) && !o.editSelected) return null;
  const tolerance = fidelityTolerance(o.fidelity) / scale;
  const closeWithin = o.close ? o.closeWithin / scale : null;
  if (o.editSelected) {
    const edit = pencilEdit(doc, selection, ink, tolerance, o.editWithin / scale, closeWithin);
    if (edit) return { edit };
  }
  if (!distinct(ink)) return null;
  const shut =
    closeWithin !== null &&
    ink.length > 3 &&
    near(ink[0] as Point, ink.at(-1) as Point, closeWithin);
  // Ending the Ink on its first point closes the fit (ADR-0033).
  const [sub] = toAnchors(
    fitInk(shut ? [...ink, ink[0] as Point] : ink, tolerance, { closed: shut }),
  );
  return sub ? { path: { anchors: sub.anchors, closed: sub.closed } } : null;
}

/**
 * Why a held redraw sent nothing: another Actor's edit to its path, or the person's own edit in the
 * window that took the path off the Ink.
 */
const DROPPED =
  "The Pencil edit was not applied; its path changed before Reverse Path Direction was answered.";

/** The Ink of the drag in progress, in document coordinates, and where a straight segment starts. */
let ink: Point[] | null = null;
let straight: { from: Point; kept: number } | null = null;

export const pencilInk = () => ink;

export function pencilDown(p: Point) {
  ink = [p];
  straight = null;
}

/**
 * The pointer moved through `points`. Alt draws a straight segment from where it was pressed, and
 * Shift one at 0, 45 or 90°; releasing it goes on freehand from the segment's end.
 */
export function pencilMove(points: Point[], mods: { shift: boolean; alt: boolean }) {
  const p = points.at(-1);
  if (!ink || !p) return;
  if (mods.alt || mods.shift) {
    straight ??= { from: ink.at(-1) as Point, kept: ink.length };
    ink = [...ink.slice(0, straight.kept), mods.shift ? constrain(straight.from, p) : p];
  } else {
    straight = null;
    ink.push(...points);
  }
}

export function pencilCancel() {
  ink = null;
  straight = null;
}

/**
 * Releasing: the Ink as one `path_edit` on the path it started on, or one `create` in the
 * current Stroke, with the current Fill only if Fill new pencil strokes is on.
 */
export function pencilUp(scale: number) {
  const done = ink;
  pencilCancel();
  const s = useStore.getState();
  if (!done || !s.doc) return;
  const o = pencilOptions();
  const r = pencilResult(s.doc, s.selection, done, o, scale);
  if (!r) return;
  if ("edit" in r) {
    useStore.setState({ edit: { inputs: [r.edit], commandIds: null } });
    // Worked out again from the Ink once a Reverse Path Direction press in flight is answered, on
    // the Document then, so it redraws the stretch drawn over (ADR-0110). It redraws the path it
    // was drawn over, whatever the Selection is then, and keeps the Ink in that path's own
    // coordinates, so the person's Selection tool move sent meanwhile carries the Ink with the path,
    // as Illustrator, which redraws before it moves, would (#284). It holds the key of the path's
    // first Anchor only so that another Actor's edit to the path, which clears it, drops the redraw
    // (ADR-0109); which Anchor does not matter.
    const { nodeId } = r.edit;
    const frame = (doc: Document) => worldTransform(doc, doc.nodes.get(nodeId) as Node);
    const m = invert(frame(s.doc));
    const own = done.map((p) => applyTo(m, ...p));
    afterReverse(
      ({ doc: now, anchors }, w) => {
        if (!now || anchors.length === 0) {
          cancelDrag();
          if (now) useStore.setState({ notice: DROPPED });
          return;
        }
        const f = frame(now);
        const at = own.map((p) => applyTo(f, ...p));
        const again = pencilResult(now, [nodeId], at, o, scale);
        if (!again || !("edit" in again)) {
          cancelDrag();
          useStore.setState({ notice: DROPPED });
          return;
        }
        const commandIds = [send({ type: "path_edit", input: again.edit }, w)];
        useStore.setState({ edit: { inputs: [again.edit], commandIds } });
      },
      { anchors: [anchorKey(nodeId, 0, 0)], segments: [], previewed: true },
    );
    return;
  }
  sendNewArt([{ type: "path", d: pathD(r.path.anchors, r.path.closed) }], {
    fillStroke: { ...s.fillStroke, fill: pencilFill(s.fillStroke.fill) },
    select: o.keepSelected,
  });
}
