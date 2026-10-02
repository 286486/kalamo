import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import type { z } from "zod";
import {
  assertParent,
  bounds,
  checkFile,
  childrenOf,
  imageInfo,
  isTopLayer,
  mapPaint,
  newId,
  paint,
  paintContainer,
  paintOrder,
  union,
  unmasked,
} from "./document.ts";
import { collect, type Failed, KalamoError } from "./errors.ts";
import { type Orientation, orientedImage, preserveAspectRatio } from "./image.ts";
import { compose, multiply, round, scaleOf } from "./matrix.ts";
import { formatPath, parsePath } from "./path.ts";
import {
  AppearanceInput,
  ContainerAppearanceInput,
  type Document,
  DuplicateInput,
  type GroupNode,
  ImageShape,
  type LayerNode,
  LayerTemplate,
  type LeafNode,
  type Node,
  OpacityMask,
  PIVOTS,
  type Rect,
  type ReorderOp,
  type ReparentInput,
  SHAPES,
  TextShape,
  type TransformInput,
  TransformNodesInput,
  textRanges,
  type UpdateInput,
  type Warning,
  Writable,
} from "./schema.ts";
import { refuseMisplacedAutoSize, storedText } from "./stored-text.ts";
import { areaFrame, pointType } from "./text.ts";

const isContainer = (n: Node): n is LayerNode | GroupNode =>
  n.type === "layer" || n.type === "group";

/** The Node and everything beneath it, depth first. */
export function subtree(doc: Document, node: Node): Node[] {
  return [node, ...childrenOf(doc, node.id).flatMap((c) => subtree(doc, c))];
}

export function lookup(doc: Document, id: string, path: string): Node {
  const node = doc.nodes.get(id);
  if (node) return node;
  throw new KalamoError({
    code: "NODE_NOT_FOUND",
    message: `No Node with id ${id}.`,
    hint: "Use doc_outline or the ids from a WriteReceipt; deleted Nodes do not come back.",
    path,
  });
}

/**
 * The Node and everything beneath it that a transform of it moves, depth first: an unlinked mask
 * stays where it is (ADR-0103).
 */
function moving(doc: Document, node: Node): Node[] {
  const stays = (c: Node) => "opacityMask" in c && c.opacityMask?.link === false;
  return [node, ...childrenOf(doc, node.id).flatMap((c) => (stays(c) ? [] : moving(doc, c)))];
}

/** Drops targets that sit inside another target, so nothing is edited twice. */
export function outermost(doc: Document, targets: Node[]): { kept: Node[]; nested: Node[] } {
  const ids = new Set(targets.map((n) => n.id));
  const inside = (n: Node) => {
    for (let p = n.parentId; p; p = doc.nodes.get(p)?.parentId ?? null) {
      if (ids.has(p)) return true;
    }
    return false;
  };
  const kept: Node[] = [];
  const nested: Node[] = [];
  for (const n of new Set(targets)) (inside(n) ? nested : kept).push(n);
  return { kept, nested };
}

function pivotOf(pivot: z.output<typeof TransformInput>["pivot"], b: Rect | null) {
  if (typeof pivot === "object") return pivot;
  if (!b) return null;
  const [fx, fy] = PIVOTS[pivot];
  return { x: b.x + b.width * fx, y: b.y + b.height * fy };
}

type Transformed = { nodes: Node[]; warnings: Warning[]; failed: Failed[] };

/**
 * Composes the transform into every leaf beneath the targets; Layers and Groups stay identity
 * (ADR-0007), whose Strokes scale instead (ADR-0043). Returns the changed containers, then the
 * changed leaves depth first in target order.
 *
 * `transforms` apply in order, each to the Document the ones before it left, so its pivot comes
 * from the bounds they made; `partial` then skips a failing entry whole (ADR-0070). A Node changed
 * twice is returned once, with its final value, where it first appeared.
 */
