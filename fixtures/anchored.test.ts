// Which texts the round trip budgets as anchored Point Type (ADR-0077): only those whose lines
// Inkscape anchors away from the layout.
import { expect, it } from "vitest";
import { anchoredBeforeLast } from "./anchored.ts";

const centred = { kind: "point", alignment: "center", content: "Right aligned\nok" };

it("budgets a centred or right-aligned Point Type whose line before the last tracks at its end", () => {
  expect(anchoredBeforeLast({ ...centred, tracking: 80 })).toBe(true);
  expect(anchoredBeforeLast({ ...centred, alignment: "right", tracking: 80 })).toBe(true);
  // A range that tracks the line's last character, "d".
  expect(anchoredBeforeLast({ ...centred, ranges: [{ start: 12, end: 13, tracking: 50 }] })).toBe(
    true,
  );
});

it("budgets a line before the last that ends in any JavaScript whitespace, tracked or not", () => {
  for (const ws of [" ", " ", "　"]) {
    expect(anchoredBeforeLast({ ...centred, content: `Right aligned${ws}\nok` })).toBe(true);
  }
});

it("keeps every other text at the text budget", () => {
  // Untracked, or tracking 0 by the text or by a range at the line's end.
  expect(anchoredBeforeLast(centred)).toBe(false);
  expect(anchoredBeforeLast({ ...centred, tracking: 0 })).toBe(false);
  expect(
    anchoredBeforeLast({ ...centred, tracking: 80, ranges: [{ start: 12, end: 13, tracking: 0 }] }),
  ).toBe(false);
  // Tracking only inside the line, or only on the last line, which Inkscape anchors as the layout.
  expect(anchoredBeforeLast({ ...centred, ranges: [{ start: 0, end: 5, tracking: 50 }] })).toBe(
    false,
  );
  expect(anchoredBeforeLast({ ...centred, ranges: [{ start: 14, end: 16, tracking: 50 }] })).toBe(
    false,
  );
  // One line, a trailing space on the last line, or an empty line before it.
  expect(anchoredBeforeLast({ ...centred, content: "Right aligned ", tracking: 80 })).toBe(false);
  expect(anchoredBeforeLast({ ...centred, content: "ok\nRight aligned " })).toBe(false);
  expect(anchoredBeforeLast({ ...centred, content: "\nok", tracking: 80 })).toBe(false);
  // Left, justify and Area Type.
  for (const other of [{ alignment: "left" }, { alignment: "justify" }, { kind: "area" }]) {
    expect(anchoredBeforeLast({ ...centred, tracking: 80, ...other })).toBe(false);
  }
  expect(anchoredBeforeLast({ ...centred, alignment: undefined, tracking: 80 })).toBe(false);
});
