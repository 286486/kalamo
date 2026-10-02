import {
  childrenOf,
  clippingPath,
  createNodes,
  isOpacityMask,
  opacityMaskOf,
  unmasked,
} from "./document.ts";
import { lookup } from "./edit.ts";
import { collect, KalamoError } from "./errors.ts";
import type { Document, GroupNode, LeafNode, MaskInput, Node } from "./schema.ts";
import { unfilledRanges } from "./text.ts";

const invalid = (path: string, message: string, hint: string) =>
  new KalamoError({ code: "INVALID_MASK", message, hint, path });

/**
 * Illustrator's Object > Clipping Mask > Make (ADR-0021): a new Group at the topmost member's place
 * holds the clip Node and the content, each keeping its stacking order, and the clip Node becomes
 * its Clipping Path with an empty Appearance. With `kind: "opacity"`, the Transparency panel's Make
 * Mask (ADR-0103): the same Group, the clip Node its mask, keeping its Appearance. With `layerId`,
 * the Layers panel's Make instead (ADR-0053): no Group, see makeLayerMask. Validates everything
 * before changing anything.
 */
export function makeMask(
  doc: Document,
  input: Extract<MaskInput, { clipNodeId: string }>,
): { group: GroupNode; updated: Node[] };
export function makeMask(
  doc: Document,
  input: MaskInput,
): { group: GroupNode | undefined; updated: Node[] };
export function makeMask(
  doc: Document,
  input: MaskInput,
): { group: GroupNode | undefined; updated: Node[] } {
  const opacity = input.kind === "opacity";
  const option = (["clip", "invert"] as const).find((k) => input[k] !== undefined);
  if (!opacity && option) {
    throw invalid(
      option,
      `${option} is an option of an Opacity Mask.`,
      `Send kind "opacity" with it, or leave ${option} out for a Clipping Mask.`,
    );
  }
  if ("layerId" in input) {
    if (opacity) {
      throw invalid(
        "layerId",
        "A Layer cannot be an Opacity Mask.",
        "Give clipNodeId, the mask, and contentIds instead: they go into a new Group.",
      );
    }
    return { group: undefined, updated: [makeLayerMask(doc, input.layerId)] };
  }
  const { clipNodeId, contentIds } = input;
  const clip = lookup(doc, clipNodeId, "clipNodeId");
  const role = opacity ? "mask" : "Clipping Path";
  if (clip.type === "layer" || (!opacity && (clip.type === "group" || clip.type === "image"))) {
    throw invalid(
      "clipNodeId",
      `A ${clip.type} cannot be a ${role}.`,
      opacity
        ? "Mask with a Live Shape, a Path, a text, an Image or a Group."
        : "Clip with a Live Shape, a Path or a text.",
    );
  }
  if (isMask(clip)) {
    throw invalid(
      "clipNodeId",
      `The Node is already a ${isOpacityMask(clip) ? "mask" : "Clipping Path"}.`,
      `Use mask_release on it first, or ${opacity ? "mask" : "clip"} with another Node.`,
    );
  }
  if (!clip.visible) {
    throw invalid(
      "clipNodeId",
      `A ${role} cannot be hidden.`,
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
    if (isMask(n)) {
      const [what, mask] = isOpacityMask(n) ? ["mask", "Opacity"] : ["Clipping Path", "Clipping"];
      throw invalid(
        at,
        `The Node is the ${what} of its parent: a Group has at most one.`,
        `Release its ${mask} Mask with mask_release first.`,
      );
    }
    if (n.parentId !== clip.parentId) {
      throw invalid(
        at,
        "The clip Node and the content do not share one parent.",
        "List siblings of the clip Node only; move a Node from another Layer or Group next to the clip Node with node_reparent first.",
      );
    }
    return n;
  });
  const members = [clip, ...content].sort((a, b) => (a.index < b.index ? -1 : 1));
  const top = members.at(-1) as Node;
  const [made] = createNodes(doc, [{ type: "group", parentId: clip.parentId as string }]).nodes;
  const group = { ...(made as GroupNode), index: top.index };
  const opacityMask = { clip: input.clip ?? true, invert: input.invert ?? false, link: true };
  const updated = members.map((m): Node => {
    const moved = { ...m, parentId: group.id };
    if (m !== clip) return moved;
    return opacity ? { ...moved, opacityMask } : emptied(moved as LeafNode);
  });
  for (const n of [group, ...updated]) doc.nodes.set(n.id, n);
  return { group, updated };
}

