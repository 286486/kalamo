import { describe, expect, it } from "vitest";
import grid from "../../../fixtures/agent-benchmarks/grid.ts";
import labels from "../../../fixtures/agent-benchmarks/labels.ts";
import type { Bounds, Call } from "../../../fixtures/agent-benchmarks/mcp.ts";
import placeTask from "../../../fixtures/agent-benchmarks/place.md?raw";
import place, { setup as placeSetup } from "../../../fixtures/agent-benchmarks/place.ts";
import transaction from "../../../fixtures/agent-benchmarks/transaction.ts";
import { call as rpcCall } from "./rpc.ts";

/** The benchmark assertions' Call, through the Worker; a failed call throws, as over HTTP. */
const call: Call = async (name, args) => {
  const result = await rpcCall(name, args);
  if (result.isError) throw new Error(`${name}: ${result.content[0]?.text}`);
  return result;
};

const newDoc = async (width: number, height: number) =>
  (await call("zibel_doc_create", { name: "Bench", artboards: [{ width, height }] }))
    .structuredContent as { docId: string; defaultLayerId: string };

const layer = async (docId: string, name: string) =>
  (await call("zibel_node_create", { docId, nodes: [{ type: "layer", name }] })).structuredContent
    .createdIds[0] as string;

describe("grid", () => {
  const draw = async (count: number, inGroup = false) => {
    const { docId } = await newDoc(600, 600);
    let parentId = await layer(docId, "Grid");
    if (inGroup)
      parentId = (
        await call("zibel_node_create", {
          docId,
          nodes: [{ type: "group", parentId, name: "Cells" }],
        })
      ).structuredContent.createdIds[0];
    const nodes = Array.from({ length: count }, (_, k) => ({
      type: "rect",
      parentId,
      x: 50 + 50 * (k % 10),
      y: 50 + 50 * Math.floor(k / 10),
      width: 40,
      height: 40,
      appearance: { fills: [{ color: "#3366cc" }] },
    }));
    await call("zibel_node_create", { docId, nodes });
    return docId;
  };

  it("accepts 100 rects in the Grid Layer", async () => {
    await expect(grid(call, await draw(100), [])).resolves.toBeUndefined();
  });

  it("accepts the rects inside a Group in the Grid Layer", async () => {
    await expect(grid(call, await draw(100, true), [])).resolves.toBeUndefined();
  });

  it("rejects 99 rects", async () => {
    await expect(grid(call, await draw(99), [])).rejects.toThrow("99 rects");
  });
});

describe("labels", () => {
  const draw = async (circleLabelX: number) => {
    const { docId, defaultLayerId: parentId } = await newDoc(600, 200);
    const text = (content: string, x: number) => ({ type: "text", parentId, x, y: 105, content });
    await call("zibel_node_create", {
      docId,
      nodes: [
        { type: "ellipse", parentId, x: 20, y: 70, width: 60, height: 60 },
        { type: "rect", parentId, x: 200, y: 70, width: 60, height: 60 },
        { type: "polygon", parentId, cx: 430, cy: 100, radius: 35, sides: 3 },
        text("Circle", circleLabelX),
        text("Square", 270),
        text("Triangle", 470),
      ],
    });
    return docId;
  };

  it("accepts a label right of each shape", async () => {
    await expect(labels(call, await draw(90), [])).resolves.toBeUndefined();
  });

  it("rejects a label overlapping its shape", async () => {
    await expect(labels(call, await draw(40), [])).rejects.toThrow('"Circle" overlaps the ellipse');
  });
});