export function transformNodes(
  doc: Document,
  raw: TransformNodesInput,
  { partial = false } = {},
): Transformed {
  const input = TransformNodesInput.parse(raw);
  if (!("transforms" in input)) return transformOnce(doc, input, partial);
  const staged = { ...doc, nodes: new Map(doc.nodes) };
  const warnings: Warning[] = [];
  const { ok, failed } = collect(input.transforms, partial, (entry, i) => {
    try {
      const done = transformOnce(staged, entry, false);
      warnings.push(...done.warnings);
      return done.nodes;
    } catch (e) {
      if (!(e instanceof KalamoError)) throw e;
      const at = `transforms[${i}]`;
      throw new KalamoError({ ...e.data, path: e.data.path ? `${at}.${e.data.path}` : at });
    }
  });
  const ids = new Set(ok.flat().map((n) => n.id));
  const nodes = [...ids].map((id) => staged.nodes.get(id) as Node);
  for (const n of nodes) doc.nodes.set(n.id, n);
  return { nodes, warnings, failed };
}

function transformOnce(
  doc: Document,
  input: z.output<typeof TransformInput>,
  partial: boolean,
): Transformed {
  const { ok: targets, failed } = collect(input.nodeIds, partial, (id, i) =>
    lookup(doc, id, `nodeIds[${i}]`),
  );
  const { kept, nested } = outermost(doc, targets);
  const warnings = nested.map((n) => ({
    code: "NESTED_TARGET",
    nodeId: n.id,
    message: "Also inside another target, so it moved once with that target.",
  }));
  const groups = input.each ? kept.map((n) => [n]) : [kept];
  const nodes: Node[] = [];
  for (const group of groups) {
    const pivot = pivotOf(input.pivot, union(group.map((n) => bounds(doc, n))));
    if (!pivot) continue;
    const m = compose(input, pivot);
    const k = scaleOf(m);
    const s = input.scaleStrokes ? 1 : k;
    const all = group.flatMap((n) => moving(doc, n));
    // A container has no matrix, so its gradients map through the transform and, with
    // scaleStrokes, its Stroke widths scale instead (ADR-0043).
    for (const c of all) {
      if (!isContainer(c) || !c.appearance) continue;
      const { fills, strokes } = c.appearance;
      const widths = input.scaleStrokes ? k : 1;
      const mapped = [...fills, ...strokes].some((p) => p.type === "gradient");
      if (!mapped && !(input.scaleStrokes && strokes.length > 0)) continue;
      const next = {
        ...c,
        appearance: {
          ...c.appearance,
          fills: fills.map((f) => mapPaint(f, m)),
          strokes: strokes.map((t) => ({
            ...mapPaint(t, m),
            width: t.width * widths,
            dash: t.dash.map((v) => v * widths),
          })),
        },
      };
      doc.nodes.set(c.id, next);
      nodes.push(next);
    }
    for (const leaf of all.filter((n) => !isContainer(n))) {
      const { appearance } = leaf as LeafNode;
      const next = {
        ...leaf,
        transform: round(multiply(m, leaf.transform)),
        ...(s !== 1 &&
          appearance && {
            appearance: {
              ...appearance,
              strokes: appearance.strokes.map((k) => ({
                ...k,
                width: k.width / s,
                dash: k.dash.map((v) => v / s),
              })),
            },
          }),
      } as Node;
      doc.nodes.set(leaf.id, next);
      nodes.push(next);
    }
  }
  return { nodes, warnings, failed };
}

/** Keys `node_update` never writes, with where to go instead. */
const READ_ONLY: Record<string, string> = {
  id: "Ids never change.",
  type: "A Node's type never changes; create a new Node and delete this one.",
  parentId: "Use node_reparent to move a Node to another Layer or Group.",
  index:
    "Use node_reorder (front / forward / backward / back) to restack a Node in its parent, or node_reparent with the same parentId and index, before or after to put it in an exact place.",
  transform: "Use node_transform to move, rotate, scale or skew.",
  childCount: "Derived from the tree; read-only.",
  geometricBounds: "Derived; move or resize the Node to change it.",
  visibleBounds: "Derived; move or resize the Node to change it.",
  worldTransform: "Derived; use node_transform.",
  closed: "Derived from d: end d with Z to close it.",
  clipping: "Use mask_make to make a Clipping Mask and mask_release to release one (ADR-0021).",
};

