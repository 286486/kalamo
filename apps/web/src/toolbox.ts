import type { Document, Node } from "@zibel/core";
import { addAnchorTool, anchorPointTool, deleteAnchorTool } from "./anchorTools.ts";
import { curvatureTool } from "./curvatureTool.ts";
import { directTool } from "./directTool.ts";
import { pencilTool } from "./pencilTool.ts";
import { penTool } from "./penTool.ts";
import { selectionTool } from "./selectionTool.ts";
import { ellipseTool, rectangleTool } from "./shapeTool.ts";
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
export type KeyMods = Pick<ToolEvent, "shift" | "alt" | "space">;

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
 * A tool of the Tools panel on the canvas. Viewer keeps what every tool shares (viewport, pan,
 * zoom, the Document and the Selection outline) and hands the rest to the active tool.
 */
export interface CanvasTool {
  title: string;
  /** Its key (ADR-0031). */
  shortcut: string;
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
  /** Any key pressed or released while the tool holds the pointer, with the modifiers now held. */
  keyChange?(mods: KeyMods, redraw: () => void): void;
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
  rectangle: rectangleTool,
  ellipse: ellipseTool,
  pencil: pencilTool,
} satisfies Record<string, CanvasTool>;

export type Tool = keyof typeof TOOLS;

export const TOOL_KEYS: Record<string, Tool> = Object.fromEntries(
  // keysOf reports + as =, the key it is on.
  (Object.keys(TOOLS) as Tool[]).map((name) => [TOOLS[name].shortcut.replace(/^\+$/, "="), name]),
);
