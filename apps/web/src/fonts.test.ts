import { BUNDLED_FAMILIES } from "@kalamo/core";
import { expect, it } from "vitest";
import { FONT_FILES } from "./fonts.ts";

it("has font files for every bundled family, and only those (ADR-0066)", () => {
  expect(Object.keys(FONT_FILES).sort()).toEqual([...BUNDLED_FAMILIES].sort());
  for (const files of Object.values(FONT_FILES)) expect(files.length).toBeGreaterThan(0);
});