/** RFC 7396: objects merge recursively, null deletes, anything else (arrays too) replaces. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(patch)) return patch;
  const out = isObject(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}

export const zodPath = (path: PropertyKey[]) =>
  path.map((k) => (typeof k === "number" ? `[${k}]` : `.${String(k)}`)).join("");

function writableSchema(node: Node) {
  // A mask's Transparency panel options; making or releasing one goes through mask_make and
  // mask_release (ADR-0103).
  const mask = "opacityMask" in node && node.opacityMask ? { opacityMask: OpacityMask } : {};
  if (node.type === "layer" || node.type === "group") {
    return Writable.extend({
      appearance: ContainerAppearanceInput.optional(),
      ...(node.type === "layer" && { template: LayerTemplate.optional() }),
      ...mask,
    });
  }
  if (node.type === "image") {
    const { src, file, x, y, width, height, preserveAspectRatio } = ImageShape.shape;
    return Writable.extend({
      src,
      file,
      x,
      y,
      width: width.unwrap(),
      height: height.unwrap(),
      preserveAspectRatio,
      ...mask,
    });
  }
  if (node.type === "text") {
    // A text's kind converts before this schema applies (ADR-0079). Only Area Type has a frame
    // (ADR-0022); a shaped one's is path data, and `frame: null` makes it the rectangle of its bounds
    // (ADR-0078).
    const { type: _, kind: __, width, height, frame: shape, autoSize, ...text } = TextShape.shape;
    const frame =
      node.kind === "area"
        ? { width: width.unwrap(), height: height.unwrap(), frame: shape, autoSize }
        : {};
    return Writable.extend(text)
      .extend(frame)
      .extend({ appearance: AppearanceInput, ...mask })
      .superRefine(textRanges);
  }
  const { type: _, ...parameters } = SHAPES[node.type].shape;
  return Writable.extend(parameters).extend({ appearance: AppearanceInput, ...mask });
}

/**
 * Convert to Area Type or Point Type (ADR-0079): the text of the other kind that shows the same
 * lines, and a `TEXT_DISCARDED` warning for the overflow Point Type cannot hold.
 */
function converted(
  node: Extract<Node, { type: "text" }>,
  at: string,
): { node: Node; warnings: Warning[] } {
  if (node.kind === "point") {
    return { node: { ...node, kind: "area", ...areaFrame(node) }, warnings: [] };
  }
  const point = pointType(node);
  if (!point) {
    throw new KalamoError({
      code: "INVALID_PATCH",
      message: "No line of this Area Type shows, so Point Type would hold no text.",
      hint: "Enlarge the frame until a line shows, then convert.",
      path: `${at}.kind`,
    });
  }
  const { discarded, ...layout } = point;
  const warnings = discarded
    ? [
        {
          code: "TEXT_DISCARDED",
          nodeId: node.id,
          message: `${discarded} characters of overflow were deleted, as Illustrator's Convert to Point Type deletes them; undo restores them.`,
        },
      ]
    : [];
  const { width: _, height: __, frame: ___, autoSize: ____, ...text } = node;
  return { node: { ...text, kind: "point", ...layout }, warnings };
}

