import {
  assert,
  type Check,
  exportSvg,
  hex,
  leaves,
  n3,
  openSvg,
  type Setup,
  type SvgCheck,
} from "./mcp.ts";

const RED = "#E63946";
const BLUE = "#3565E8";
const TEAL = "#2A9D8F";
const CAPTION = "Six dots, one raised";

const dotAt = (i: number) => ({ x: 40 + 90 * (i - 1), y: 120 });

/** Six red dots and a caption at rev 2, then the other Actor's three edits; mine.svg is rev 2. */
export const setup: Setup = async (call, name, other) => {
  const { docId, defaultLayerId: parentId } = (
    await call("kalamo_doc_create", { name, artboards: [{ width: 600, height: 300 }] })
  ).structuredContent;
  const { createdIds } = (
    await call("kalamo_node_create", {
      docId,
      nodes: [
        ...Array.from({ length: 6 }, (_, k) => ({
          type: "ellipse",
          parentId,
          name: `Dot ${k + 1}`,
          ...dotAt(k + 1),
          width: 60,
          height: 60,
          appearance: { fills: [{ color: RED }] },
        })),
        { type: "text", parentId, name: "Caption", x: 40, y: 250, content: "Six dots" },
      ],
    })
  ).structuredContent;
  const mine = await exportSvg(call, docId);
  await other("kalamo_node_transform", {
    docId,
    nodeIds: [createdIds[2]],
    translate: { x: 0, y: -40 },
  });
  await other("kalamo_node_update", {
    docId,
    updates: [
      { nodeId: createdIds[4], patch: { appearance: { fills: [{ color: TEAL }] } } },
      { nodeId: createdIds[6], patch: { content: CAPTION } },
    ],
  });
  return { docId, files: { "mine.svg": mine, "drawing.svg": await exportSvg(call, docId) } };
};

const check: Check = async (call, docId) => {
  const all = await leaves(call, docId);
  const names = all.map((n) => n.name).sort();
  assert(
    names.join() === "Caption,Dot 1,Dot 2,Dot 3,Dot 4,Dot 5,Dot 6",
    `the Document holds ${names}, want Caption and Dot 1 to Dot 6`,
  );
  for (const n of all) {
    if (n.name === "Caption") {
      assert(n.content === CAPTION, `the caption reads "${n.content}", want "${CAPTION}"`);
      continue;
    }
    const i = Number(n.name.slice(4));
    const want = dotAt(i);
    if (i === 3) want.y -= 40;
    const fill = i === 3 ? RED : i === 5 ? TEAL : BLUE;
    const b = n.geometricBounds;
    assert(
      n.type === "ellipse" && n3(b.x) === want.x && n3(b.y) === want.y && n3(b.width) === 60,
      `${n.name} is a ${n.type} at ${JSON.stringify(b)}, want a 60 pt circle at (${want.x}, ${want.y})`,
    );
    assert(
      hex(n.appearance.fills[0]?.color) === fill,
      `${n.name} is ${JSON.stringify(n.appearance)}, want ${fill}`,
    );
  }
};

export default check;

export const svgCheck: SvgCheck = async (call, files) =>
  check(call, await openSvg(call, files["drawing.svg"]), []);
