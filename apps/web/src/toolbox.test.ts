import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "./store.ts";
import {
  type CanvasTool,
  canvasKey,
  nextTap,
  pressedKey,
  TOOLS,
  type Tool,
  type ToolKey,
  toolSlots,
} from "./toolbox.ts";
import { setTool } from "./tools.ts";

vi.mock("./tools.ts", async (original) => ({
  ...(await original<typeof import("./tools.ts")>()),
  setTool: vi.fn(),
}));

it("counts a press close in time and space as the next click, and far ones as a first", () => {
  const first = nextTap(null, 100, 100, 1000);
  expect(first.count).toBe(1);
  const second = nextTap(first, 110, 108, 1400);
  expect(second.count).toBe(2);
  expect(nextTap(second, 110, 108, 1800).count).toBe(3);
  expect(nextTap(first, 100, 100, 1600).count).toBe(1);
  expect(nextTap(first, 120, 100, 1100).count).toBe(1);
  // The limits themselves still count.
  expect(nextTap(first, 116, 100, 1500).count).toBe(2);
  expect(nextTap(first, 116.1, 100, 1100).count).toBe(1);
  expect(nextTap(first, 100, 100, 1500.1).count).toBe(1);
});

it("shows each group as one button, at its first tool, fronting its last chosen tool", () => {
  const all = Object.keys(TOOLS) as Tool[];
  const slots = toolSlots(all, {});
  expect(slots.map((s) => s.shown)).toEqual([
    "selection",
    "direct",
    "zoom",
    "pen",
    "line",
    "rectangle",
    "pencil",
  ]);
  expect(slots[3]?.tools).toEqual(["pen", "addAnchor", "deleteAnchor", "anchorPoint", "curvature"]);
  expect(slots[4]?.tools).toEqual(["line", "arc", "spiral", "rectangularGrid", "polarGrid"]);
  expect(slots[5]?.tools).toEqual(["rectangle", "roundedRectangle", "ellipse", "polygon", "star"]);
  expect(toolSlots(all, { pen: "curvature", rectangle: "ellipse" })[3]?.shown).toBe("curvature");
  expect(toolSlots(all, { pen: "curvature", rectangle: "ellipse" })[5]?.shown).toBe("ellipse");
  // A viewer's tools show no group; a fronted tool that is not shown is ignored.
  expect(toolSlots(["selection", "zoom"], { pen: "curvature" })).toEqual([
    { tools: ["selection"], shown: "selection" },
    { tools: ["zoom"], shown: "zoom" },
  ]);
});

/** A keydown or keyup of `key`, as the page sends it. */
const press = (key: string, type = "keydown", mods: Partial<KeyboardEvent> = {}) =>
  ({
    type,
    key,
    code: `Key${key.toUpperCase()}`,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target: null,
    ...mods,
  }) as KeyboardEvent;
/** Viewer's routing: the pressed tool first, then the canvas's keys if it did not take the key. */
const route = (e: KeyboardEvent, pressed: CanvasTool | null) =>
  pressedKey(e, pressed, false, false, () => {}) || canvasKey(e);

beforeEach(() => {
  vi.mocked(setTool).mockClear();
  useStore.setState({ tool: "selection" });
});

it("a key the pressed tool takes switches no tool; one it does not take still does", () => {
  const heard: ToolKey[] = [];
  const pressed = {
    ...TOOLS.rectangle,
    keyChange: (key: ToolKey) => {
      heard.push(key);
      return key.key === "C";
    },
  };
  route(press("c"), pressed);
  route(press("C", "keydown", { shiftKey: true }), pressed);
  route(press("c", "keyup"), pressed);
  expect(setTool).not.toHaveBeenCalled();
  route(press("m"), pressed);
  expect(setTool).toHaveBeenCalledWith("rectangle");
  // Every key reaches it, with the modifiers now held.
  expect(heard.map(({ key, down, shift }) => [key, down, shift])).toEqual([
    ["C", true, false],
    ["C", true, true],
    ["C", false, false],
    ["M", true, false],
  ]);
  // No tool holding the pointer: Shift+C is the Anchor Point tool's key, and \\ the Line Segment's.
  route(press("C", "keydown", { shiftKey: true }), null);
  expect(setTool).toHaveBeenLastCalledWith("anchorPoint");
  route({ ...press("\\"), code: "Backslash" }, null);
  expect(setTool).toHaveBeenLastCalledWith("line");
});