/** Validates and merges one patch, returning the new Node without storing it. */
function patched(
  doc: Document,
  raw: UpdateInput,
  i: number,
  orientation: Orientation = 1,
): { node: Node; warnings: Warning[] } {
  // Not parsed with NodePatch: the per-type schema below checks every value and answers with a hint.
  const { nodeId } = raw;
  let patch = raw.patch as Record<string, unknown>;
  let node = lookup(doc, nodeId, `updates[${i}].nodeId`);
  const at = `updates[${i}].patch`;
  const invalid = (key: string, message: string, hint: string) =>
    new KalamoError({ code: "INVALID_PATCH", message, hint, path: `${at}${key}` });
  let warnings: Warning[] = [];
  if (node.type === "text" && "kind" in patch) {
    const { kind, ...rest } = patch;
    patch = rest;
    if (kind !== "point" && kind !== "area") {
      throw invalid(".kind", "kind is point or area.", "Send the kind to convert the text to.");
    }
    // Whatever the kind is now, so the rule does not depend on the Node (#57).
    const layout = Object.keys(patch).find(
      (k) => k !== "type" && Object.hasOwn(TextShape.shape, k),
    );
    if (layout) {
      throw invalid(
        `.${layout}`,
        `${layout} cannot change in a patch with kind.`,
        "Convert first, with kind alone or with name, visible, locked, opacity, blendMode, appearance, tags or meta, then edit the layout in a second update.",
      );
    }
    if (kind !== node.kind) ({ node, warnings } = converted(node, at));
  }
  const schema = writableSchema(node);
  for (const key of Object.keys(patch)) {
    const readOnly =
      (Object.hasOwn(READ_ONLY, key) ? READ_ONLY[key] : undefined) ??
      (key === "d" && node.type === "text"
        ? "A text has no outline until Create Outlines; change content instead."
        : key === "d" && node.type !== "path"
          ? "A Live Shape's d is derived from its parameters; change those instead."
          : undefined);
    if (readOnly) throw invalid(`.${key}`, `${key} is read-only.`, readOnly);
    if (key === "opacityMask" && patch.opacityMask === null) {
      throw invalid(
        ".opacityMask",
        "opacityMask cannot be deleted.",
        "Use mask_release to release the Opacity Mask (ADR-0103).",
      );
    }
    if (key === "opacityMask" && !("opacityMask" in node && node.opacityMask)) {
      throw invalid(
        ".opacityMask",
        "The Node is not the mask of an Opacity Mask.",
        'Use mask_make with kind "opacity" to make one; then clip, invert and link can change here (ADR-0103).',
      );
    }
    if (key === "src" && patch.src === null && node.type === "image") {
      throw invalid(
        ".src",
        "An Image's src cannot be deleted.",
        "Send a data: URL or an image id to Relink; file: null Embeds a linked Image (ADR-0042).",
      );
    }
    const appearance = patch.appearance as { contents?: unknown } | null | undefined;
    if (key === "appearance" && appearance?.contents !== undefined && !isContainer(node)) {
      throw invalid(
        ".appearance.contents",
        `A ${node.type}'s Appearance has no contents.`,
        "contents places a Layer's or Group's children in its stack; a leaf paints its Fills, then its Strokes.",
      );
    }
    if (!Object.hasOwn(schema.shape, key)) {
      throw invalid(
        `.${key}`,
        `A ${node.type} has no ${key}.`,
        `A ${node.type} can write: ${Object.keys(schema.shape).join(", ")}.`,
      );
    }
  }
  if (node.type === "text" && node.kind === "area") {
    // A shaped frame's bounds are derived from it: reshape it through frame (ADR-0078).
    const shaped = patch.frame === undefined ? node.frame !== undefined : patch.frame !== null;
    const key = ["x", "y", "width", "height"].find((k) => k in patch);
    if (shaped && key) {
      throw invalid(
        `.${key}`,
        `${key} is the bounds of a shaped frame.`,
        "Write frame to reshape it, or frame: null first to make it the rectangle of its bounds.",
      );
    }
    // Auto Size fits the height; writing a height or a frame path turns it off (ADR-0092). false
    // is off too, merged as null so a shaped frame, which never has the key, takes it.
    if (patch.autoSize === true) {
      refuseMisplacedAutoSize(
        { kind: "area", frame: shaped ? (patch.frame ?? node.frame) : undefined, autoSize: true },
        at,
        "INVALID_PATCH",
      );
    }
    if (patch.autoSize === true && "height" in patch) {
      throw invalid(
        ".height",
        "autoSize: true fits the height to the lines.",
        "Drop height to keep Auto Size, or drop autoSize to fix the height.",
      );
    }
    if (
      patch.autoSize === false ||
      (patch.autoSize !== true && ("height" in patch || typeof patch.frame === "string"))
    ) {
      patch = { ...patch, autoSize: null };
    }
  }
  // Missing means false, so false is stored as missing, as node_create stores it (ADR-0099).
  if (node.type === "layer" && patch.template === false) patch = { ...patch, template: null };
  const merged = mergePatch(node, patch) as Record<string, unknown>;
  // Indices into the old content would style the wrong characters of the new one (ADR-0029).
  if ("content" in patch && !("ranges" in patch)) delete merged.ranges;
  const parsed = schema.safeParse(merged);
  if (!parsed.success) {
    const issue = parsed.error.issues[0] as z.core.$ZodIssue;
    const key = zodPath(issue.path);
    const deleted = issue.path.length === 1 && patch[issue.path[0] as string] === null;
    throw invalid(
      key,
      `${key.slice(1)}: ${issue.message}`,
      deleted
        ? `null deletes a key in a merge patch, and ${key.slice(1)} is required; send a value instead.`
        : issue.message,
    );
  }
  // From the merge, so null deletes an optional key such as leading.
  let next = { ...merged, ...parsed.data } as Node;
  if (next.type === "text") next = storedText(next, at, "INVALID_PATCH");
  // SVG clips everything away through a hidden clip path; Illustrator unclips (ADR-0021).
  if ("clipping" in next && next.clipping && !next.visible) {
    throw invalid(
      ".visible",
      "A Clipping Path cannot be hidden.",
      "Use mask_release to show the content unclipped, or hide the Clipping Mask's Group.",
    );
  }
  // SVG hides everything through a hidden mask (ADR-0103).
  if ("opacityMask" in next && next.opacityMask && !next.visible) {
    throw invalid(
      ".visible",
      "A mask cannot be hidden.",
      "Use mask_release to show the content unmasked, or hide the Opacity Mask's Group.",
    );
  }
  if (next.type === "image") {
    if (typeof patch.file === "string") checkFile(patch.file, `${at}.file`);
    if (typeof patch.src === "string") imageInfo(doc, patch.src, `${at}.src`);
    if (next.src === undefined && next.file === undefined) {
      throw new KalamoError({
        code: "INVALID_IMAGE",
        message: "A missing link has no pixels to Embed.",
        hint: "Set src to a data: URL or an image id in the same patch, or Relink it first.",
        path: `${at}.file`,
      });
    }
    next.preserveAspectRatio = preserveAspectRatio(next.preserveAspectRatio) ?? "none";
    // Relink to an oriented JPEG keeps the box the patch leaves, turning the new file into it; a
    // linked Image records the file's orientation, an image id's being unknown (ADR-0102).
    if (typeof patch.src === "string") {
      delete next.fileOrientation;
      if (orientation !== 1) {
        Object.assign(next, orientedImage(next, orientation));
        if (next.file !== undefined) next.fileOrientation = orientation;
      }
    }
    // Embed forgets it.
    if (next.file === undefined) delete next.fileOrientation;
  } else if (isContainer(next)) {
    if (next.appearance) {
      next.appearance = paintContainer(
        next.appearance as ContainerAppearanceInput,
        `${at}.appearance`,
        () => bounds(doc, next),
      );
    }
  } else {
    next.appearance = paint(next.appearance as AppearanceInput, `${at}.appearance`, next);
  }
  if (next.type === "path" && "d" in patch) next.d = formatPath(parsePath(next.d, `${at}.d`));
  return { node: next, warnings };
}

