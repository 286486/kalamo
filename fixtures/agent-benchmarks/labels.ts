import { assert, type Bounds, type Check } from "./mcp.ts";

const named: Record<string, string[]> = {
  Circle: ["ellipse"],
  Square: ["rect"],
  Triangle: ["polygon", "path"],
};

const overlaps = (a: Bounds, b: Bounds) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const check: Check = async (call, docId) => {
  const { nodes: all } = (await call("kalamo_node_query", { docId, limit: 1000 }))
    .structuredContent as { nodes: { id: string; type: string; geometricBounds: Bounds }[] };
  const leaves = all.filter((n) => n.type !== "layer" && n.type !== "group");
  const shapes = leaves.filter((n) => n.type !== "text");
  const texts = leaves.filter((n) => n.type === "text");
  assert(
    texts.length === 3 && shapes.length === 3,
    `${texts.length} texts and ${shapes.length} other shapes; want 3 and 3`,
  );

  const { nodes: full } = (
    await call("kalamo_node_get", { docId, nodeIds: texts.map((t) => t.id), detail: "full" })
  ).structuredContent as { nodes: { content: string; geometricBounds: Bounds }[] };
  const contents = full.map((t) => t.content).sort();
  assert(
    contents.join() === "Circle,Square,Triangle",
    `the labels read ${JSON.stringify(contents)}`,
  );

  for (const { content, geometricBounds: t } of full) {
    const hit = shapes.find((s) => overlaps(s.geometricBounds, t));
    assert(!hit, `"${content}" overlaps the ${hit?.type}`);
    const left = shapes
      .filter((s) => s.geometricBounds.x + s.geometricBounds.width <= t.x)
      .sort((a, b) => b.geometricBounds.x - a.geometricBounds.x)[0];
    assert(left, `no shape left of "${content}"`);
    const s = left.geometricBounds;
    assert(named[content]?.includes(left.type), `"${content}" is beside the ${left.type}`);
    const gap = t.x - (s.x + s.width);
    assert(gap <= 40, `"${content}" is ${gap} pt right of its shape, want at most 40`);
    assert(
      t.y < s.y + s.height && s.y < t.y + t.height,
      `"${content}" is not level with its ${left.type}`,
    );
  }

  const svg = (await call("kalamo_export", { docId, format: "svg" })).content[0]?.text ?? "";
  const count = svg.split("<text").length - 1;
  assert(count === 3, `the SVG export has ${count} <text>, want 3`);
};

export default check;
