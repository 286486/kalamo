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

/** A Node's name in the Layers panel and the isolation bar: its own, else its Auto-name. */
export const nameOf = (doc: Document, node: Node) => node.name || autoName(doc, node);

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
 * expanded or collapsed away from their default: Layers start expanded, Groups collapsed. With the
 * isolated Group `scope`, only it and what is in it (ADR-0057): its row is the root, always
 * expanded.
 * ponytail: childrenOf scans every Node per container, O(n²); index children when Documents grow.
 */
export function rows(doc: Document, toggled: Set<string>, scope: string | null = null): Row[] {
  const row = (node: Node, depth: number, root = false): Row[] => {
    const expandable =
      !root &&
      (node.type === "layer" || node.type === "group") &&
      childrenOf(doc, node.id).length > 0;
    const expanded = root || (expandable && (node.type === "layer") !== toggled.has(node.id));
    const underlined = ("clipping" in node && !!node.clipping) || !!clippingPath(doc, node);
    const dimmed = !editable(doc, node);
    const it = { node, depth, expandable, expanded, dimmed, underlined };
    return expanded ? [it, ...walk(node.id, depth + 1)] : [it];
  };
  const walk = (parentId: string | null, depth: number): Row[] =>
    childrenOf(doc, parentId)
      .reverse()
      .flatMap((node) => row(node, depth));
  const root = scope === null ? undefined : doc.nodes.get(scope);
  return root ? row(root, 0, true) : walk(null, 0);
}

/**
 * The Layers panel's Make/Release Clipping Mask button (ADR-0053), on the Layer Place targets: it
 * makes that Layer's topmost child its Clipping Path, or releases it. No command when that Layer is
 * empty or locked, or while a Group is isolated, which hides the Layer (ADR-0057).
 */
export function layerMask(
  doc: Document,
  selection: string[],
  scope: string | null = null,
): { label: string; command: Command | null } {
  const layerId = placeParent(doc, selection);
  const layer = doc.nodes.get(layerId ?? "");
  const clipped = !!layer && !!clippingPath(doc, layer);
  const label = `${clipped ? "Release" : "Make"} Clipping Mask`;
  if (!layer || scope !== null || lockedIn(doc, layer) || childrenOf(doc, layer.id).length === 0) {
    return { label, command: null };
  }
  const command: Command = clipped
    ? { type: "mask_release", nodeIds: [layer.id] }
    : { type: "mask_make", input: { layerId: layer.id } };
  return { label, command };
}