/**
 * Applies one merge patch per item, in order, so two patches to one Node both land. Validates every
 * item before storing any. `orientations` holds the EXIF orientation of a Relink's file read for
 * this write, under its update's path, e.g. `updates[0]` (ADR-0101).
 */
export function updateNodes(
  doc: Document,
  updates: UpdateInput[],
  {
    partial = false,
    orientations,
  }: { partial?: boolean; orientations?: ReadonlyMap<string, Orientation> } = {},
): { nodes: Node[]; warnings: Warning[]; failed: Failed[] } {
  const staged = { ...doc, nodes: new Map(doc.nodes) };
  const { ok, failed } = collect(updates, partial, (u, i) => {
    const done = patched(staged, u, i, orientations?.get(`updates[${i}]`));
    staged.nodes.set(done.node.id, done.node);
    return done;
  });
  // Two patches to one Node are one update: its final value, where it first appeared.
  const unique = [...new Map(ok.map(({ node: n }) => [n.id, n])).values()];
  for (const n of unique) doc.nodes.set(n.id, n);
  return { nodes: unique, warnings: ok.flatMap((d) => d.warnings), failed };
}

/**
 * Where `pos` puts a Node among `siblings`, the parent's children bottom first without `self`, the
 * Node being moved: it lands between siblings[slot - 1] and siblings[slot], by default on top. `at`
 * is the path of an input key; `what` names the input in a message.
 */
