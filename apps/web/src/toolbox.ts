import type { Document, Node } from "@zibel/core";
import { addAnchorTool, anchorPointTool, deleteAnchorTool } from "./anchorTools.ts";
import { curvatureTool } from "./curvatureTool.ts";
import { directTool } from "./directTool.ts";
import { exitIsolation, keysOf } from "./menu.ts";
import { pencilTool } from "./pencilTool.ts";
import { penTool } from "./penTool.ts";
import { selectionTool } from "./selectionTool.ts";
import {
  arcTool,
  ellipseTool,
  lineTool,
  polygonTool,
  rectangleTool,
  roundedRectangleTool,
  spiralTool,
  starTool,
} from "./shapeTool.ts";
import { useStore } from "./store.ts";
import { fillStrokeKey, setTool } from "./tools.ts";
import type { Viewport } from "./viewport.ts";
import { zoomTool } from "./zoomTool.ts";

/** A pointer event on the canvas, in document coordinates. */
export interface ToolEvent {
  x: number;
  y: number;
  /** Every position the pointer reported since the last event, this one's last (F-FREE-01). */
  points: [number, number][];
  shift: boolean;
  alt: boolean;
  /** Ctrl, or Cmd on macOS. */
  ctrl: boolean;
  /** Space held since after the press; Space held at the press pans instead. */
  space: boolean;
  /**
   * The press's click count: 2 for a double-click's second press. Read it on release: a mouse
   * press's comes from its mousedown, after pointerdown, in the platform's double-click time and
   * distance; a touch or pen press's from `nextTap`.
   */
  clicks: number;
  doc: Document;
  viewport: Viewport;
  /** For hit tests. */
  ctx: CanvasRenderingContext2D;
  /** Keeps the pointer's events on the canvas until it is released. */
  capture(): void;
  /** Redraws the canvas after the tool's overlay changed. */
  redraw(): void;
}

/** The modifiers a key can change mid-drag. */
export type KeyMods = Pick<ToolEvent, "shift" | "alt" | "ctrl" | "space">;

/** A key pressed, repeated or released while a tool holds the pointer, and the modifiers now held. */
export interface ToolKey extends KeyMods {
  /** The key without its modifiers, as keysOf names it: `ArrowUp`, `C`. */
  key: string;
  /** True for a keydown, each auto-repeat included. */
  down: boolean;
}

/** A touch or pen press, in client px and ms, and its click count. */
export interface Tap {
  x: number;
  y: number;
  t: number;
  count: number;
}

/** The platform's usual double-click time, in ms, and a fingertip's slack, in CSS px. */
const DOUBLE_TAP_MS = 500;
const DOUBLE_TAP_PX = 16;

/**
 * The press after `last`: it counts on from `last` when it comes in DOUBLE_TAP_MS and
 * DOUBLE_TAP_PX of it. A touch's compatibility mousedown comes after its release, too late for
 * its `clicks`, so touch and pen presses count their own.
 */
export const nextTap = (last: Tap | null, x: number, y: number, t: number): Tap => {
  const near =
    last && t - last.t <= DOUBLE_TAP_MS && Math.hypot(x - last.x, y - last.y) <= DOUBLE_TAP_PX;
  return { x, y, t, count: near ? last.count + 1 : 1 };
};

/**
 * A Tools panel group, named after its first tool: Illustrator's Pen, Line Segment and Rectangle
 * so far.
 */
export type ToolGroup = "pen" | "line" | "rectangle";

/**
 * A tool of the Tools panel on the canvas. Viewer keeps what every tool shares (viewport, pan,
 * zoom, the Document and the Selection outline) and hands the rest to the active tool.
 */
export interface CanvasTool {
  title: string;
  /** Its key (ADR-0031), empty where Illustrator gives it none. */
  shortcut: string;
  /** The Tools panel group it shares one button with, as in Illustrator's default toolbar. */
  group?: ToolGroup;
  /** Its icon's SVG path in a 16 px box, and the icon's fill. */
  icon: string;
  iconFill?: string;
  cursor: string;
  /** The cursor while Alt is held. */
  altCursor?: string;
  down(e: ToolEvent): void;
  move?(e: ToolEvent): void;
  up?(e: ToolEvent): void;
  /** Drops the press; also when its release comes after the Document went. */
  cancel?(redraw: () => void): void;
  leave?(e: ToolEvent): void;
  /**
   * Any key pressed or released while the tool holds the pointer. True when the tool took the key:
   * it then switches no tool and reaches neither the menu bar nor `onKey`.
   */
  keyChange?(key: ToolKey, redraw: () => void): boolean;
  /** Its options dialog, opened by double-clicking the tool. */
  options?(): void;
  /** A key that is neither a tool's nor the Fill and Stroke boxes'; true when it took the key. */
  onKey?(keys: string): boolean;
  /**
   * Its overlay, over the Document and the Selection. Every tool draws, not just the active one:
   * a path the Pen sent shows until its Transaction arrives, after the tool switch that sent it.
   */
  draw?(ctx: CanvasRenderingContext2D, doc: Document, scale: number): void;
  /** Draws a selected Node its own way while active; false leaves its bounding box. */
  drawSelected?(ctx: CanvasRenderingContext2D, doc: Document, node: Node, scale: number): boolean;
}

