import { useStore } from "./store.ts";
import type { CanvasTool } from "./toolbox.ts";
import { setTool } from "./tools.ts";
import { zoomAt } from "./viewport.ts";

/** A click zooms in at the pointer, Alt+click out. */
export const zoomTool: CanvasTool = {
  title: "Zoom Tool",
  shortcut: "Z",
  icon: "M2 7 A5 5 0 1 0 12 7 A5 5 0 1 0 2 7 M10.5 10.5 L14.5 14.5",
  cursor: "zoom-in",
  altCursor: "zoom-out",
  down({ x, y, alt, viewport: v }) {
    const factor = alt ? 0.5 : 2;
    useStore.setState({ viewport: zoomAt(v, factor, x * v.scale + v.x, y * v.scale + v.y) });
  },
  onKey(keys) {
    // Esc leaves the Zoom tool.
    if (keys !== "Escape") return false;
    setTool("selection");
    return true;
  },
};
