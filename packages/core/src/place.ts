import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import { assertParent, bounds, childrenOf, createNodes, newId, union } from "./document.ts";
import { transformNodes } from "./edit.ts";
import type { Artboard, Document, Node, Rect, RenderScope, WriteReceipt } from "./schema.ts";
import { fileFontWarnings, fileGlyphWarnings } from "./text.ts";

type Warning = WriteReceipt["warnings"][number];

/**
 * Warnings Open keeps once per file or face, so one stands for several Nodes; Place counts them
 * again over what it copies. A reader warning aggregated that way with a `nodeId` belongs here too.
 */
const PER_FILE = new Set(["FONT_MISSING", "MISSING_GLYPHS"]);

const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/** The Artboard the Node's bounds overlap most, else the first one (ADR-0017). */
function artboardOf(doc: Document, node: Node): Artboard | undefined {
  const b = bounds(doc, node);
  let best = doc.artboards[0];
  let most = 0;
  for (const a of doc.artboards) {
    const area = b ? overlap(a.frame, b) : 0;
    if (area > most) [best, most] = [a, area];
  }
  return best;
}

/**
 * Place (ADR-0017): a file's Nodes as one new Group above `parentId`'s children. Layers become
 * Groups, every id is new, and the Group is centred on `position`, by default the parent's
 * Artboard, after `fit` scales it to that Artboard; `inPlace` keeps the file's coordinates.
 *
 * A Zibel copy, whose `scope` lists Nodes it holds, pastes without the Group (ADR-0030): its Nodes
 * land directly in the parent, in stacking order, less the Layers and Groups that only lead to a
 * listed Node. `placedIds` are the Nodes put in the parent, the Group or those, and `created`
 * starts with them. `warnings` are the file's, each `nodeId` renamed to its copy's id; one on a Node
 * that stays behind is dropped. The per-file `FONT_MISSING` and `MISSING_GLYPHS` are counted again
 * over the texts Place copies, in file order as Open counts them (ADR-0062).
 */
export function placeNodes(
  doc: Document,
  file: { name: string; nodes: Node[]; scope?: RenderScope; warnings?: Warning[] },
  opts: { parentId: string; position?: { x: number; y: number }; fit?: boolean; inPlace?: boolean },
): { placedIds: string[]; created: Node[]; warnings: Warning[] } {
  assertParent(doc, { type: "group" }, opts.parentId, "parentId");
  // Chosen before the file's Nodes move the parent's bounds.
  const artboard = artboardOf(doc, doc.nodes.get(opts.parentId) as Node);
  const kids = new Map<string | null, Node[]>();
  for (const n of file.nodes) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  for (const list of kids.values()) list.sort((a, b) => (a.index < b.index ? -1 : 1));
  const childrenIn = (id: string | null) => kids.get(id) ?? [];
  const has = new Set(file.nodes.map((n) => n.id));
  const listed = new Set(
    file.scope && "nodeIds" in file.scope ? file.scope.nodeIds.filter((id) => has.has(id)) : [],
  );
  const leads = (n: Node): boolean =>
    !listed.has(n.id) && childrenIn(n.id).some((c) => listed.has(c.id) || leads(c));
  const tops = (id: string | null): Node[] =>
    childrenIn(id).flatMap((n) => (leads(n) ? tops(n.id) : [n]));

  const group =
    listed.size === 0
      ? (createNodes(doc, [
          { type: "group", parentId: opts.parentId, name: file.name, children: [] },
        ]).nodes[0] as Node)
      : undefined;
  // A pasted Clipping Path never clips the parent (ADR-0053): a listed one comes as an ordinary
  // Path; one written only for the Clipping Mask that leads to a listed Node stays behind.
  const roots = group
    ? childrenIn(null)
    : tops(null).flatMap((n): Node[] => {
        if (!("clipping" in n && n.clipping)) return [n];
        const { clipping: _, ...path } = n;
        return listed.has(n.id) ? [path] : [];
      });
  const keys = group
    ? roots.map((n) => n.index)
    : generateNKeysBetween(
        childrenOf(doc, opts.parentId).at(-1)?.index ?? null,
        null,
        roots.length,
      );
  const ids = new Map<string, string>();
  const copy = (n: Node, parentId: string, index: string): string => {
    const id = newId();
    ids.set(n.id, id);
    doc.nodes.set(id, {
      ...n,
      id,
      parentId,
      index,
      ...(n.type === "layer" && { type: "group" }),
    } as Node);
    for (const c of childrenIn(n.id)) copy(c, id, c.index);
    return id;
  };
  const copied = roots.map((n, i) => copy(n, group?.id ?? opts.parentId, keys[i] as string));
  const placedIds = group ? [group.id] : copied;

  const b = union(placedIds.map((id) => bounds(doc, doc.nodes.get(id) as Node)));
  const target = opts.position ??
    (artboard && {
      x: artboard.frame.x + artboard.frame.width / 2,
      y: artboard.frame.y + artboard.frame.height / 2,
    }) ?? { x: 0, y: 0 };
  if (b && !opts.inPlace) {
    const centre = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    // A file flat in one direction fits by the other; a single point keeps its size.
    const ratios = artboard
      ? [
          b.width > 0 ? artboard.frame.width / b.width : Infinity,
          b.height > 0 ? artboard.frame.height / b.height : Infinity,
        ]
      : [];
    const s = Math.min(...ratios);
    transformNodes(doc, {
      nodeIds: placedIds,
      pivot: centre,
      ...(opts.fit && Number.isFinite(s) && { scale: s }),
      translate: { x: target.x - centre.x, y: target.y - centre.y },
    });
  }
  const placed = new Set(placedIds);
  const rest = [...ids.values()].filter((id) => !placed.has(id));
  const originals = file.nodes.filter((n) => ids.has(n.id));
  const warnings = [
    ...(file.warnings ?? []).filter((w) => !PER_FILE.has(w.code)),
    ...fileFontWarnings(originals),
    ...fileGlyphWarnings(originals),
  ].flatMap((w) => {
    if (w.nodeId === undefined) return [w];
    const id = ids.get(w.nodeId);
    return id ? [{ ...w, nodeId: id }] : [];
  });
  return {
    placedIds,
    created: [...placedIds, ...rest].map((id) => doc.nodes.get(id) as Node),
    warnings,
  };
}

