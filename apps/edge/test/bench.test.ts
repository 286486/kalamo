import { describe, expect, it } from "vitest";
import edits, {
  setup as editsSetup,
  svgCheck as editsSvg,
} from "../../../fixtures/agent-benchmarks/edits.ts";
import fitTask from "../../../fixtures/agent-benchmarks/fit.md?raw";
import fit, { svgCheck as fitSvg, PARAGRAPH } from "../../../fixtures/agent-benchmarks/fit.ts";
import freehand from "../../../fixtures/agent-benchmarks/freehand.ts";
import grid, { svgCheck as gridSvg } from "../../../fixtures/agent-benchmarks/grid.ts";
import inkscape, {
  BADGE,
  setup as inkscapeSetup,
  svgCheck as inkscapeSvg,
} from "../../../fixtures/agent-benchmarks/inkscape.ts";
import labels, { svgCheck as labelsSvg } from "../../../fixtures/agent-benchmarks/labels.ts";
import type { Bounds, Call } from "../../../fixtures/agent-benchmarks/mcp.ts";
import person, {
  setup as personSetup,
  svgCheck as personSvg,
} from "../../../fixtures/agent-benchmarks/person.ts";
import placeTask from "../../../fixtures/agent-benchmarks/place.md?raw";
import place, {
  setup as placeSetup,
  svgCheck as placeSvg,
} from "../../../fixtures/agent-benchmarks/place.ts";
import transaction from "../../../fixtures/agent-benchmarks/transaction.ts";
import { call as rpcCall } from "./rpc.ts";

/** The benchmark assertions' Call, through the Worker; a failed call throws, as over HTTP. */
const as =
  (token: string): Call =>
  async (name, args) => {
    const result = await rpcCall(name, args, token);
    if (result.isError) throw new Error(`${name}: ${result.content[0]?.text}`);
    return result;
  };
const call = as("dev-token-a");
const other = as("dev-token-b");

const newDoc = async (width: number, height: number) =>
  (await call("kalamo_doc_create", { name: "Bench", artboards: [{ width, height }] }))
    .structuredContent as { docId: string; defaultLayerId: string };

const layer = async (docId: string, name: string) =>
  (await call("kalamo_node_create", { docId, nodes: [{ type: "layer", name }] })).structuredContent
    .createdIds[0] as string;

