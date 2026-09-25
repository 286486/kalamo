import { assert, type Bounds, type Check, type Setup } from "./mcp.ts";

// place.md's SVG: its artwork spans (10, 10)–(230, 110).
const WIDTH = 220;
const HEIGHT = 100;
const CENTRE = { x: 560, y: 150 };

/** The Document the prompt calls existing: a background rect in Layer 1, and an empty Logo Layer. */
export const setup: Setup = async (call, name) => {
  const { docId, defaultLayerId } = (
    await call("zibel_doc_create", { name, artboards: [{ width: 800, height: 600 }] })
  ).structuredContent;
  await call("zibel_node_create", {
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
  return docId;
};

interface Outline {
  id: string;
  type: string;
  name: string;
  childCount: number;
  children?: Outline[];
}

const check: Check = async (call, docId, tools) => {
  assert(tools.includes("zibel_svg_import"), "the Agent never called zibel_svg_import");
  assert(!tools.includes("zibel_node_create"), "the Agent called zibel_node_create");
  // setup commits rev 2.
  const { changes } = (await call("zibel_doc_changes", { docId, sinceRev: 2 })).structuredContent;
  assert(changes.length === 1, `${changes.length} changes after the setup, want 1`);

  const { nodes: layers } = (await call("zibel_doc_outline", { docId, depth: 1 }))
    .structuredContent as { nodes: Outline[] };
  const logo = layers.find((l) => l.name === "Logo");
  assert(logo, `no top-level Layer named "Logo" (found ${layers.map((l) => l.name)})`);
  const { nodes: placed } = (await call("zibel_doc_outline", { docId, rootId: logo.id, depth: 2 }))
    .structuredContent as { nodes: Outline[] };
  const group = placed[0];
  assert(
    placed.length === 1 && group?.type === "group",
    `Logo holds ${placed.map((n) => n.type)}, want one group`,
  );
  const layersOf = (group.children ?? []).map((c) => `${c.type} ${c.name} ${c.childCount}`);
  assert(
    layersOf.join() === "group Mark 2,group Wordmark 1",
    `the Group holds ${layersOf}, want group Mark 2, group Wordmark 1`,
  );

  const b = (await call("zibel_node_get", { docId, nodeIds: [group.id] })).structuredContent
    .nodes[0].geometricBounds as Bounds;
  const near = (a: number, want: number) => Math.abs(a - want) < 0.01;
  assert(near(b.width, WIDTH) && near(b.height, HEIGHT), `the Group is ${b.width}×${b.height}`);
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  assert(
    near(cx, CENTRE.x) && near(cy, CENTRE.y),
    `the Group's centre (${cx}, ${cy}), want (${CENTRE.x}, ${CENTRE.y})`,
  );
};

export default check;