describe("place", () => {
  const svg = placeTask.match(/```svg\n([\s\S]*?)```/)?.[1] ?? "";
  const logoLayer = async (docId: string) =>
    (await call("zibel_doc_outline", { docId, depth: 1 })).structuredContent.nodes.find(
      (l: { name: string }) => l.name === "Logo",
    ).id as string;

  it("accepts the SVG placed into Logo at (560, 150)", async () => {
    const docId = await placeSetup(call, "Bench");
    const parentId = await logoLayer(docId);
    await call("zibel_svg_import", { docId, svg, parentId, position: { x: 560, y: 150 } });
    await expect(place(call, docId, ["zibel_svg_import"])).resolves.toBeUndefined();
  });

  it("rejects the SVG placed at the Artboard's centre", async () => {
    const docId = await placeSetup(call, "Bench");
    await call("zibel_svg_import", { docId, svg, parentId: await logoLayer(docId) });
    await expect(place(call, docId, ["zibel_svg_import"])).rejects.toThrow("centre (400, 300)");
  });

  it("accepts the SVG placed at the centre, then moved to (560, 150)", async () => {
    const docId = await placeSetup(call, "Bench");
    const placed = await call("zibel_svg_import", { docId, svg, parentId: await logoLayer(docId) });
    const nodeIds = placed.structuredContent.createdIds.slice(0, 1);
    await call("zibel_node_transform", { docId, nodeIds, translate: { x: 160, y: -150 } });
    await expect(place(call, docId, ["zibel_svg_import"])).resolves.toBeUndefined();
  });

  it("rejects the Group rebuilt without Place", async () => {
    const docId = await placeSetup(call, "Bench");
    const rect = (x: number, y: number, width: number, height: number) => ({
      type: "rect",
      x,
      y,
      width,
      height,
    });
    await call("zibel_node_create", {
      docId,
      nodes: [
        {
          type: "group",
          parentId: await logoLayer(docId),
          children: [
            {
              type: "group",
              name: "Mark",
              children: [rect(450, 100, 100, 100), rect(475, 125, 50, 50)],
            },
            { type: "group", name: "Wordmark", children: [rect(570, 135, 100, 30)] },
          ],
        },
      ],
    });
    await expect(place(call, docId, ["zibel_svg_import"])).rejects.toThrow("not Place");
  });

  it("rejects a change to the background", async () => {
    const docId = await placeSetup(call, "Bench");
    const parentId = await logoLayer(docId);
    await call("zibel_svg_import", { docId, svg, parentId, position: { x: 560, y: 150 } });
    const { nodes } = (await call("zibel_node_query", { docId, types: ["rect"] }))
      .structuredContent;
    const paper = nodes.find((n: { geometricBounds: Bounds }) => n.geometricBounds.width === 800);
    await call("zibel_node_update", {
      docId,
      updates: [{ nodeId: paper.id, patch: { name: "Paper" } }],
    });
    await expect(place(call, docId, ["zibel_svg_import"])).rejects.toThrow("changes more than");
  });

  it("rejects an Agent that also calls node_create", async () => {
    const docId = await placeSetup(call, "Bench");
    const parentId = await logoLayer(docId);
    await call("zibel_svg_import", { docId, svg, parentId, position: { x: 560, y: 150 } });
    const tools = ["zibel_svg_import", "zibel_node_create"];
    await expect(place(call, docId, tools)).rejects.toThrow("zibel_node_create");
  });
});

describe("transaction", () => {
  const tools = [
    "zibel_doc_create",
    "zibel_tx_begin",
    "zibel_node_create",
    "zibel_node_create",
    "zibel_tx_commit",
    "zibel_render",
  ];
  const house = (parentId: string) => [
    { type: "rect", parentId, x: 50, y: 120, width: 200, height: 150 },
    { type: "path", parentId, d: "M 40 120 L 150 40 L 260 120 Z" },
    { type: "rect", parentId, x: 130, y: 200, width: 40, height: 70 },
    { type: "rect", parentId, x: 70, y: 150, width: 40, height: 30 },
    { type: "rect", parentId, x: 190, y: 150, width: 40, height: 30 },
  ];

  it("accepts one Transaction with five shapes", async () => {
    const { docId, defaultLayerId } = await newDoc(300, 300);
    const [body, roof, ...rest] = house(defaultLayerId);
    const { txId } = (await call("zibel_tx_begin", { docId })).structuredContent;
    await call("zibel_node_create", { docId, txId, nodes: [body, roof] });
    await call("zibel_node_create", { docId, txId, nodes: rest });
    await call("zibel_tx_commit", { docId, txId });
    await expect(transaction(call, docId, tools)).resolves.toBeUndefined();
  });

  it("rejects two commits", async () => {
    const { docId, defaultLayerId } = await newDoc(300, 300);
    const [body, ...rest] = house(defaultLayerId);
    await call("zibel_node_create", { docId, nodes: [body] });
    await call("zibel_node_create", { docId, nodes: rest });
    await expect(transaction(call, docId, tools)).rejects.toThrow("2 changes after rev 1");
  });

  it("rejects a render only before the commit", async () => {
    const { docId, defaultLayerId } = await newDoc(300, 300);
    const { txId } = (await call("zibel_tx_begin", { docId })).structuredContent;
    await call("zibel_node_create", { docId, txId, nodes: house(defaultLayerId) });
    await call("zibel_tx_commit", { docId, txId });
    const early = [
      "zibel_tx_begin",
      "zibel_node_create",
      "zibel_node_create",
      "zibel_render",
      "zibel_tx_commit",
    ];
    await expect(transaction(call, docId, early)).rejects.toThrow("no zibel_render after");
  });
});