describe("grid", () => {
  const draw = async (count: number, inGroup = false) => {
    const { docId } = await newDoc(600, 600);
    let parentId = await layer(docId, "Grid");
    if (inGroup)
      parentId = (
        await call("kalamo_node_create", {
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
    await call("kalamo_node_create", { docId, nodes });
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

describe("freehand", () => {
  const points = Array.from({ length: 61 }, (_, k) => ({
    x: 50 + 5 * k,
    y: 200 - 50 * Math.sin((Math.PI * k) / 15),
  }));
  const appearance = { strokes: [{ color: "#000000", width: 2 }] };

  it("accepts the wave drawn with freehand_stroke", async () => {
    const { docId, defaultLayerId: parentId } = await newDoc(400, 400);
    await call("kalamo_freehand_stroke", { docId, parentId, points, tool: "pencil", appearance });
    await expect(freehand(call, docId, ["kalamo_freehand_stroke"])).resolves.toBeUndefined();
  });

  it("rejects the wave as a polyline from node_create", async () => {
    const { docId, defaultLayerId: parentId } = await newDoc(400, 400);
    const d = `M ${points.map((p) => `${p.x} ${p.y}`).join(" L ")}`;
    await call("kalamo_node_create", { docId, nodes: [{ type: "path", parentId, d, appearance }] });
    await expect(freehand(call, docId, ["kalamo_node_create"])).rejects.toThrow(
      "no kalamo_freehand_stroke",
    );
    await expect(freehand(call, docId, ["kalamo_freehand_stroke"])).rejects.toThrow("60 segments");
  });
});

describe("labels", () => {
  const draw = async (circleLabelX: number) => {
    const { docId, defaultLayerId: parentId } = await newDoc(600, 200);
    const text = (content: string, x: number) => ({ type: "text", parentId, x, y: 105, content });
    await call("kalamo_node_create", {
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
    (await call("kalamo_doc_outline", { docId, depth: 1 })).structuredContent.nodes.find(
      (l: { name: string }) => l.name === "Logo",
    ).id as string;

  it("accepts the SVG placed into Logo at (560, 150)", async () => {
    const docId = (await placeSetup(call, "Bench", other)).docId;
    const parentId = await logoLayer(docId);
    await call("kalamo_svg_import", { docId, svg, parentId, position: { x: 560, y: 150 } });
    await expect(place(call, docId, ["kalamo_svg_import"])).resolves.toBeUndefined();
  });

  it("rejects the SVG placed at the Artboard's centre", async () => {
    const docId = (await placeSetup(call, "Bench", other)).docId;
    await call("kalamo_svg_import", { docId, svg, parentId: await logoLayer(docId) });
    await expect(place(call, docId, ["kalamo_svg_import"])).rejects.toThrow("centre (400, 300)");
  });

  it("accepts the SVG placed at the centre, then moved to (560, 150)", async () => {
    const docId = (await placeSetup(call, "Bench", other)).docId;
    const placed = await call("kalamo_svg_import", {
      docId,
      svg,
      parentId: await logoLayer(docId),
    });
    const nodeIds = placed.structuredContent.createdIds.slice(0, 1);
    await call("kalamo_node_transform", { docId, nodeIds, translate: { x: 160, y: -150 } });
    await expect(place(call, docId, ["kalamo_svg_import"])).resolves.toBeUndefined();
  });

  it("rejects the Group rebuilt without Place", async () => {
    const docId = (await placeSetup(call, "Bench", other)).docId;
    const rect = (x: number, y: number, width: number, height: number) => ({
      type: "rect",
      x,
      y,
      width,
      height,
    });
    await call("kalamo_node_create", {
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
    await expect(place(call, docId, ["kalamo_svg_import"])).rejects.toThrow("not Place");
  });

  it("rejects a change to the background", async () => {
    const docId = (await placeSetup(call, "Bench", other)).docId;
    const parentId = await logoLayer(docId);
    await call("kalamo_svg_import", { docId, svg, parentId, position: { x: 560, y: 150 } });
    const { nodes } = (await call("kalamo_node_query", { docId, types: ["rect"] }))
      .structuredContent;
    const paper = nodes.find((n: { geometricBounds: Bounds }) => n.geometricBounds.width === 800);
    await call("kalamo_node_update", {
      docId,
      updates: [{ nodeId: paper.id, patch: { name: "Paper" } }],
    });
    await expect(place(call, docId, ["kalamo_svg_import"])).rejects.toThrow("changes more than");
  });

  it("rejects an Agent that also calls node_create", async () => {
    const docId = (await placeSetup(call, "Bench", other)).docId;
    const parentId = await logoLayer(docId);
    await call("kalamo_svg_import", { docId, svg, parentId, position: { x: 560, y: 150 } });
    const tools = ["kalamo_svg_import", "kalamo_node_create"];
    await expect(place(call, docId, tools)).rejects.toThrow("kalamo_node_create");
  });
});

describe("transaction", () => {
  const tools = [
    "kalamo_doc_create",
    "kalamo_tx_begin",
    "kalamo_node_create",
    "kalamo_node_create",
    "kalamo_tx_commit",
    "kalamo_render",
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
    const { txId } = (await call("kalamo_tx_begin", { docId })).structuredContent;
    await call("kalamo_node_create", { docId, txId, nodes: [body, roof] });
    await call("kalamo_node_create", { docId, txId, nodes: rest });
    await call("kalamo_tx_commit", { docId, txId });
    await expect(transaction(call, docId, tools)).resolves.toBeUndefined();
  });

  it("rejects two commits", async () => {
    const { docId, defaultLayerId } = await newDoc(300, 300);
    const [body, ...rest] = house(defaultLayerId);
    await call("kalamo_node_create", { docId, nodes: [body] });
    await call("kalamo_node_create", { docId, nodes: rest });
    await expect(transaction(call, docId, tools)).rejects.toThrow("2 changes after rev 1");
  });

  it("rejects a render only before the commit", async () => {
    const { docId, defaultLayerId } = await newDoc(300, 300);
    const { txId } = (await call("kalamo_tx_begin", { docId })).structuredContent;
    await call("kalamo_node_create", { docId, txId, nodes: house(defaultLayerId) });
    await call("kalamo_tx_commit", { docId, txId });
    const early = [
      "kalamo_tx_begin",
      "kalamo_node_create",
      "kalamo_node_create",
      "kalamo_render",
      "kalamo_tx_commit",
    ];
    await expect(transaction(call, docId, early)).rejects.toThrow("no kalamo_render after");
  });
});

/** A Document as the SVG file a write-SVG session would leave. */
const exported = async (docId: string) =>
  (await call("kalamo_export", { docId, format: "svg" })).content[0]?.text as string;

const idsNamed = async (docId: string, nameRegex: string) =>
  (await call("kalamo_node_query", { docId, nameRegex, limit: 1000 })).structuredContent.nodes.map(
    (n: { id: string }) => n.id,
  ) as string[];

describe("the SVG arms of grid, labels and place", () => {
  it("accepts a grid written in a Grid layer", async () => {
    const cells = Array.from(
      { length: 100 },
      (_, k) =>
        `<rect x="${50 + 50 * (k % 10)}" y="${50 + 50 * Math.floor(k / 10)}" width="40" height="40" fill="#3366cc"/>`,
    );
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="600" height="600" viewBox="0 0 600 600"><g inkscape:groupmode="layer" inkscape:label="Grid">${cells.join("")}</g></svg>`;
    await expect(gridSvg(call, { "out.svg": svg })).resolves.toBeUndefined();
    await expect(gridSvg(call, {})).rejects.toThrow("no such SVG file");
  });

  it("accepts labels written beside their shapes", async () => {
    const label = (x: number, s: string) =>
      `<text x="${x}" y="106" font-family="Source Sans 3" font-size="16">${s}</text>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200" viewBox="0 0 600 200"><circle cx="50" cy="100" r="30" fill="red"/>${label(90, "Circle")}<rect x="200" y="70" width="60" height="60" fill="green"/>${label(270, "Square")}<polygon points="430,65 465,125 395,125" fill="blue"/>${label(475, "Triangle")}</svg>`;
    await expect(labelsSvg(call, { "out.svg": svg })).resolves.toBeUndefined();
  });

  it("accepts the logo placed in poster.svg, and rejects it at the Artboard's centre", async () => {
    const svg = placeTask.match(/```svg\n([\s\S]*?)```/)?.[1] ?? "";
    const place = async (position?: { x: number; y: number }) => {
      const { docId } = await placeSetup(call, "Bench", other);
      const { nodes } = (await call("kalamo_doc_outline", { docId, depth: 1 })).structuredContent;
      const parentId = nodes.find((l: { name: string }) => l.name === "Logo").id;
      await call("kalamo_svg_import", { docId, svg, parentId, position });
      return { "poster.svg": await exported(docId) };
    };
    await expect(placeSvg(call, await place({ x: 560, y: 150 }))).resolves.toBeUndefined();
    await expect(placeSvg(call, await place())).rejects.toThrow("centre (400, 300)");
    const { files } = await placeSetup(call, "Bench", other);
    await expect(placeSvg(call, files ?? {})).rejects.toThrow("Logo holds 0 shapes");
  });
});

describe("edits", () => {
  const edit = async (widen: boolean) => {
    const { docId } = await editsSetup(call, "Bench", other);
    const sold = await idsNamed(docId, "^C[5-9]$");
    await call("kalamo_node_update", {
      docId,
      updates: sold.map((nodeId) => ({
        nodeId,
        patch: { appearance: { fills: [{ color: "#9AA0A6" }] } },
      })),
    });
    await call("kalamo_node_delete", { docId, nodeIds: await idsNamed(docId, "^Row J$") });
    if (widen)
      await call("kalamo_node_transform", {
        docId,
        nodeIds: await idsNamed(docId, "^[A-I](1[1-9]|20)$"),
        translate: { x: 30, y: 0 },
      });
    return docId;
  };

  it("accepts the three edits, in Kalamo and as plan.svg", async () => {
    const docId = await edit(true);
    await expect(edits(call, docId, [])).resolves.toBeUndefined();
    await expect(editsSvg(call, { "plan.svg": await exported(docId) })).resolves.toBeUndefined();
  });

  it("rejects the plan with the aisle as it was", async () => {
    await expect(edits(call, await edit(false), [])).rejects.toThrow("A11 is at");
  });

  it("rejects plan.svg untouched", async () => {
    const { files } = await editsSetup(call, "Bench", other);
    await expect(editsSvg(call, files ?? {})).rejects.toThrow("200 shapes");
  });
});

describe("person", () => {
  const recolour = async (pattern: string) => {
    const { docId } = await personSetup(call, "Bench", other);
    await call("kalamo_node_update", {
      docId,
      updates: (await idsNamed(docId, pattern)).map((nodeId) => ({
        nodeId,
        patch: { appearance: { fills: [{ color: "#3565E8" }] } },
      })),
    });
    return docId;
  };

  it("accepts the dots the other Actor left alone recoloured, in Kalamo and as drawing.svg", async () => {
    const docId = await recolour("^Dot [1246]$");
    await expect(person(call, docId, [])).resolves.toBeUndefined();
    await expect(
      personSvg(call, { "drawing.svg": await exported(docId) }),
    ).resolves.toBeUndefined();
  });

  it("rejects the moved dot recoloured too", async () => {
    await expect(person(call, await recolour("^Dot [12346]$"), [])).rejects.toThrow("Dot 3 is");
  });

  it("rejects mine.svg recoloured over the other Actor's drawing.svg", async () => {
    const { files } = await personSetup(call, "Bench", other);
    const svg = files?.["mine.svg"]?.replace(/#E63946/gi, "#3565E8") ?? "";
    await expect(personSvg(call, { "drawing.svg": svg })).rejects.toThrow("Dot 3 is");
  });
});

describe("inkscape", () => {
  it("accepts the Badge moved and its Star recoloured in Kalamo", async () => {
    const { docId } = await inkscapeSetup(call, "Bench", other);
    const [badge] = (await call("kalamo_node_query", { docId, nameRegex: "^Badge$" }))
      .structuredContent.nodes as { id: string; geometricBounds: Bounds }[];
    const b = badge?.geometricBounds as Bounds;
    await call("kalamo_node_transform", {
      docId,
      nodeIds: [badge?.id],
      translate: { x: 450 - b.x - b.width / 2, y: 120 - b.y - b.height / 2 },
    });
    await call("kalamo_node_update", {
      docId,
      updates: [
        {
          nodeId: (await idsNamed(docId, "^Star$"))[0],
          patch: { appearance: { fills: [{ color: "#3565E8" }] } },
        },
      ],
    });
    await expect(inkscape(call, docId, [])).resolves.toBeUndefined();
  });

  // The Badge's centre is at (48, 46) mm; (450, 120) pt is (158.75, 42.333) mm.
  const moved = (e: string, f: string) =>
    BADGE.replace("matrix(0.8,0,0,0.8,4,6)", `matrix(0.8,0,0,0.8,${e},${f})`).replace(
      "fill:#ffd23f",
      "fill:#3565e8",
    );

  it("accepts badge.svg edited in millimetres", async () => {
    await expect(
      inkscapeSvg(call, { "badge.svg": moved("114.75", "2.333") }),
    ).resolves.toBeUndefined();
  });

  it("rejects badge.svg moved as if its units were pt", async () => {
    await expect(inkscapeSvg(call, { "badge.svg": moved("306", "-0.0") })).rejects.toThrow(
      "the Badge's centre",
    );
  });

  it("rejects badge.svg with the Band recoloured too", async () => {
    const svg = moved("114.75", "2.333").replace("fill:#29335c", "fill:#3565e8");
    await expect(inkscapeSvg(call, { "badge.svg": svg })).rejects.toThrow("Node 1 is");
  });
});

describe("fit", () => {
  it("asks for the paragraph the check reads, in both arms", () => {
    expect(fitTask.split(PARAGRAPH)).toHaveLength(3);
  });

  const framed = async (spare: number) => {
    const { docId, defaultLayerId: parentId } = await newDoc(600, 800);
    const text = {
      type: "text",
      kind: "area",
      parentId,
      x: 140,
      y: 120,
      width: 320,
      height: 400,
      content: PARAGRAPH,
      fontFamily: "Source Sans 3",
      fontSize: 16,
      alignment: "justify",
    };
    const { lineBounds, createdIds } = (await call("kalamo_node_create", { docId, nodes: [text] }))
      .structuredContent;
    const lines = lineBounds[createdIds[0]] as Bounds;
    await call("kalamo_node_create", {
      docId,
      nodes: [
        {
          type: "rect",
          parentId,
          x: 140,
          y: 120,
          width: 320,
          height: lines.y + lines.height - 120 + spare,
          appearance: { fills: [], strokes: [{ color: "#3d3d44", width: 1 }] },
        },
      ],
    });
    return docId;
  };

  it("accepts the rect around Area Type's lines, in Kalamo and as out.svg", async () => {
    const docId = await framed(4);
    await expect(fit(call, docId, [])).resolves.toBeUndefined();
    await expect(fitSvg(call, { "out.svg": await exported(docId) })).resolves.toBeUndefined();
  });

  it("rejects a rect two lines short, or three lines too tall", async () => {
    await expect(fit(call, await framed(-40), [])).rejects.toThrow("reach past");
    await expect(fit(call, await framed(60), [])).rejects.toThrow("60.0 pt below the last line");
  });

  it("accepts the paragraph written as one Point Type per line", async () => {
    const words = PARAGRAPH.split(" ");
    const lines = Array.from({ length: Math.ceil(words.length / 6) }, (_, i) =>
      words.slice(6 * i, 6 * i + 6).join(" "),
    );
    const texts = lines.map(
      (l, i) =>
        `<text x="140" y="${136 + 20 * i}" font-family="'Source Sans 3'" font-size="16">${l}</text>`,
    );
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800">${texts.join("")}<rect x="140" y="120" width="320" height="${20 * lines.length + 4}" fill="none" stroke="#3D3D44" stroke-width="1"/></svg>`;
    await expect(fitSvg(call, { "out.svg": svg })).resolves.toBeUndefined();
  });
});
