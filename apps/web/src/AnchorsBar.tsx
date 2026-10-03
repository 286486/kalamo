import type { Anchor } from "@kalamo/core";
import { sendPreview } from "./canvas.ts";
import { convertInputs, convertTargets } from "./direct.ts";
import { afterReverse, type State, useStore, type Waited } from "./store.ts";

/** One `path_edit` per path, previewed until each is answered, as a Direct Selection drag is. */
function convert(type: Anchor["type"], { doc, anchors, segments }: State, w: Waited) {
  const inputs = doc ? convertInputs(doc, anchors, segments, type) : [];
  if (inputs.length > 0) sendPreview({ edit: { inputs, commandIds: null } }, w);
}

/** A Convert button's press, which waits for the person's command that may renumber a path. */
export const convertAnchors = (type: Anchor["type"]) => afterReverse((s, w) => convert(type, s, w));

/**
 * Illustrator's Control panel Convert buttons under Direct Selection (research 06 §4), an on-canvas
 * bar like Simplify's (ADR-0035) while some path is partly selected. It stays at the canvas's top
 * where the Control panel is, not under the paths, so it never covers the next segment clicked.
 */
export function AnchorsBar() {
  const doc = useStore((s) => s.doc);
  const anchors = useStore((s) => s.anchors);
  const segments = useStore((s) => s.segments);
  const tool = useStore((s) => s.tool);
  if (tool !== "direct" || !doc || convertTargets(doc, anchors, segments).length === 0) return null;
  const button = (type: Anchor["type"], label: string) => {
    const name = `Convert selected anchor points to ${type}`;
    return (
      <button type="button" aria-label={name} title={name} onClick={() => convertAnchors(type)}>
        {label}
      </button>
    );
  };
  return (
    <div
      role="toolbar"
      aria-label="Anchors"
      // A click must not leave focus on a button, where Enter and Space would press it again.
      onMouseDown={(e) => (e.target as Element).closest("button") && e.preventDefault()}
      style={{
        position: "absolute",
        top: 8,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        gap: 6,
        alignItems: "center",
        padding: "4px 8px",
        background: "#FFFFFF",
        border: "1px solid #999",
        borderRadius: 4,
        font: "12px system-ui, sans-serif",
        zIndex: 10,
      }}
    >
      Convert: {button("corner", "Corner")}
      {button("smooth", "Smooth")}
    </div>
  );
}
