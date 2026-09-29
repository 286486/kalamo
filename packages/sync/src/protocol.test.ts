import { createDocument, createNodes, type Node } from "@kalamo/core";
import { expect, it } from "vitest";
import { applyBroadcast } from "./protocol.ts";

it("applies a tx message as a new Document: created and updated replace, deleted go", () => {
  const { doc, defaultLayerId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 100, height: 100 }],
  });
  const rect = {
    type: "rect" as const,
    parentId: defaultLayerId,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
  };
  const [a, b] = createNodes(doc, [rect, rect]).nodes as [Node, Node];
  const c = { ...a, id: "c", name: "C" };
  const next = applyBroadcast(doc, {
    type: "tx",
    rev: 7,
    txId: "t",
    actor: "agent-a",
    intent: null,
    created: [c],
    updated: [{ ...a, name: "A" }],
    deletedIds: [b.id],
  });
  expect(next.rev).toBe(7);
  expect(next.nodes.get(a.id)?.name).toBe("A");
  expect(next.nodes.get("c")).toEqual(c);
  expect(next.nodes.has(b.id)).toBe(false);
  // The store keeps the old Document for React's change detection.
  expect(doc.nodes.has(b.id)).toBe(true);
  expect(doc.nodes.get(a.id)?.name).not.toBe("A");
});