function slotOf(
  doc: Document,
  siblings: Node[],
  pos: Pick<ReparentInput, "parentId" | "index" | "before" | "after">,
  at: (key: string) => string,
  what: string,
  self?: Node,
): number {
  const invalid = (key: string, message: string, hint: string) =>
    new KalamoError({ code: "INVALID_INPUT", message, hint, path: at(key) });
  const given = (["index", "before", "after"] as const).filter((k) => pos[k] !== undefined);
  if (given.length > 1) {
    throw invalid(
      given[1] as string,
      `${what} takes one of index, before and after, not ${given.join(" and ")}.`,
      "Keep one of them; with none the Node goes on top of the parent's children.",
    );
  }
  const other = self ? "other " : "";
  let slot = siblings.length;
  if (pos.index !== undefined) {
    if (pos.index > siblings.length) {
      throw invalid(
        "index",
        `index ${pos.index} is past the top: the parent has ${siblings.length} ${other}${siblings.length === 1 ? "child" : "children"}.`,
        `Use 0 (bottom) to ${siblings.length} (top), or omit index to put the Node on top.`,
      );
    }
    slot = pos.index;
  }
  const key = pos.before !== undefined ? "before" : pos.after !== undefined ? "after" : undefined;
  if (key) {
    const ref = lookup(doc, pos[key] as string, at(key));
    const j = siblings.indexOf(ref);
    if (j < 0) {
      throw invalid(
        key,
        ref === self
          ? `${key} names the Node being moved.`
          : `${ref.id} is not a child of ${pos.parentId ?? "the Document root"}.`,
        `${key} names another child of the parent; doc_outline lists them.`,
      );
    }
    slot = key === "before" ? j : j + 1;
  }
  return slot;
}

/** One move: the Node at its new parent and fractional-index key, not yet stored. */
function moved(doc: Document, move: ReparentInput, i: number): Node {
  const at = (key: string) => `moves[${i}].${key}`;
  const node = lookup(doc, move.nodeId, at("nodeId"));
  assertParent(doc, node, move.parentId, at("parentId"));
  const siblings = childrenOf(doc, move.parentId).filter((n) => n.id !== node.id);
  const slot = slotOf(doc, siblings, move, at, "A move", node);
  const below = siblings[slot - 1]?.index ?? null;
  const above = siblings[slot]?.index ?? null;
  // A key already in the slot is kept, as makeMask keeps keys.
  const fits = (below === null || below < node.index) && (above === null || node.index < above);
  const next = {
    ...node,
    parentId: move.parentId,
    index: fits ? node.index : generateKeyBetween(below, above),
  };
  // A Clipping Path or mask leaving its parent loses clipping or opacityMask, as a pasted one does
  // (ADR-0053, ADR-0103); restacked in place it keeps it, since its position does not matter
  // (ADR-0021).
  return move.parentId === node.parentId ? (next as Node) : unmasked(next as Node);
}

/**
 * Moves each Node, with everything beneath it, to its parent and position (ADR-0071), in order,
 * each on the Document the moves before it left. Validates every move before storing any. A Node
 * moved twice is returned once, with its final value, where it first appeared.
 */
