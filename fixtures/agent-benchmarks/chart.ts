import { assert, type Bounds, type Check } from "./mcp.ts";

const SALES: Record<string, number[]> = {
  north: [120, 150, 170, 160],
  south: [80, 95, 110, 125],
  west: [100, 90, 130, 140],
};

interface Entry {
  id: string;
  type: string;
  name: string;
  bounds: Bounds | null;
  children?: Entry[];
}

const check: Check = async (call, docId) => {
  const { nodes: graphs } = (
    await call("kalamo_node_query", { docId, types: ["group"], nameRegex: "^Column Graph$" })
  ).structuredContent as { nodes: { id: string }[] };
  assert(graphs.length === 1, `${graphs.length} Groups named Column Graph, want 1`);
  const { nodes } = (await call("kalamo_doc_outline", { docId, rootId: graphs[0]?.id, depth: 2 }))
    .structuredContent as { nodes: Entry[] };

  const ratios: number[] = [];
  for (const [region, values] of Object.entries(SALES)) {
    const series = nodes.filter((n) => n.type === "group" && n.name.toLowerCase() === region);
    assert(series.length === 1, `${series.length} Groups named ${region}, want 1`);
    const rects = (series[0]?.children ?? []).filter((c) => c.type === "rect");
    const names = rects.map((r) => r.name).sort();
    assert(
      names.join() === "Q1,Q2,Q3,Q4",
      `${region} holds rects ${JSON.stringify(names)}, want Q1 to Q4`,
    );
    for (const r of rects) {
      const value = values[Number(r.name.slice(1)) - 1] as number;
      ratios.push((r.bounds?.height ?? 0) / value);
    }
  }
  const [lo, hi] = [Math.min(...ratios), Math.max(...ratios)];
  assert(
    lo > 0 && hi / lo <= 1.01,
    `bar height per value runs from ${lo} to ${hi}, want within 1%`,
  );
};

export default check;