/**
 * The Layers panel's Make Clipping Mask (ADR-0053): the Layer's topmost child becomes its Clipping
 * Path, with an empty Appearance, and nothing moves.
 */
function makeLayerMask(doc: Document, layerId: string): LeafNode {
  const layer = lookup(doc, layerId, "layerId");
  const refuse = (message: string, hint: string) => invalid("layerId", message, hint);
  if (layer.type !== "layer") {
    throw refuse(
      `A ${layer.type} is not a Layer.`,
      "Name a Layer, or clip Nodes with clipNodeId and contentIds.",
    );
  }
  if (clippingPath(doc, layer)) {
    throw refuse(
      "The Layer is already a Clipping Mask.",
      "Release it with mask_release first: a Layer has one Clipping Path.",
    );
  }
  const top = childrenOf(doc, layer.id).at(-1);
  if (!top)
    throw refuse("The Layer is empty.", "Put the Live Shape, Path or text that clips in it.");
  if (top.type === "layer" || top.type === "group" || top.type === "image") {
    throw refuse(
      `The Layer's topmost child is a ${top.type}, which cannot be a Clipping Path.`,
      "Put a Live Shape, a Path or a text on top of the Layer first.",
    );
  }
  if (!top.visible) {
    throw refuse(
      "The Layer's topmost child is hidden, and a Clipping Path cannot be.",
      "Show it with node_update {visible: true} first.",
    );
  }
  const clip = emptied(top);
  doc.nodes.set(clip.id, clip);
  return clip;
}

/**
 * The clip Node as a Clipping Path: no Fill and no Stroke, and for a text no Range Fill either,
 * its Ranges kept canonical (ADR-0052).
 */
function emptied(clip: LeafNode): LeafNode {
  const appearance = { fills: [], strokes: [] };
  if (clip.type !== "text") return { ...clip, clipping: true, appearance };
  const { ranges, ...text } = clip;
  const kept = unfilledRanges(ranges, text);
  return { ...text, ...(kept && { ranges: kept }), clipping: true, appearance };
}

/** A Clipping Path or the mask of an Opacity Mask. */
const isMask = (n: Node) => ("clipping" in n && !!n.clipping) || isOpacityMask(n);

/**
 * Illustrator's Object > Clipping Mask > Release and the Transparency panel's Release (ADR-0103):
 * each Clipping Mask or Opacity Mask, named by its Group or Layer or by its Clipping Path or mask,
 * stops clipping or masking; the Group and the former Clipping Path or mask, with whatever
 * Appearance it has, stay.
 */
export function releaseMask(doc: Document, nodeIds: string[], { partial = false } = {}) {
  const { ok, failed } = collect(nodeIds, partial, (id, i) => {
    const n = lookup(doc, id, `nodeIds[${i}]`);
    const mask = isMask(n) ? n : (clippingPath(doc, n) ?? opacityMaskOf(doc, n));
    if (mask) return mask;
    throw invalid(
      `nodeIds[${i}]`,
      `The ${n.type} is not a Clipping Mask or an Opacity Mask, nor the Clipping Path or mask of one.`,
      "List Groups or Layers made Clipping Masks or Opacity Masks by mask_make, or their Clipping Paths or masks: node_get with detail full shows clipping: true or opacityMask on one.",
    );
  });
  const nodes = [...new Map(ok.map((c) => [c.id, c])).values()].map(unmasked);
  for (const n of nodes) doc.nodes.set(n.id, n);
  return { nodes, failed };
}