export function reparentNodes(
  doc: Document,
  moves: ReparentInput[],
  { partial = false } = {},
): { nodes: Node[]; failed: Failed[] } {
  const staged = { ...doc, nodes: new Map(doc.nodes) };
  const { ok, failed } = collect(moves, partial, (m, i) => {
    const next = moved(staged, m, i);
    staged.nodes.set(next.id, next);
    return next;
  });
  const nodes = [...new Map(ok.map((n) => [n.id, n])).values()];
  for (const n of nodes) doc.nodes.set(n.id, n);
  return { nodes, failed };
}

/**
 * The moves that restack `selected`, some of `siblings` (bottom first), as `op` says (ADR-0074):
 * front and back keep their relative order, and forward and backward step each past one unselected
 * sibling, so a contiguous run moves as a block and a run at the edge stays. Each move is one
 * position, applied in order, so a Node already in its slot keeps its key.
 */
function restack(siblings: Node[], selected: Set<string>, op: ReorderOp): ReparentInput[] {
  const order = siblings.map((n) => n.id);
  const parentId = siblings[0]?.parentId ?? null;
  const moves: ReparentInput[] = [];
  const move = (nodeId: string, at: { before: string } | { after: string } | { index: number }) =>
    moves.push({ nodeId, parentId, ...at });
  if (op === "front" || op === "back") {
    // From the edge inward, each lands next to the one placed before it.
    const picked = order.filter((id) => selected.has(id));
    const run = op === "front" ? picked.reverse() : picked;
    run.forEach((id, i) => {
      const prev = run[i - 1];
      if (prev === undefined) move(id, { index: op === "front" ? order.length - 1 : 0 });
      else move(id, op === "front" ? { before: prev } : { after: prev });
    });
    return moves;
  }
  // From the leading edge back, so a Node steps past the sibling the one ahead of it just left.
  const up = op === "forward";
  const step = up ? 1 : -1;
  for (let i = up ? order.length - 2 : 1; i >= 0 && i < order.length; i -= step) {
    const id = order[i] as string;
    const next = order[i + step] as string;
    if (!selected.has(id) || selected.has(next)) continue;
    move(id, up ? { after: next } : { before: next });
    order[i] = next;
    order[i + step] = id;
  }
  return moves;
}

/**
 * Object > Arrange (ADR-0074): restacks each Node within its own parent, which never changes.
 * Returns the Nodes that moved, in the order `nodeIds` names them; one already where `op` puts it
 * keeps its key and is not returned.
 */
export function reorderNodes(
  doc: Document,
  nodeIds: string[],
  op: ReorderOp,
  { partial = false } = {},
): { nodes: Node[]; failed: Failed[] } {
  const { ok, failed } = collect(nodeIds, partial, (id, i) => lookup(doc, id, `nodeIds[${i}]`));
  const selected = new Set(ok.map((n) => n.id));
  const parents = new Set(ok.map((n) => n.parentId));
  const moves = [...parents].flatMap((p) => restack(childrenOf(doc, p), selected, op));
  reparentNodes(doc, moves);
  const nodes = [...new Map(ok.map((n) => [n.id, n])).values()].flatMap((n) => {
    const now = doc.nodes.get(n.id) as Node;
    return now.index === n.index ? [] : [now];
  });
  return { nodes, failed };
}

/**
 * `node_duplicate` and Alt-drag copy (ADR-0076): `count` copies of each Node with its whole subtree,
 * every copy a new id and otherwise unchanged, copy k translated by k × `offset`. Without
 * `targetParentId` each Node's copies stack directly above it in its parent, k = 1 lowest; with it
 * they go there as one block, k by k and the originals in paint order, at `index`, `before` or
 * `after` or else on top. No existing Node's key changes. A copied top-level Node loses `clipping`
 * and `opacityMask`, so no container gets a second Clipping Path or mask; a copied container keeps
 * its own. With `layerSuffix`
 * every copied Layer with a name gets it appended (#195).
 *
 * Returns the new Nodes, depth first, and each outermost source id's copies in order k.
 */
