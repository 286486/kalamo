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

const ROWS = "ABCDEFGHIJ";
const SEATS = 20;
const SEAT = 20;
const PITCH = 26;
const FREE = "#3565E8";
const SOLD = "#9AA0A6";

/** Seat `n` (1-based) of row `r` (0-based) where the setup draws it. */
const seatAt = (r: number, n: number) => ({ x: 40 + PITCH * (n - 1), y: 60 + PITCH * r });

/** A 600×340 pt plan: a Seats Layer of a Group per row, each of 20 rects named for their seats. */
export const setup: Setup = async (call, name) => {
  const { docId } = (
    await call("kalamo_doc_create", { name, artboards: [{ width: 600, height: 340 }] })
  ).structuredContent;
  const rows = [...ROWS].map((row, r) => ({
    type: "group",
    name: `Row ${row}`,
    children: Array.from({ length: SEATS }, (_, i) => ({
      type: "rect",
      name: `${row}${i + 1}`,
      ...seatAt(r, i + 1),
      width: SEAT,
      height: SEAT,
      appearance: { fills: [{ color: FREE }] },
    })),
  }));
  const layerId = (
    await call("kalamo_node_create", { docId, nodes: [{ type: "layer", name: "Seats" }] })
  ).structuredContent.createdIds[0];
  await call("kalamo_node_create", {
    docId,
    nodes: rows.map((row) => ({ ...row, parentId: layerId })),
  });
  return { docId, files: { "plan.svg": await exportSvg(call, docId) } };
};

const check: Check = async (call, docId) => {
  const shapes = await leaves(call, docId);
  const byName = new Map(shapes.map((s) => [s.name, s]));
  assert(shapes.length === 180, `${shapes.length} shapes, want 180`);
  for (const [r, row] of [...ROWS.slice(0, -1)].entries())
    for (let n = 1; n <= SEATS; n++) {
      const seat = byName.get(`${row}${n}`);
      assert(seat?.type === "rect", `no rect named ${row}${n}`);
      const want = seatAt(r, n);
      if (n > 10) want.x += 30;
      const b = seat.geometricBounds;
      assert(
        n3(b.x) === want.x && n3(b.y) === want.y && n3(b.width) === SEAT && n3(b.height) === SEAT,
        `${seat.name} is at ${JSON.stringify(b)}, want ${SEAT}×${SEAT} at (${want.x}, ${want.y})`,
      );
      const fill = row === "C" && n >= 5 && n <= 9 ? SOLD : FREE;
      const { fills, strokes } = seat.appearance;
      assert(
        fills.length === 1 && hex(fills[0]?.color) === fill && strokes.length === 0,
        `${seat.name} has appearance ${JSON.stringify(seat.appearance)}, want a ${fill} Fill`,
      );
    }
};

export default check;

export const svgCheck: SvgCheck = async (call, files) =>
  check(call, await openSvg(call, files["plan.svg"]), []);
