import { BUNDLED_FAMILIES, createDocument, createNodes, type NodeInput } from "@kalamo/core";
import { expect, it } from "vitest";
import { drawnLazyFamilies, FONT_FILES } from "./fonts.ts";

it("has font files for every bundled family, and only those (ADR-0066)", () => {
  expect(Object.keys(FONT_FILES).sort()).toEqual([...BUNDLED_FAMILIES].sort());
  for (const files of Object.values(FONT_FILES)) expect(files.length).toBeGreaterThan(0);
});

it("lazy-loads each family a character draws in, its Character Range's included (ADR-0068)", () => {
  const lazy = (...texts: object[]) => {
    const { doc, defaultLayerId: parentId } = createDocument({
      id: "d",
      name: "Doc",
      artboards: [{ width: 200, height: 100 }],
    });
    createNodes(
      doc,
      texts.map(
        (t) => ({ type: "text", parentId, x: 0, y: 50, content: "Hello", ...t }) as NodeInput,
      ),
    );
    return drawnLazyFamilies(doc);
  };
  const range = (fontFamily: string) => ({ ranges: [{ start: 0, end: 5, fontFamily }] });
  expect(lazy(range("Noto Sans KR"))).toEqual(["Noto Sans KR"]);
  expect(lazy(range("Helvetica"), range("Source Sans 3"))).toEqual([]);
  expect(lazy({}, { content: "小" }, { content: "한" })).toEqual(["Noto Sans SC", "Noto Sans KR"]);
  // Hidden Area Type overflow counts too.
  expect(lazy({ kind: "area", width: 100, height: 20, content: "Hi\n\n\n小" })).toEqual([
    "Noto Sans SC",
  ]);
});