export function duplicateNodes(
  doc: Document,
  raw: DuplicateInput,
): { created: Node[]; copies: Record<string, string[]> } {
  const input = DuplicateInput.parse(raw);
  const { count = 1, offset, targetParentId: target } = input;
  const found = input.nodeIds.map((id, i) => lookup(doc, id, `nodeIds[${i}]`));
  const { kept } = outermost(doc, found);
  // Each placement is an original and the keys of its copies, k = 1 first.
  let placements: { node: Node; keys: string[] }[];
  if (target === undefined) {
    const pos = (["index", "before", "after"] as const).find((k) => input[k] !== undefined);
    if (pos) {
      throw new KalamoError({
        code: "INVALID_INPUT",
        message: `${pos} places the copies in targetParentId, which is missing.`,
        hint: "Give targetParentId too, or omit it and the position to put each copy directly above its original.",
        path: pos,
      });
    }
    placements = kept.map((node) => {
      const siblings = childrenOf(doc, node.parentId);
      const above = siblings[siblings.indexOf(node) + 1]?.index ?? null;
      return { node, keys: generateNKeysBetween(node.index, above, count) };
    });
  } else {
    for (const n of kept) assertParent(doc, n, target, "targetParentId");
    const order = paintOrder(doc);
    const block = [...kept].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const siblings = childrenOf(doc, target);
    const slot = slotOf(doc, siblings, { ...input, parentId: target }, (k) => k, "A duplicate");
    const keys = generateNKeysBetween(
      siblings[slot - 1]?.index ?? null,
      siblings[slot]?.index ?? null,
      count * block.length,
    );
    placements = block.map((node, j) => ({
      node,
      keys: keys.filter((_, i) => i % block.length === j),
    }));
  }

  const created: Node[] = [];
  const { layerSuffix } = input;
  const copy = (n: Node, parentId: string | null, index: string): string => {
    const id = newId();
    const name = layerSuffix && n.type === "layer" && n.name ? n.name + layerSuffix : n.name;
    doc.nodes.set(id, { ...structuredClone(n), id, parentId, index, name });
    created.push(doc.nodes.get(id) as Node);
    for (const c of childrenOf(doc, n.id)) copy(c, id, c.index);
    return id;
  };
  const copies: Record<string, string[]> = {};
  for (const { node, keys } of placements) {
    copies[node.id] = keys.map((key, i) => {
      const id = copy(node, target === undefined ? node.parentId : target, key);
      doc.nodes.set(id, unmasked(doc.nodes.get(id) as Node));
      if (offset) {
        const k = i + 1;
        transformNodes(doc, { nodeIds: [id], translate: { x: k * offset.x, y: k * offset.y } });
      }
      return id;
    });
  }
  return { created: created.map((n) => doc.nodes.get(n.id) as Node), copies };
}

/**
 * Deletes the Nodes and everything beneath them. Refuses, with LAST_LAYER, the delete that would
 * remove the last top-level Layer (ADR-0073): the whole call, or with `partial` the first such
 * target in order, so its Layer stays and the targets before it go. It counts the top-level Layers
 * left per target rather than calling `lostLastLayer`, which only sees the whole delete.
 */
export function deleteNodes(
  doc: Document,
  nodeIds: string[],
  { partial = false } = {},
): { deletedIds: string[]; failed: Failed[] } {
  const layers = new Set([...doc.nodes.values()].filter(isTopLayer).map((n) => n.id));
  const named = [...new Set(nodeIds.filter((id) => layers.has(id)))];
  const { ok: targets, failed } = collect(nodeIds, partial, (id, i) => {
    const node = lookup(doc, id, `nodeIds[${i}]`);
    if (layers.has(id) && layers.size === 1) {
      throw new KalamoError({
        code: "LAST_LAYER",
        message: "A Document keeps at least one top-level Layer.",
        hint: "Delete the Layer's contents instead, or create another top-level Layer first with kalamo_node_create and no parentId.",
        path: `nodeIds[${i}]`,
        nodeIds: partial ? [id] : named,
      });
    }
    layers.delete(id);
    return node;
  });
  const { kept } = outermost(doc, targets);
  const gone = kept.flatMap((n) => subtree(doc, n));
  for (const n of gone) doc.nodes.delete(n.id);
  return { deletedIds: gone.map((n) => n.id), failed };
}
