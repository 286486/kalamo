import { assert, type Bounds, type Check } from "./mcp.ts";

const check: Check = async (call, docId, tools) => {
  assert(tools.includes("zibel_freehand_stroke"), "no zibel_freehand_stroke call");
  const { nodes: all } = (await call("zibel_node_query", { docId, limit: 1000 }))
    .structuredContent as { nodes: { id: string; type: string }[] };
  const shapes = all.filter((n) => n.type !== "layer" && n.type !== "group");
  assert(shapes.length === 1, `${shapes.length} shapes, want 1`);
  const { nodes } = (
    await call("zibel_node_get", { docId, nodeIds: [shapes[0]?.id], detail: "full" })
  ).structuredContent as {
    nodes: {
      type: string;
      d: string;
      closed: boolean;
      geometricBounds: Bounds;
      appearance: { fills: unknown[]; strokes: { color: string; width: number }[] };
    }[];
  };
  const [path] = nodes;
  assert(path?.type === "path" && !path.closed, `the shape is a ${path?.type}, want an open path`);
  const b = path.geometricBounds;
  const near = (a: number, want: number) => Math.abs(a - want) <= 5;
  assert(
    near(b.x, 50) && near(b.x + b.width, 350) && near(b.y, 150) && near(b.y + b.height, 250),
    `the path's bounds are ${JSON.stringify(b)}, want x 50 to 350 and y 150 to 250`,
  );
  // Sampled every 10 pt, the wave as a polyline has 30 segments; fitted at any Fidelity, 16 or fewer.
  const segments: string[] = path.d.match(/[LCQ]/g) ?? [];
  assert(
    segments.includes("C") && segments.length <= 20,
    `d has ${segments.length} segments (${[...new Set(segments)]}), want curves, at most 20`,
  );
  const { fills, strokes } = path.appearance;
  assert(
    fills.length === 0 &&
      strokes.length === 1 &&
      strokes[0]?.color.toUpperCase() === "#000000" &&
      strokes[0].width === 2,
    `the appearance is ${JSON.stringify(path.appearance)}`,
  );
};

export default check;
