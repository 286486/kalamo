import { goTo, levels } from "./isolation.ts";
import { nameOf } from "./layers.ts";
import { useStore } from "./store.ts";

const button: React.CSSProperties = {
  border: "none",
  background: "none",
  padding: "0 2px",
  font: "inherit",
  color: "#1A55D6",
  cursor: "pointer",
};

/**
 * Illustrator's isolation bar (ADR-0057), over the top of the canvas while a Node is isolated: a
 * back arrow up one level, the Layer and each level above the innermost as breadcrumbs, and the
 * innermost level.
 */
export function IsolationBar() {
  const doc = useStore((s) => s.doc);
  const isolated = useStore((s) => s.isolated);
  if (!doc || !isolated) return null;
  const path = levels(doc, isolated);
  const layer = doc.nodes.get(doc.nodes.get(path[0] ?? "")?.parentId ?? "");
  const name = (id: string) => {
    const n = doc.nodes.get(id);
    return n ? nameOf(doc, n) : "";
  };
  const go = (level: string | null) => useStore.setState(goTo(doc, isolated, level));
  const up = path.at(-2) ?? null;
  return (
    <nav
      aria-label="Isolation Mode"
      style={{
        position: "absolute",
        top: 8,
        left: 56,
        display: "flex",
        gap: 4,
        alignItems: "center",
        padding: "4px 8px",
        background: "#FFFFFF",
        border: "1px solid #999",
        borderRadius: 4,
        font: "12px system-ui, sans-serif",
        zIndex: 10,
      }}
    >
      <button
        type="button"
        aria-label="Exit Isolation Mode"
        title="Exit Isolation Mode"
        style={{ ...button, color: "inherit" }}
        onClick={() => go(up)}
      >
        ←
      </button>
      {layer && (
        <button type="button" style={button} onClick={() => go(null)}>
          {name(layer.id)}
        </button>
      )}
      {path.slice(0, -1).map((id) => (
        <span key={id}>
          ›{" "}
          <button type="button" style={button} onClick={() => go(id)}>
            {name(id)}
          </button>
        </span>
      ))}
      <span aria-current="location">› {name(isolated)}</span>
    </nav>
  );
}
