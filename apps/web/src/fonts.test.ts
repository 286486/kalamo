import {
  BUNDLED_FAMILIES,
  createDocument,
  createNodes,
  layoutText,
  type NodeInput,
  type TextNode,
} from "@kalamo/core";
import { expect, it } from "vitest";
import { drawnLazyFamilies, FONT_FILES } from "./fonts.ts";

it("has font files for every bundled family, and only those (ADR-0066)", () => {
  expect(Object.keys(FONT_FILES).sort()).toEqual([...BUNDLED_FAMILIES].sort());
  for (const files of Object.values(FONT_FILES)) expect(files.length).toBeGreaterThan(0);
});

it("lazy-loads each family a character draws in, its Character Range's font included (ADR-0068)", () => {
  const docWith = (...texts: Partial<Extract<NodeInput, { type: "text" }>>[]) => {
    const { doc, defaultLayerId: parentId } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 200, height: 100 }],
    });
    createNodes(
      doc,
      texts.map((t) => ({ type: "text", parentId, x: 0, y: 50, content: "Hello", ...t })),
    );
    return doc;
  };
  const lazy = (...texts: Parameters<typeof docWith>) => drawnLazyFamilies(docWith(...texts));
  const range = (fontFamily: string) => ({ ranges: [{ start: 0, end: 5, fontFamily }] });
  expect(lazy(range("Noto Sans KR"))).toEqual(["Noto Sans KR"]);
  expect(lazy(range("Helvetica"), range("Source Sans 3"))).toEqual([]);
  expect(lazy({}, { content: "小" }, { content: "한" })).toEqual(["Noto Sans SC", "Noto Sans KR"]);
  // Hidden Area Type overflow counts too.
  const area = docWith({ kind: "area", width: 100, height: 20, content: "Hi\n\n\n小" });
  const text = [...area.nodes.values()].find((n) => n.type === "text") as TextNode;
  expect(layoutText(text).overflow).toContain("小");
  expect(drawnLazyFamilies(area)).toEqual(["Noto Sans SC"]);
});
