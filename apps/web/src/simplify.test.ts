import { createDocument, createNodes, type Document, type PathNode } from "@kalamo/core";
import { expect, it } from "vitest";
import { type Held, previewAll, previewsOf, type ViewState } from "./receive.ts";
import { anchorCount, simplifyCounts } from "./simplify.ts";
import { message, stateAfter, viewState } from "./testing.ts";

/**
 * A path whose Anchor at (120, 100) lies on a line, which Simplify removes, and the dialog's
 * preview of Simplify on it.
 */
function fixture() {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 200 }],
  });
  const [q] = createNodes(doc, [
    { type: "path", parentId, d: "M100 100 L120 100 L140 100 L120 140 Z" },
  ]).nodes as [PathNode];
  const input = { nodeIds: [q.id], op: "simplify" as const, tolerance: 1, cornerAngle: 90 };
  const opPreview = { input: { ...input, toLines: false }, showOriginal: false };
  return { doc, q, opPreview };
}

/** The Anchors of `nodeIds` the canvas draws, without and with the open op preview. */
function drawn(s: ViewState, nodeIds: string[]) {
  const count = (opPreview: ViewState["opPreview"]) =>
    anchorCount(previewAll(s.doc as Document, previewsOf({ ...s, opPreview })), nodeIds);
  return { original: count(null), current: count(s.opPreview) };
}

it("counts Simplify's Anchors on the path as drawn under an unanswered or held edit of the person's own (#310)", () => {
  for (const how of ["sent", "held"] as const) {
    const { doc, q, opPreview } = fixture();
    // An Anchor added on the third segment and moved off it, which Simplify refits around.
    const ops = [
      { op: "add_anchor" as const, subpath: 0, segment: 2, t: 0.5 },
      { op: "move_anchor" as const, subpath: 0, index: 3, to: [150, 130] as [number, number] },
    ];
    const inputs = [{ nodeId: q.id, ops }];
    const s = viewState({
      doc,
      opPreview,
      ...(how === "sent"
        ? {
            sentPreviews: [{ edit: { inputs, commandIds: ["c1"] }, drag: null }],
            sent: new Set(["c1"]),
          }
        : {
            held: [{ preview: { edit: { inputs }, drag: null }, token: "h1" } as unknown as Held],
          }),
    });
    expect(drawn(s, [q.id]), how).toEqual({ original: 5, current: 6 });
    expect(simplifyCounts(doc, s, [q.id]), how).toEqual(drawn(s, [q.id]));
  }
});

it("counts Simplify's Anchors on the path an Agent's change reshaped (#310)", () => {
  const { doc, q, opPreview } = fixture();
  const before = viewState({ doc, opPreview });
  expect(simplifyCounts(doc, before, [q.id])).toEqual({ original: 4, current: 3 });
  const reshaped = { ...q, d: "M100 100 L120 100 L140 100 L150 130 L120 140 Z" };
  const s = { ...before, ...stateAfter(before, message("tx", { updated: [reshaped] })) };
  expect(drawn(s, [q.id])).toEqual({ original: 5, current: 6 });
  expect(simplifyCounts(s.doc as Document, s, [q.id])).toEqual(drawn(s, [q.id]));
});
