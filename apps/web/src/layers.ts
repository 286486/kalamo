import {
  childrenOf,
  clippingPath,
  type Document,
  type DuplicateInput,
  KalamoError,
  lockedIn,
  type Node,
  type ReparentInput,
  reparentNodes,
} from "@kalamo/core";
import type { Command } from "@kalamo/sync";
import { inScope, isolatable } from "./isolation.ts";
import { editable, placeParent } from "./selection.ts";

const AUTO_NAMES: Record<Exclude<Node["type"], "text">, string> = {
  rect: "<Rectangle>",
  ellipse: "<Ellipse>",
  line: "<Line>",
  polygon: "<Polygon>",
  star: "<Star>",
  spiral: "<Spiral>",
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
 * isolated Node `scope`, only it and what is in it (ADR-0057, ADR-0058): its row is the root, always
 * expanded.
 * ponytail: childrenOf scans every Node per container, O(n²); index children when Documents grow.
 */
export function rows(doc: Document, toggled: Set<string>, scope: string | null): Row[] {
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
 * empty or locked, or while a Group or leaf is isolated, which holds no Layer (ADR-0057, ADR-0058).
 */
export function layerMask(
  doc: Document,
  selection: string[],
  scope: string | null,
): { label: string; command: Command | null } {
  const target = doc.nodes.get(placeParent(doc, selection, scope) ?? "");
  const layer = target?.type === "layer" ? target : undefined;
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

/**
 * The Layers panel's Enter Isolation Mode button (ADR-0058): the deepest Layer holding every
 * selected Node, when it is a sub-Layer that can be isolated, strictly inside the isolated Node
 * `scope` if any. Its label names that Layer.
 */
export function layerIsolation(
  doc: Document,
  selection: string[],
  scope: string | null,
): { label: string; target: string | null } {
  const label = "Enter Isolation Mode";
  const holds = (layer: Node) =>
    selection.every((id) => {
      const n = doc.nodes.get(id);
      return !!n && inScope(doc, n, layer.id);
    });
  let layer = doc.nodes.get(doc.nodes.get(selection[0] ?? "")?.parentId ?? "");
  while (layer && (layer.type !== "layer" || !holds(layer))) {
    layer = doc.nodes.get(layer.parentId ?? "");
  }
  if (!layer || !isolatable(doc, layer.id) || layer.id === scope || !inScope(doc, layer, scope)) {
    return { label, target: null };
  }
  return { label: `${label} for ${nameOf(doc, layer)}`, target: layer.id };
}

/** Where a Layers panel drag lands: on a Layer or Group row, or in the gap above or below a row. */
export interface Drop {
  zone: "onto" | "above" | "below";
  id: string;
}

/**
 * The drop a pointer over `listed[i]` means (ADR-0075), at `y`, its fraction of the row's height
 * from the top, and at indent `level`, the row depth under the pointer's x; with the depth its
 * insertion line is drawn at. A container's middle drops into it, on top, and so does its bottom
 * quarter when it is expanded, since that gap lies over its topmost child; its top and bottom
 * quarters are the gaps above and below it, a leaf's halves. The gap below the last row of an
 * expanded container's contents is also the gap below that container, and below each ancestor it
 * closes: `level` picks which, as Illustrator's insertion line follows the pointer's indent.
 */
export function dropAt(
  listed: Row[],
  i: number,
  y: number,
  level: number,
): Drop & { depth: number } {
  const { node, depth, expanded } = listed[i] as Row;
  const container = node.type === "layer" || node.type === "group";
  if (container && y >= 0.25 && (expanded || y < 0.75)) return { zone: "onto", id: node.id, depth };
  if (y < (container ? 0.25 : 0.5)) return { zone: "above", id: node.id, depth };
  const at = Math.min(depth, Math.max(level, listed[i + 1]?.depth ?? 0));
  // The nearest row above at that depth or shallower is the ancestor whose contents end here.
  const below = at === depth ? node : listed.findLast((r, j) => j < i && r.depth <= at)?.node;
  return { zone: "below", id: (below ?? node).id, depth: at };
}

/**
 * The moves a Layers panel drag of `dragged` onto `drop` sends as one `reparent` Command (ADR-0075),
 * and whether any Node would change place; null when the drop is refused, so the panel shows no
 * indicator. The dragged Nodes, less those whose ancestor is dragged too, keep their panel order:
 * the topmost lands at the drop and each next one directly below it. A dragged Node in a locked
 * container stays, as code acting on the Selection leaves out what is locked (ADR-0012). Refused: a
 * target container locked, itself or through an ancestor, or outside the isolated Node `scope`; no
 * dragged Node left; and whatever core's reparent refuses, such as a Node into its own descendant
 * or a Layer into a Group. A hidden container takes a drop, and a Node's own lock or hiding does not
 * stop its move.
 */
export function dropMoves(
  doc: Document,
  dragged: string[],
  drop: Drop,
  scope: string | null,
): { moves: ReparentInput[]; moved: boolean } | null {
  const at = doc.nodes.get(drop.id);
  if (!at) return null;
  const parentId = drop.zone === "onto" ? at.id : at.parentId;
  const parent = doc.nodes.get(parentId ?? "");
  if (lockedIn(doc, parent)) return null;
  if (scope !== null && parentId !== scope && !(parent && inScope(doc, parent, scope))) return null;
  const set = new Set(dragged);
  const nodes = panelOrder(doc).filter((n) => {
    if (!set.has(n.id) || lockedIn(doc, doc.nodes.get(n.parentId ?? ""))) return false;
    for (let p = doc.nodes.get(n.parentId ?? ""); p; p = doc.nodes.get(p.parentId ?? "")) {
      if (set.has(p.id)) return false;
    }
    return true;
  });
  if (nodes.length === 0) return null;
  // The first lands directly above the nearest undragged sibling below the gap, else directly
  // below the nearest one above it, else on top; so the anchor is never a dragged Node.
  const first = slot(doc, drop, (n) => !set.has(n.id));
  const moves = nodes.map(
    (n, i): ReparentInput => ({
      nodeId: n.id,
      parentId,
      ...(i === 0 ? first : { before: (nodes[i - 1] as Node).id }),
    }),
  );
  try {
    const placed = reparentNodes({ ...doc, nodes: new Map(doc.nodes) }, moves).nodes;
    const moved = placed.some((n) => {
      const was = doc.nodes.get(n.id) as Node;
      return n.parentId !== was.parentId || n.index !== was.index;
    });
    return { moves, moved };
  } catch (e) {
    // Core's refusal (INVALID_PARENT and the like) is the backstop for every tree rule.
    if (e instanceof KalamoError) return null;
    throw e;
  }
}

/**
 * The `duplicate` Command's input for a Layers panel Alt-drag of `dragged` onto `drop` (ADR-0075):
 * copies of the Nodes a plain drag would move, as one block where it would land them. Null where
 * the move is refused, a drop into a dragged Node's own descendant too, though the originals stay.
 * Unlike a move, a copy to where the originals already are still lands there.
 */
export function dropCopies(
  doc: Document,
  dragged: string[],
  drop: Drop,
  scope: string | null,
): DuplicateInput | null {
  const plan = dropMoves(doc, dragged, drop, scope);
  if (!plan) return null;
  const { parentId } = plan.moves[0] as ReparentInput;
  // The originals stay, so any sibling can anchor the block.
  return {
    nodeIds: plan.moves.map((m) => m.nodeId),
    targetParentId: parentId,
    ...slot(doc, drop, () => true),
  };
}

/**
 * Where in its parent a gap `drop` lands: directly above the nearest sibling below the gap that
 * `anchors`, else directly below the nearest one above it, else on top, as a drop onto a container.
 */
function slot(
  doc: Document,
  drop: Drop,
  anchors: (n: Node) => boolean,
): Pick<ReparentInput, "before" | "after"> {
  const at = doc.nodes.get(drop.id) as Node;
  if (drop.zone === "onto") return {};
  const siblings = childrenOf(doc, at.parentId);
  const gap = siblings.indexOf(at) + (drop.zone === "above" ? 1 : 0);
  const below = siblings.slice(0, gap).findLast(anchors);
  const above = siblings.slice(gap).find(anchors);
  return below ? { after: below.id } : above ? { before: above.id } : {};
}

/** Every Node in the order the Layers panel lists them fully expanded: topmost first, depth first. */
function panelOrder(doc: Document): Node[] {
  const walk = (parentId: string | null): Node[] =>
    childrenOf(doc, parentId)
      .reverse()
      .flatMap((n) => [n, ...walk(n.id)]);
  return walk(null);
}
