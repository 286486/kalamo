import { lockedIn } from "@kalamo/core";
import { memo, useState } from "react";
import {
  type Drop,
  dropAt,
  dropCopies,
  dropMoves,
  duplicateRows,
  layerIsolation,
  layerMask,
  nameOf,
  rows,
} from "./layers.ts";
import { combine, objects } from "./selection.ts";
import { canEdit, send, useStore } from "./store.ts";

const SELECTED = "#DCE6FF";
const DROP = "#3B6CF6";
/** A row's indent per depth. */
const INDENT = 14;
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
  const isolated = useStore((s) => s.isolated);
  const editor = useStore(canEdit);
  const layerRows = useStore((s) => s.layerRows);
  const [toggled, setToggled] = useState(() => new Set<string>());
  // The Nodes a drag in the panel carries, and where it would drop them (ADR-0075).
  const [dragged, setDragged] = useState<string[] | null>(null);
  const [drop, setDrop] = useState<(Drop & { row: string; depth: number }) | null>(null);
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
  const mask = layerMask(doc, selection, isolated);
  const isolation = layerIsolation(doc, selection, isolated);
  const listed = rows(doc, toggled, isolated);
  const duplicate = duplicateRows(doc, [...layerRows, ...selection], isolated);
  const runDuplicate = (e: React.MouseEvent<HTMLButtonElement>) => {
    const { input } = duplicate;
    if (!editor || !input) return;
    // Closing hands focus back to the menu button; the keys then go back to the Document, as after
    // a menu bar command.
    (e.currentTarget.closest("[popover]") as HTMLElement).hidePopover();
    (document.activeElement as HTMLElement | null)?.blur();
    // One duplicate Command beside the originals (ADR-0076), whose copies become the Selection.
    const commandId = send({ type: "duplicate", input });
    useStore.setState((s) => ({
      notice: null,
      pending: [...s.pending, { commandId, nodes: [], select: true }],
    }));
  };

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
      {/* Illustrator's panel menu, keyboard-operable as the menu bar's menus are (#195). */}
      <style>
        {
          "#layers-menu [role=menuitem] { background: none; } #layers-menu [role=menuitem]:focus { background: #DCE6FF; outline: none; }"
        }
      </style>
      <div style={{ display: "flex", justifyContent: "flex-end", borderBottom: "1px solid #CCC" }}>
        <button
          type="button"
          aria-label="Layers panel menu"
          aria-haspopup="menu"
          popoverTarget="layers-menu"
          style={{ ...icon, width: 24 }}
        >
          ☰
        </button>
        <div
          id="layers-menu"
          role="menu"
          aria-label="Layers panel menu"
          popover="auto"
          style={{
            position: "fixed",
            inset: "auto",
            top: 24,
            right: 4,
            margin: 0,
            padding: "4px 0",
            background: "#F5F5F5",
            border: "1px solid #BBB",
            boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
          }}
          onToggle={(e) => {
            if (e.newState === "open") e.currentTarget.querySelector("button")?.focus();
          }}
        >
          <button
            type="button"
            role="menuitem"
            aria-disabled={!editor || !duplicate.input}
            onClick={runDuplicate}
            // No inline background, so the stylesheet's focus colour shows.
            style={{
              height: 20,
              border: "none",
              cursor: "pointer",
              width: "100%",
              padding: "3px 20px",
              textAlign: "left",
              whiteSpace: "nowrap",
              color: editor && duplicate.input ? undefined : "#999",
            }}
          >
            {duplicate.label}
          </button>
        </div>
      </div>
      <ul
        aria-label="Layers"
        style={{ flex: 1, overflow: "auto", margin: 0, padding: 0, listStyle: "none" }}
      >
        {listed.map(({ node, depth, expandable, expanded, dimmed, underlined }, i) => {
          const label = nameOf(doc, node);
          const selected = selection.includes(node.id);
          const highlighted = selected || layerRows.includes(node.id);
          const pick = (e: React.MouseEvent) => {
            const { doc, selection } = useStore.getState();
            if (!doc) return;
            // A Layer or an isolated container is never selected itself: its row selects the objects
            // in it. An isolated leaf's row selects the leaf.
            const ids =
              node.type !== "layer" && node.id !== isolated
                ? [node.id]
                : dimmed
                  ? []
                  : objects(doc, node.id).map((n) => n.id);
            const next = combine(selection, ids, { shift: e.shiftKey, alt: e.altKey });
            // A Layer's row is also selected itself, for Duplicate (ADR-0076), as combine treats
            // the Selection: a click selects it alone, Shift+click toggles it and Alt+Shift+click
            // removes it, keeping the others. The array is always new, so the store sees the rows
            // set with this Selection and keeps them.
            const current = useStore.getState().layerRows;
            const others = current.filter((id) => id !== node.id);
            const layer = node.type === "layer";
            let layers: string[];
            if (!e.shiftKey) layers = layer ? [node.id] : [];
            else if (!layer) layers = [...current];
            else if (e.altKey || others.length < current.length) layers = others;
            else layers = [...others, node.id];
            useStore.setState({ notice: null, selection: next, layerRows: layers });
          };
          // The pointer's height in the row picks the zone, its indent the depth of a gap (ADR-0075).
          const pointer = (e: React.DragEvent) => {
            const { top, left, height } = e.currentTarget.getBoundingClientRect();
            const level = Math.floor((e.clientX - left - 4) / INDENT);
            return { ...dropAt(listed, i, (e.clientY - top) / height, level), row: node.id };
          };
          const indicated = drop?.row === node.id ? drop : undefined;
          // A row in a locked container does not drag, as the drop would leave its Node in place.
          const movable = editor && !lockedIn(doc, doc.nodes.get(node.parentId ?? ""));
          return (
            <li
              key={node.id}
              aria-label={label}
              // A viewer's rows do not drag; the server would refuse the Command anyway (ADR-0047).
              draggable={movable}
              data-drop={indicated?.zone}
              onDragStart={(e) => {
                // A drag of text selected in a row that does not drag carries no Node.
                if (!movable) return;
                e.dataTransfer.effectAllowed = "copyMove";
                // A selected row carries the Selection with it, another row only itself.
                setDragged(selected ? selection : [node.id]);
              }}
              onDragEnd={() => {
                setDragged(null);
                setDrop(null);
              }}
              onDragOver={(e) => {
                if (!dragged) return;
                const at = pointer(e);
                // ponytail: re-plans the drop on every dragover; cache per row and zone if it lags.
                if (!dropMoves(doc, dragged, at, isolated)) return setDrop(null);
                e.preventDefault();
                // Alt copies (ADR-0075): the browser's plus cursor while it is down.
                e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
                if (at.row !== drop?.row || at.zone !== drop.zone || at.depth !== drop.depth) {
                  setDrop(at);
                }
              }}
              onDragLeave={(e) => {
                // Entering the row's own buttons is no leave.
                if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) {
                  setDrop(null);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const { doc, isolated } = useStore.getState();
                setDragged(null);
                setDrop(null);
                if (!doc || !dragged) return;
                // Alt at the release copies, as on the canvas (ADR-0076), and the copies become
                // the Selection, as drawn art does.
                if (e.altKey) {
                  const input = dropCopies(doc, dragged, pointer(e), isolated);
                  if (!input) return;
                  const commandId = send({ type: "duplicate", input });
                  useStore.setState((s) => ({
                    notice: null,
                    pending: [...s.pending, { commandId, nodes: [], select: true }],
                  }));
                  return;
                }
                const plan = dropMoves(doc, dragged, pointer(e), isolated);
                // Nothing is sent when no Node would change place, so Undo has no empty step.
                if (!plan?.moved) return;
                useStore.setState({ notice: null });
                send({ type: "reparent", moves: plan.moves });
              }}
              style={{
                display: "flex",
                alignItems: "center",
                height: 22,
                paddingLeft: 4 + depth * INDENT,
                backgroundColor: highlighted ? SELECTED : undefined,
                opacity: dimmed ? 0.5 : 1,
                borderBottom: "1px solid #E4E4E4",
                // Illustrator's indicators: the container outlined, or a line in the gap from the
                // indent of the depth it drops at.
                boxShadow: indicated?.zone === "onto" ? `inset 0 0 0 2px ${DROP}` : undefined,
                ...(indicated &&
                  indicated.zone !== "onto" && {
                    backgroundImage: `linear-gradient(${DROP}, ${DROP})`,
                    backgroundRepeat: "no-repeat",
                    backgroundSize: "100% 2px",
                    backgroundPosition: `${4 + indicated.depth * INDENT}px ${indicated.zone === "above" ? 0 : "100%"}`,
                  }),
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
                aria-pressed={highlighted}
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
            </li>
          );
        })}
      </ul>
      {/*
        Illustrator's Make/Release Clipping Mask (ADR-0053) and its panel menu's Enter Isolation
        Mode (ADR-0058) at the panel's foot. A viewer isolates as it selects (ADR-0057).
      */}
      <div style={{ display: "flex", gap: 4, padding: 4, borderTop: "1px solid #CCC" }}>
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
        <button
          type="button"
          disabled={!isolation.target}
          aria-label={isolation.label}
          title={isolation.label}
          onClick={() => {
            if (isolation.target) {
              useStore.setState({ notice: null, isolated: isolation.target, selection: [] });
            }
          }}
        >
          Isolation Mode
        </button>
      </div>
    </div>
  );
});
