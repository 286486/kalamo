import { memo, useState } from "react";
import { autoName, layerMask, rows } from "./layers.ts";
import { combine, objects } from "./selection.ts";
import { send, useStore } from "./store.ts";

const SELECTED = "#DCE6FF";
/** Inline SVG, since an emoji eye or lock depends on the system's emoji font. */
const glyph = (d: string) => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);
const EYE = glyph("M1 8 Q8 1 15 8 Q8 15 1 8 Z M6 8 A2 2 0 1 0 10 8 A2 2 0 1 0 6 8");
const LOCK = glyph("M3 7 H13 V15 H3 Z M5 7 V4 A3 3 0 0 1 11 4 V7");
const icon = {
  width: 20,
  height: 20,
  padding: 0,
  border: "none",
  background: "none",
  cursor: "pointer",
};

/** Illustrator's Layers panel (ADR-0012): the tree topmost first, eye and lock toggles, rows that select. */
export const Layers = memo(function Layers() {
  // memo and two selectors: a drag frame changes neither, so the panel does not re-render.
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const [toggled, setToggled] = useState(() => new Set<string>());
  if (!doc) return null;

  const toggle = (id: string) => {
    const next = new Set(toggled);
    if (!next.delete(id)) next.add(id);
    setToggled(next);
  };
  const update = (nodeId: string, patch: { visible: boolean } | { locked: boolean }) => {
    useStore.setState({ notice: null });
    send({ type: "update", nodeId, patch });
  };
  const mask = layerMask(doc, selection);

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: 260,
        display: "flex",
        flexDirection: "column",
        background: "#F5F5F5",
        borderLeft: "1px solid #CCC",
        font: "12px system-ui, sans-serif",
      }}
    >
      <div style={{ flex: 1, overflow: "auto" }}>
        {rows(doc, toggled).map(({ node, depth, expandable, expanded, dimmed, underlined }) => {
          const label = node.name || autoName(doc, node);
          const selected = selection.includes(node.id);
          const pick = (e: React.MouseEvent) => {
            const { doc, selection } = useStore.getState();
            if (!doc) return;
            // A Layer is never selected itself: its row selects the objects in it.
            const ids =
              node.type !== "layer"
                ? [node.id]
                : dimmed
                  ? []
                  : objects(doc, node.id).map((n) => n.id);
            useStore.setState({
              notice: null,
              selection: combine(selection, ids, { shift: e.shiftKey, alt: e.altKey }),
            });
          };
          return (
            <div
              key={node.id}
              style={{
                display: "flex",
                alignItems: "center",
                height: 22,
                paddingLeft: 4 + depth * 14,
                background: selected ? SELECTED : undefined,
                opacity: dimmed ? 0.5 : 1,
                borderBottom: "1px solid #E4E4E4",
              }}
            >
              <button
                type="button"
                style={icon}
                aria-label={`${node.visible ? "Hide" : "Show"} ${label}`}
                onClick={() => update(node.id, { visible: !node.visible })}
              >
                {node.visible && EYE}
              </button>
              <button
                type="button"
                style={icon}
                aria-label={`${node.locked ? "Unlock" : "Lock"} ${label}`}
                onClick={() => update(node.id, { locked: !node.locked })}
              >
                {node.locked && LOCK}
              </button>
              {expandable ? (
                <button
                  type="button"
                  style={icon}
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
                  aria-expanded={expanded}
                  onClick={() => toggle(node.id)}
                >
                  {expanded ? "▾" : "▸"}
                </button>
              ) : (
                <span style={{ width: 20 }} />
              )}
              <button
                type="button"
                aria-pressed={selected}
                onClick={pick}
                style={{
                  ...icon,
                  width: "auto",
                  minWidth: 40,
                  textAlign: "left",
                  whiteSpace: "nowrap",
                  fontWeight: node.type === "layer" ? 600 : 400,
                  textDecoration: underlined ? "underline" : undefined,
                }}
              >
                {label}
              </button>
              {node.tags.map((tag) => (
                <span
                  key={tag}
                  style={{
                    marginLeft: 4,
                    padding: "0 4px",
                    borderRadius: 3,
                    background: "#E0E0E0",
                  }}
                >
                  {tag}
                </span>
              ))}
            </div>
          );
        })}
      </div>
      {/* Illustrator's Make/Release Clipping Mask at the panel's foot (ADR-0053). */}
      <div style={{ display: "flex", padding: 4, borderTop: "1px solid #CCC" }}>
        <button
          type="button"
          disabled={!mask.command}
          onClick={() => {
            if (!mask.command) return;
            useStore.setState({ notice: null });
            send(mask.command);
          }}
        >
          {mask.label}
        </button>
      </div>
    </div>
  );
});
