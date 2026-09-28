import { clippingPath, createNodes } from "./document.ts";
import { lookup } from "./edit.ts";
import { collect, ZibelError } from "./errors.ts";
import type { Document, GroupNode, MaskInput, Node, ShapeNode } from "./schema.ts";

const invalid = (path: string, message: string, hint: string) =>
  new ZibelError({ code: "INVALID_MASK", message, hint, path });

/**
 * Illustrator's Object > Clipping Mask > Make (ADR-0021): a new Group at the topmost member's place
 * holds the clip Node and the content, each keeping its stacking order, and the clip Node becomes
 * its Clipping Path with an empty Appearance. Validates everything before changing anything.
 */
export function makeMask(
  doc: Document,
  { clipNodeId, contentIds, kind = "clip" }: MaskInput,
): { group: GroupNode; updated: Node[] } {
  if (kind !== "clip") {
    throw invalid(
      "kind",
      "Opacity Masks are not available yet (F-MASK-02).",
      'Use kind "clip", or omit it.',
    );
  }
  const clip = lookup(doc, clipNodeId, "clipNodeId");
  if (
    clip.type === "layer" ||
    clip.type === "group" ||
    clip.type === "text" ||
    clip.type === "image"
  ) {
    throw invalid(
      "clipNodeId",
      `A ${clip.type} cannot be a Clipping Path.`,
      "Clip with a Live Shape or Path; a text waits for Create Outlines.",
    );
  }
  if (clip.clipping) {
    throw invalid(
      "clipNodeId",
      "The Node is already a Clipping Path.",
      "Use mask_release on it first, or clip with another Node.",
    );
  }
  if (!clip.visible) {
    throw invalid(
      "clipNodeId",
      "A Clipping Path cannot be hidden.",
      "Show the Node with node_update {visible: true} first.",
    );
  }
  const seen = new Set([clip.id]);
  const content = contentIds.map((id, i) => {
    const at = `contentIds[${i}]`;
    const n = lookup(doc, id, at);
    if (seen.has(id)) {
      throw invalid(
        at,
        "The Node is listed twice, or is the clip Node.",
        "List each content Node once, and not the clip Node.",
      );
    }
    seen.add(id);
    if (n.type === "layer") {
      throw invalid(
        at,
        "A Layer cannot be clipped: a Group never contains a Layer.",
        "Clip the Layer's Nodes instead.",
      );
    }
    if ("clipping" in n && n.clipping) {
      throw invalid(
        at,
        "The Node is a Clipping Path: a Group has at most one.",
        "Release its Clipping Mask with mask_release first.",
      );
    }
    if (n.parentId !== clip.parentId) {
      throw invalid(
        at,
        "The clip Node and the content do not share one parent.",
        "List siblings of the clip Node only; Nodes in other Layers or Groups cannot be moved in yet.",
      );
    }
    return n;
  });
  const members = [clip, ...content].sort((a, b) => (a.index < b.index ? -1 : 1));
  const top = members.at(-1) as Node;
  const [made] = createNodes(doc, [{ type: "group", parentId: clip.parentId as string }]).nodes;
  const group = { ...(made as GroupNode), index: top.index };
  const updated = members.map((m): Node => {
    const moved = { ...m, parentId: group.id };
    return m === clip
      ? { ...(moved as ShapeNode), clipping: true, appearance: { fills: [], strokes: [] } }
      : moved;
  });
  for (const n of [group, ...updated]) doc.nodes.set(n.id, n);
  return { group, updated };
}

/**
 * Illustrator's Object > Clipping Mask > Release: each Clipping Mask, named by its Group or its
 * Clipping Path, stops clipping; the Group and the Path, with whatever Appearance it has, stay.
 */
export function releaseMask(doc: Document, nodeIds: string[], { partial = false } = {}) {
  const { ok, failed } = collect(nodeIds, partial, (id, i) => {
    const n = lookup(doc, id, `nodeIds[${i}]`);
    const clip = n.type !== "text" && "clipping" in n && n.clipping ? n : clippingPath(doc, n);
    if (clip) return clip;
    throw invalid(
      `nodeIds[${i}]`,
      `The ${n.type} is not a Clipping Mask or its Clipping Path.`,
      "List Groups made by mask_make, or their Clipping Paths: node_get with detail full shows clipping: true on one.",
    );
  });
  const nodes = [...new Map(ok.map((c) => [c.id, c])).values()].map((c) => {
    const { clipping: _, ...rest } = c;
    return rest as ShapeNode;
  });
  for (const n of nodes) doc.nodes.set(n.id, n);
  return { nodes, failed };
}
