import {
  assert,
  type Bounds,
  type Check,
  exportSvg,
  hex,
  leaves,
  n3,
  openSvg,
  type Setup,
  type SvgCheck,
} from "./mcp.ts";

// place.md's SVG: its artwork spans (10, 10)–(230, 110).
const WIDTH = 220;
const HEIGHT = 100;
const CENTRE = { x: 560, y: 150 };
// setup's doc_create and node_create.
const SETUP_REV = 2;

/** The Document the prompt calls existing: a background rect in Layer 1, and an empty Logo Layer;
 * the SVG arm's poster.svg is its export. */
export const setup: Setup = async (call, name) => {
  const { docId, defaultLayerId } = (
    await call("kalamo_doc_create", { name, artboards: [{ width: 800, height: 600 }] })
  ).structuredContent;
  await call("kalamo_node_create", {
    docId,
    nodes: [
      {
        type: "rect",
        parentId: defaultLayerId,
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        appearance: { fills: [{ color: "#F4F1EA" }] },
      },
      { type: "layer", name: "Logo" },
    ],
  });
  return { docId, files: { "poster.svg": await exportSvg(call, docId) } };
};

interface OutlineNode {
  id: string;
  type: string;
  name: string;
  childCount: number;
  children?: OutlineNode[];
}

interface Change {
  summary: string;
  createdIds: string[];
  updatedIds: string[];
  deletedIds: string[];
}

const check: Check = async (call, docId, tools) => {
  assert(tools.includes("kalamo_svg_import"), "the Agent never called kalamo_svg_import");
  assert(!tools.includes("kalamo_node_create"), "the Agent called kalamo_node_create");

  const { nodes: layers } = (await call("kalamo_doc_outline", { docId, depth: 1 }))
    .structuredContent as { nodes: OutlineNode[] };
  const logo = layers.find((l) => l.name === "Logo");
  assert(logo, `no top-level Layer named "Logo" (found ${layers.map((l) => l.name)})`);
  const { nodes: placed } = (await call("kalamo_doc_outline", { docId, rootId: logo.id, depth: 2 }))
    .structuredContent as { nodes: OutlineNode[] };
  const group = placed[0];
  assert(
    placed.length === 1 && group?.type === "group",
    `Logo holds ${placed.map((n) => n.type)}, want one group`,
  );
  const children = (group.children ?? []).map((c) => `${c.type} ${c.name} ${c.childCount}`);
  assert(
    children.join() === "group Mark 2,group Wordmark 1",
    `the Group holds ${children}, want group Mark 2, group Wordmark 1`,
  );

  // Placing, then moving what was placed, is fine; a rebuild or any other edit is not.
  const { changes } = (await call("kalamo_doc_changes", { docId, sinceRev: SETUP_REV }))
    .structuredContent as { changes: Change[] };
  const place = changes.find((c) => c.createdIds[0] === group.id);
  assert(place, "no change after the setup created the Group");
  assert(place.summary.startsWith("Place"), `the Group came from "${place.summary}", not Place`);
  const ours = new Set(place.createdIds);
  for (const c of changes)
    assert(
      c.deletedIds.length === 0 && [...c.createdIds, ...c.updatedIds].every((id) => ours.has(id)),
      `"${c.summary}" changes more than the placed Group`,
    );

  const b = (await call("kalamo_node_get", { docId, nodeIds: [group.id] })).structuredContent
    .nodes[0].geometricBounds as Bounds;
  placedAt(b, "the Group");
};

function placedAt(b: Bounds, what: string) {
  assert(n3(b.width) === WIDTH && n3(b.height) === HEIGHT, `${what} is ${b.width}×${b.height}`);
  const cx = n3(b.x + b.width / 2);
  const cy = n3(b.y + b.height / 2);
  assert(
    cx === CENTRE.x && cy === CENTRE.y,
    `${what}'s centre (${cx}, ${cy}), want (${CENTRE.x}, ${CENTRE.y})`,
  );
}

/** poster.svg, opened in Kalamo: the background as it was, and the logo's three shapes in Logo. */
export const svgCheck: SvgCheck = async (call, files) => {
  const docId = await openSvg(call, files["poster.svg"]);
  const { nodes: layers } = (await call("kalamo_doc_outline", { docId, depth: 1 }))
    .structuredContent as { nodes: OutlineNode[] };
  const logo = layers.find((l) => l.name === "Logo");
  assert(logo, `no top-level Layer named "Logo" (found ${layers.map((l) => l.name)})`);
  const all = await leaves(call, docId);
  const parents = new Map<string, string | null>();
  for (const n of (await call("kalamo_node_query", { docId, limit: 1000 })).structuredContent
    .nodes as { id: string; parentId: string | null }[])
    parents.set(n.id, n.parentId);
  const under = (id: string | null | undefined): boolean =>
    id === logo.id || (id != null && under(parents.get(id)));
  const logoShapes = all.filter((n) => under(n.parentId));
  const rest = all.filter((n) => !under(n.parentId));
  assert(logoShapes.length === 3, `Logo holds ${logoShapes.length} shapes, want 3`);
  const [paper] = rest;
  assert(
    rest.length === 1 &&
      paper?.geometricBounds.width === 800 &&
      paper.geometricBounds.height === 600 &&
      hex(paper.appearance.fills[0]?.color) === "#F4F1EA",
    `outside Logo the Document holds ${rest.map((n) => n.type)}, want the background as it was`,
  );
  const xs = logoShapes.flatMap(({ geometricBounds: g }) => [g.x, g.x + g.width]);
  const ys = logoShapes.flatMap(({ geometricBounds: g }) => [g.y, g.y + g.height]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  placedAt({ x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }, "the logo");
};

export default check;
