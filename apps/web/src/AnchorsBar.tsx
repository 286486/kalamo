import { convertInputs, convertTargets } from "./direct.ts";
import { send, useStore } from "./store.ts";

/** One `path_edit` per path, drawn until its answer, as a drag is. */
function convert(type: "corner" | "smooth") {
  const { doc, anchors, segments } = useStore.getState();
  const inputs = doc ? convertInputs(doc, anchors, segments, type) : [];
  if (inputs.length === 0) return;
  const commandIds = inputs.map((input) => send({ type: "path_edit", input }));
  useStore.setState({ edit: { inputs, commandIds } });
}

/**
 * Illustrator's Control panel Convert buttons under Direct Selection (research 06 §4), an on-canvas
 * bar like Simplify's (ADR-0035) while some path is partly selected. It stays at the canvas's top
 * where the Control panel is, not under the paths, so it never covers the next segment clicked.
 */
export function AnchorsBar() {
  const { doc, anchors, segments, tool } = useStore();
  if (tool !== "direct" || !doc || convertTargets(doc, anchors, segments).length === 0) return null;
  const button = (type: "corner" | "smooth", label: string) => (
    <button
      type="button"
      aria-label={`Convert selected anchor points to ${type}`}
      title={`Convert selected anchor points to ${type}`}
      onClick={() => convert(type)}
    >
      {label}
    </button>
  );
  return (
    <div
      role="toolbar"
      aria-label="Anchors"
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
