import { childrenOf, clippingPath, type Document, lockedIn, type Node } from "@zibel/core";
import type { Command } from "@zibel/sync";
import { editable, placeParent } from "./selection.ts";

const AUTO_NAMES: Record<Exclude<Node["type"], "text">, string> = {
  rect: "<Rectangle>",
  ellipse: "<Ellipse>",
  line: "<Line>",
  polygon: "<Polygon>",
  star: "<Star>",
  path: "<Path>",
  image: "<Image>",
  group: "<Group>",
  layer: "<Layer>",
};

/**
 * What the Layers panel shows for a Node whose `name` is empty, a text's content; never stored
 * (ADR-0012). A Clip Group, a Clipping Path and a linked Image take Illustrator's names
 * (ADR-0021, ADR-0042); a clipped Layer stays a Layer (ADR-0053).
 */
export const autoName = (doc: Document, node: Node) =>
  node.type === "group" && clippingPath(doc, node)
    ? "<Clip Group>"
    : "clipping" in node && node.clipping
      ? "<Clipping Path>"
      : node.type === "text"
        ? node.content.replaceAll("\n", " ")
        : node.type === "image" && node.file !== undefined
          ? "<Linked File>"
          : AUTO_NAMES[node.type];

/** One line of the Layers panel. */
export interface Row {
  node: Node;
  depth: number;
  expandable: boolean;
  expanded: boolean;
  /** Hidden or locked, itself or through an ancestor. */
  dimmed: boolean;
  /** A Clipping Mask, Layer or Group, or its Clipping Path, whose name Illustrator underlines. */
  underlined: boolean;
}

/**
 * The Layers panel's rows, siblings topmost first (ADR-0012). `toggled` holds the containers
 * expanded or collapsed away from their default: Layers start expanded, Groups collapsed.
 * ponytail: childrenOf scans every Node per container, O(n²); index children when Documents grow.
 */
export function rows(doc: Document, toggled: Set<string>): Row[] {
  const walk = (parentId: string | null, depth: number): Row[] =>
    childrenOf(doc, parentId)
      .reverse()
      .flatMap((node) => {
        const expandable =
          (node.type === "layer" || node.type === "group") && childrenOf(doc, node.id).length > 0;
        const expanded = expandable && (node.type === "layer") !== toggled.has(node.id);
        const underlined = ("clipping" in node && !!node.clipping) || !!clippingPath(doc, node);
        const dimmed = !editable(doc, node);
        const row = { node, depth, expandable, expanded, dimmed, underlined };
        return expanded ? [row, ...walk(node.id, depth + 1)] : [row];
      });
  return walk(null, 0);
}

/**
 * The Layers panel's Make/Release Clipping Mask button (ADR-0053), on the Layer Place targets: it
 * makes that Layer's topmost child its Clipping Path, or releases it. No command when that Layer is
 * empty or locked.
 */
export function layerMask(
  doc: Document,
  selection: string[],
): { label: string; command: Command | null } {
  const layerId = placeParent(doc, selection);
  const layer = doc.nodes.get(layerId ?? "");
  const clipped = !!layer && !!clippingPath(doc, layer);
  const label = `${clipped ? "Release" : "Make"} Clipping Mask`;
  if (!layer || lockedIn(doc, layer) || childrenOf(doc, layer.id).length === 0) {
    return { label, command: null };
  }
  const command: Command = clipped
    ? { type: "mask_release", nodeIds: [layer.id] }
    : { type: "mask_make", input: { layerId: layer.id } };
  return { label, command };
}
