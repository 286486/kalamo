import { childrenOf, clippingPath, type Document, type Node } from "@zibel/core";
import { editable } from "./selection.ts";

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
 * (ADR-0012). A Clipping Mask, its Clipping Path and a linked Image take Illustrator's names
 * (ADR-0021, ADR-0042).
 */
export const autoName = (doc: Document, node: Node) =>
  clippingPath(doc, node)
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
        const row = { node, depth, expandable, expanded, dimmed: !editable(doc, node) };
        return expanded ? [row, ...walk(node.id, depth + 1)] : [row];
      });
  return walk(null, 0);
}
