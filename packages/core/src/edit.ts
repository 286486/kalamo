import type { z } from "zod";
import {
  bounds,
  checkFile,
  childrenOf,
  imageInfo,
  mapPaint,
  paint,
  paintContainer,
  union,
} from "./document.ts";
import { collect, type Failed, KalamoError } from "./errors.ts";
import { preserveAspectRatio } from "./image.ts";
import { compose, multiply, round, scaleOf } from "./matrix.ts";
import { formatPath, parsePath } from "./path.ts";
import {
  AppearanceInput,
  ContainerAppearanceInput,
  type Document,
  type GroupNode,
  ImageShape,
  type LayerNode,
  type LeafNode,
  type Node,
  PIVOTS,
  type Rect,
  SHAPES,
  TextShape,
  TransformInput,
  textRanges,
  type UpdateInput,
  type Warning,
  Writable,
} from "./schema.ts";
import { canonicalRanges } from "./text.ts";

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

/** Drops targets that sit inside another target, so nothing is edited twice. */
function outermost(doc: Document, targets: Node[]): { kept: Node[]; nested: Node[] } {
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

/**
 * Composes the transform into every leaf beneath the targets; Layers and Groups stay identity
 * (ADR-0007), whose Strokes scale instead (ADR-0043). Returns the changed containers, then the
 * changed leaves depth first in target order.
 */
export function transformNodes(
  doc: Document,
  raw: TransformInput,
  { partial = false } = {},
): { nodes: Node[]; warnings: Warning[]; failed: Failed[] } {
  const input = TransformInput.parse(raw);
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
    const all = group.flatMap((n) => subtree(doc, n));
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
  parentId: "Moving a Node to another parent needs node_reparent, which is not available yet.",
  index: "Stacking order needs node_reorder, which is not available yet.",
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
  if (node.type === "layer" || node.type === "group") {
    return Writable.extend({ appearance: ContainerAppearanceInput.optional() });
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
    });
  }
  if (node.type === "text") {
    // A text's kind is fixed, and only Area Type has a frame, which it cannot drop (ADR-0022).
    const { type: _, kind: __, width, height, ...text } = TextShape.shape;
    const frame = node.kind === "area" ? { width: width.unwrap(), height: height.unwrap() } : {};
    return Writable.extend(text)
      .extend(frame)
      .extend({ appearance: AppearanceInput })
      .superRefine(textRanges);
  }
  const { type: _, ...parameters } = SHAPES[node.type].shape;
  return Writable.extend(parameters).extend({ appearance: AppearanceInput });
}

/** Validates and merges one patch, returning the new Node without storing it. */
function patched(doc: Document, raw: UpdateInput, i: number): Node {
  // Not parsed with NodePatch: the per-type schema below checks every value and answers with a hint.
  const { nodeId, patch } = raw as { nodeId: string; patch: Record<string, unknown> };
  const node = lookup(doc, nodeId, `updates[${i}].nodeId`);
  const at = `updates[${i}].patch`;
  const invalid = (key: string, message: string, hint: string) =>
    new KalamoError({ code: "INVALID_PATCH", message, hint, path: `${at}${key}` });
  const schema = writableSchema(node);
  for (const key of Object.keys(patch)) {
    const readOnly =
      (Object.hasOwn(READ_ONLY, key) ? READ_ONLY[key] : undefined) ??
      (key === "kind" && node.type === "text"
        ? "A text's kind is fixed (ADR-0022); create a text of the other kind and delete this one."
        : key === "d" && node.type === "text"
          ? "A text has no outline until Create Outlines; change content instead."
          : key === "d" && node.type !== "path"
            ? "A Live Shape's d is derived from its parameters; change those instead."
            : undefined);
    if (readOnly) throw invalid(`.${key}`, `${key} is read-only.`, readOnly);
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
  const next = { ...merged, ...parsed.data } as Node;
  // SVG clips everything away through a hidden clip path; Illustrator unclips (ADR-0021).
  if ("clipping" in next && next.clipping && !next.visible) {
    throw invalid(
      ".visible",
      "A Clipping Path cannot be hidden.",
      "Use mask_release to show the content unclipped, or hide the Clipping Mask's Group.",
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
  if (next.type === "text") {
    const ranges = canonicalRanges(next.ranges, `${at}.ranges`, next);
    if (ranges) next.ranges = ranges;
    else delete next.ranges;
  }
  if (next.type === "path" && "d" in patch) next.d = formatPath(parsePath(next.d, `${at}.d`));
  return next;
}

/**
 * Applies one merge patch per item, in order, so two patches to one Node both land. Validates every
 * item before storing any.
 */
export function updateNodes(
  doc: Document,
  updates: UpdateInput[],
  { partial = false } = {},
): { nodes: Node[]; failed: Failed[] } {
  const staged = { ...doc, nodes: new Map(doc.nodes) };
  const { ok: nodes, failed } = collect(updates, partial, (u, i) => {
    const next = patched(staged, u, i);
    staged.nodes.set(next.id, next);
    return next;
  });
  // Two patches to one Node are one update: its final value, where it first appeared.
  const unique = [...new Map(nodes.map((n) => [n.id, n])).values()];
  for (const n of unique) doc.nodes.set(n.id, n);
  return { nodes: unique, failed };
}

/** Deletes the Nodes and everything beneath them. */
export function deleteNodes(
  doc: Document,
  nodeIds: string[],
  { partial = false } = {},
): { deletedIds: string[]; failed: Failed[] } {
  const { ok: targets, failed } = collect(nodeIds, partial, (id, i) =>
    lookup(doc, id, `nodeIds[${i}]`),
  );
  const { kept } = outermost(doc, targets);
  const gone = kept.flatMap((n) => subtree(doc, n));
  for (const n of gone) doc.nodes.delete(n.id);
  return { deletedIds: gone.map((n) => n.id), failed };
}
