import {
  assert,
  type Bounds,
  type Call,
  type Check,
  hex,
  type Leaf,
  leaves,
  openSvg,
  type SvgCheck,
} from "./mcp.ts";

export const PARAGRAPH =
  "Kalamo is a vector editor that runs in the browser. AI agents draw on it through the Model Context Protocol, and people edit the very same document on an Illustrator-style canvas. Whatever an agent makes stays as paths, shapes and text, never as a flat picture, so anyone can pick up a curve, drag an anchor, retype a heading or change a colour and keep working by hand. When the person is done, the agent can read back exactly what changed and carry on from there, without redrawing the whole page or undoing the edits a person made along the way.";

/** How far the rect's bottom may lie below the last line's: a 16 pt line's leading and a little. */
const SLACK = 24;
const near = (a: number, b: number) => Math.abs(a - b) <= 1;

/** The bounds of a text's lines as Kalamo lays them out: Point Type's are its bounds; Area Type's
 * are its receipt's lineBounds (ADR-0089), read from an update rolled back. */
async function linesOf(call: Call, docId: string, t: Leaf): Promise<Bounds | null> {
  if (t.kind !== "area") return t.geometricBounds;
  const { txId } = (await call("kalamo_tx_begin", { docId })).structuredContent;
  try {
    const receipt = (
      await call("kalamo_node_update", {
        docId,
        txId,
        updates: [{ nodeId: t.id, patch: { content: t.content } }],
      })
    ).structuredContent;
    return receipt.lineBounds?.[t.id] ?? null;
  } finally {
    await call("kalamo_tx_rollback", { docId, txId });
  }
}

/** `svg`, the SVG arm's file, tells a text Kalamo cannot judge (#238) from one never broken. */
async function judge(call: Call, docId: string, svg?: string) {
  const all = await leaves(call, docId);
  const rects = all.filter((n) => n.type === "rect");
  const texts = all.filter((n) => n.type === "text");
  assert(
    rects.length === 1 && texts.length + 1 === all.length,
    `the Document holds ${all.map((n) => n.type)}, want one rect and texts`,
  );
  // HTML in a <foreignObject>, say, is not text Kalamo or Inkscape can edit, and opens as nothing.
  assert(texts.length > 0, "no text, as SVG <text>, in the Document");
  const lines: Bounds[] = [];
  for (const t of texts) {
    const b = await linesOf(call, docId, t);
    assert(b, `"${t.content?.slice(0, 20)}…" shows no line`);
    // tspans positioned by x and dy open as one line until #238: past the page, no line is meant.
    assert(
      !svg?.includes("<tspan") || b.width <= 600,
      `Kalamo opened a text as one line ${b.width.toFixed(0)} pt wide, which it cannot judge (#238)`,
    );
    lines.push(b);
  }
  const words = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");
  const read = words(texts.map((t) => t.content).join(" "));
  assert(read === PARAGRAPH, `the texts read "${read}"`);

  const [rect] = rects as [Leaf];
  const { fills, strokes } = rect.appearance;
  assert(
    fills.length === 0 &&
      strokes.length === 1 &&
      hex(strokes[0]?.color) === "#3D3D44" &&
      strokes[0]?.width === 1,
    `the rect's appearance is ${JSON.stringify(rect.appearance)}`,
  );
  const r = rect.geometricBounds;
  assert(
    near(r.x, 140) && near(r.width, 320),
    `the rect is at ${JSON.stringify(r)}, want 320 pt wide at x 140`,
  );

  // The rect's top is the text box's, at y 120, or the first line's ascender, which may rise above it.
  const top = Math.min(...lines.map((b) => b.y));
  assert(
    Math.abs(top - 120) <= 4,
    `the first line's top is at y ${top.toFixed(2)}, want the text box's, 120`,
  );
  assert(
    r.y >= Math.min(top, 120) - 1 && r.y <= 121,
    `the rect's top is at y ${r.y.toFixed(2)}, want the text box's (120) or the first line's (${top.toFixed(2)})`,
  );
  for (const b of lines)
    assert(
      b.x >= r.x - 0.5 &&
        b.x + b.width <= r.x + r.width + 0.5 &&
        b.y + b.height <= r.y + r.height + 0.5,
      `lines at ${JSON.stringify(b)} reach past the sides or bottom of the rect at ${JSON.stringify(r)}`,
    );
  const bottom = Math.max(...lines.map((b) => b.y + b.height));
  const gap = r.y + r.height - bottom;
  assert(
    gap <= SLACK,
    `the rect's bottom is ${gap.toFixed(1)} pt below the last line, want at most ${SLACK}`,
  );
}

const check: Check = (call, docId) => judge(call, docId);
export default check;

export const svgCheck: SvgCheck = async (call, files) =>
  judge(call, await openSvg(call, files["out.svg"]), files["out.svg"]);