/**
 * Place for a bitmap (ADR-0027): an Image of the stored file `src` in `parentId`, framed by `frame`
 * (size default the file's pixels), else its pixel size centred on the parent's Artboard. With
 * `asTemplate`, on a new locked Template Layer beneath the parent's Layer, at 50% opacity. Returns
 * the new Nodes, the Layer first.
 */
export function placeImage(
  doc: Document,
  file: { src: string; name: string },
  opts: {
    parentId: string;
    frame?: { x: number; y: number; width?: number; height?: number };
    asTemplate?: boolean;
  },
): { created: Node[] } {
  assertParent(doc, { type: "image" }, opts.parentId, "parentId");
  const parent = doc.nodes.get(opts.parentId) as Node;
  const info = doc.images.get(file.src);
  const width = opts.frame?.width ?? info?.width ?? 0;
  const height = opts.frame?.height ?? info?.height ?? 0;
  const frame = artboardOf(doc, parent)?.frame ?? { x: 0, y: 0, width: 0, height: 0 };
  const { x, y } = opts.frame ?? {
    x: frame.x + (frame.width - width) / 2,
    y: frame.y + (frame.height - height) / 2,
  };

  const created: Node[] = [];
  let parentId = opts.parentId;
  if (opts.asTemplate) {
    let holder = parent;
    while (holder.type !== "layer") holder = doc.nodes.get(holder.parentId as string) as Node;
    const [made] = createNodes(doc, [
      { type: "layer", parentId: holder.parentId, name: `Template ${file.name}` },
    ]).nodes as [Node];
    const siblings = childrenOf(doc, holder.parentId);
    const below = siblings[siblings.findIndex((n) => n.id === holder.id) - 1];
    const layer = {
      ...made,
      locked: true,
      index: generateKeyBetween(below?.index ?? null, holder.index),
    };
    doc.nodes.set(layer.id, layer);
    created.push(layer);
    parentId = layer.id;
  }
  const [made] = createNodes(doc, [{ type: "image", parentId, src: file.src, x, y, width, height }])
    .nodes as [Node];
  const image = opts.asTemplate ? { ...made, opacity: 0.5 } : made;
  doc.nodes.set(image.id, image);
  created.push(image);
  return { created };
}