describe("a pressed tool that takes Enter and Escape", () => {
  const heard: string[] = [];
  const pressed = {
    ...TOOLS.rectangle,
    keyChange: (key: ToolKey) => {
      heard.push(`${key.key} ${key.down ? "down" : "up"}`);
      return true;
    },
  };
  beforeEach(() => {
    heard.length = 0;
  });

  const key = (e: KeyboardEvent, modal: boolean) => pressedKey(e, pressed, false, modal, () => {});

  it.each(["Enter", "Escape"])(
    "does not hear an %s keydown behind Simplify's open bar, which then answers it",
    (k) => {
      expect(key(press(k), true)).toBe(false);
      expect(heard).toEqual([]);
    },
  );

  it("still hears their keyups, and every other key, behind the open bar", () => {
    expect(key(press("Enter", "keyup"), true)).toBe(true);
    expect(key(press("ArrowUp"), true)).toBe(true);
    expect(heard).toEqual(["Enter up", "ArrowUp down"]);
  });

  it("takes them with no bar open, before any shortcut or the active tool's onKey", () => {
    useStore.setState({ tool: "pen" });
    const onKey = vi.spyOn(TOOLS.pen, "onKey");
    for (const k of ["Enter", "Escape"]) expect(key(press(k), false)).toBe(true);
    for (const k of ["Enter", "Escape"]) route(press(k), pressed);
    expect(heard).toEqual(["Enter down", "Escape down", "Enter down", "Escape down"]);
    expect(onKey).not.toHaveBeenCalled();
    expect(setTool).not.toHaveBeenCalled();
    onKey.mockRestore();
  });
});

it("the Rounded Rectangle tool takes Up and Down behind Simplify's open bar", () => {
  const tool = TOOLS.roundedRectangle;
  tool.down({ x: 0, y: 0, capture() {} } as never);
  for (const k of ["ArrowUp", "ArrowDown"])
    expect(pressedKey(press(k), tool, false, true, () => {})).toBe(true);
  tool.cancel?.(() => {});
});

it.each(["roundedRectangle", "polygon", "star", "arc", "spiral"] as const)(
  "the %s tool takes the arrow keys while dragging",
  (name) => {
    const tool = TOOLS[name];
    const arrow = press("ArrowUp");
    expect(pressedKey(arrow, tool, false, false, () => {})).toBe(false);
    tool.down({ x: 0, y: 0, capture() {} } as never);
    expect(pressedKey(arrow, tool, false, false, () => {})).toBe(true);
    expect(pressedKey(press("v"), tool, false, false, () => {})).toBe(false);
    tool.cancel?.(() => {});
  },
);

it("the Arc tool takes C, F and X while dragging, which then switch no tool or Fill and Stroke", () => {
  const tool = TOOLS.arc;
  tool.down({ x: 0, y: 0, capture() {} } as never);
  for (const k of ["c", "f", "x", "X"])
    expect(pressedKey(press(k), tool, false, false, () => {})).toBe(true);
  tool.cancel?.(() => {});
  expect(pressedKey(press("c"), tool, false, false, () => {})).toBe(false);
});

it("the Rectangular Grid tool takes the arrows, F, V, X and C while dragging, which then switch nothing", () => {
  const tool = TOOLS.rectangularGrid;
  tool.down({ x: 0, y: 0, capture() {} } as never);
  for (const k of ["f", "v", "x", "c", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"])
    expect(pressedKey(press(k), tool, false, false, () => {})).toBe(true);
  expect(pressedKey(press("m"), tool, false, false, () => {})).toBe(false);
  tool.cancel?.(() => {});
  expect(pressedKey(press("v"), tool, false, false, () => {})).toBe(false);
});

it("the Polar Grid tool takes the arrows, X, C, F and V while dragging, which then switch nothing", () => {
  const tool = TOOLS.polarGrid;
  tool.down({ x: 0, y: 0, capture() {} } as never);
  for (const k of ["x", "c", "f", "v", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"])
    expect(pressedKey(press(k), tool, false, false, () => {})).toBe(true);
  expect(pressedKey(press("m"), tool, false, false, () => {})).toBe(false);
  tool.cancel?.(() => {});
  expect(pressedKey(press("c"), tool, false, false, () => {})).toBe(false);
});

it("gives the Arc, Spiral, Rectangular Grid, Polar Grid, Rounded Rectangle, Polygon and Star tools no shortcut, as Illustrator does", () => {
  expect(Object.values(TOOLS).filter((t) => !t.shortcut)).toEqual([
    TOOLS.arc,
    TOOLS.spiral,
    TOOLS.rectangularGrid,
    TOOLS.polarGrid,
    TOOLS.roundedRectangle,
    TOOLS.polygon,
    TOOLS.star,
  ]);
});