/** The canvas tools, in the Tools panel's order. */
export const TOOLS = {
  selection: selectionTool,
  direct: directTool,
  zoom: zoomTool,
  pen: penTool,
  addAnchor: addAnchorTool,
  deleteAnchor: deleteAnchorTool,
  anchorPoint: anchorPointTool,
  curvature: curvatureTool,
  line: lineTool,
  arc: arcTool,
  spiral: spiralTool,
  rectangle: rectangleTool,
  roundedRectangle: roundedRectangleTool,
  ellipse: ellipseTool,
  polygon: polygonTool,
  star: starTool,
  pencil: pencilTool,
} satisfies Record<string, CanvasTool>;

export type Tool = keyof typeof TOOLS;

// The active tool is at the front of its group, whether a click, its shortcut or a flyout chose it.
useStore.subscribe((s, prev) => {
  const { group } = TOOLS[s.tool];
  if (s.tool !== prev.tool && group && s.front[group] !== s.tool) {
    useStore.setState({ front: { ...s.front, [group]: s.tool } });
  }
});

export const TOOL_KEYS: Record<string, Tool> = Object.fromEntries(
  (Object.keys(TOOLS) as Tool[])
    .filter((name) => TOOLS[name].shortcut)
    // keysOf reports + as =, the key it is on.
    .map((name) => [TOOLS[name].shortcut.replace(/^\+$/, "="), name]),
);

/**
 * Hands a key on the page to the tool holding the pointer, if any; true when it took the key.
 * Viewer asks before anything else hears the key (ADR-0031).
 */
export function pressedKey(
  e: Pick<KeyboardEvent, "type" | "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
  pressed: CanvasTool | null,
  space: boolean,
  redraw: () => void,
): boolean {
  const keys = keysOf(e);
  const key = keys.slice(keys.lastIndexOf("+") + 1);
  const down = e.type === "keydown";
  return !!pressed?.keyChange?.(
    { key, down, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, space },
    redraw,
  );
}

/**
 * A key no pressed tool took. A keydown without Ctrl, not typed into a text field, is a tool's
 * shortcut, a Fill and Stroke box key, the active tool's `onKey`, or Escape leaving Isolation.
 */
export function canvasKey(
  e: Pick<
    KeyboardEvent,
    "type" | "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "target"
  >,
) {
  // The Fill and Stroke boxes' color inputs are not text.
  const typing = (e.target as Element | null)?.matches?.("input:not([type=color])");
  if (e.type !== "keydown" || e.code === "Space" || e.ctrlKey || e.metaKey || typing) return;
  const keys = keysOf(e);
  const tool = TOOL_KEYS[keys];
  const fillStroke = fillStrokeKey(useStore.getState().fillStroke, keys);
  if (tool) setTool(tool);
  else if (fillStroke) useStore.setState({ fillStroke });
  else if (!TOOLS[useStore.getState().tool].onKey?.(keys) && keys === "Escape") exitIsolation();
}

/** A Tools panel button: its tools, in the panel's order, and the one it shows. */
export interface ToolSlot {
  tools: Tool[];
  shown: Tool;
}

/**
 * The Tools panel's buttons for `tools`: each lone tool, and each group at its first tool, showing
 * its tool in `front` or else its first.
 */
export function toolSlots(tools: readonly Tool[], front: Partial<Record<ToolGroup, Tool>>) {
  const slots: ToolSlot[] = [];
  const groups = new Map<ToolGroup, ToolSlot>();
  for (const t of tools) {
    const group = TOOLS[t].group;
    const slot = group && groups.get(group);
    if (slot) slot.tools.push(t);
    else {
      const added = { tools: [t], shown: t };
      slots.push(added);
      if (group) groups.set(group, added);
    }
  }
  for (const [group, slot] of groups) {
    const t = front[group];
    if (t && slot.tools.includes(t)) slot.shown = t;
  }
  return slots;
}
