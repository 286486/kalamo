import { memo } from "react";
import { useStore } from "./store.ts";
import { type FillStroke, fillStrokeKey, setTool, type Tool } from "./tools.ts";

const glyph = (d: string) => (
  <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);
const TOOLS: [Tool, string, React.ReactNode][] = [
  ["selection", "Selection Tool (V)", glyph("M4 2 L4 13 L7 10 L9 14 L11 13 L9 9 L13 9 Z")],
  ["zoom", "Zoom Tool (Z)", glyph("M2 7 A5 5 0 1 0 12 7 A5 5 0 1 0 2 7 M10.5 10.5 L14.5 14.5")],
  ["pen", "Pen Tool (P)", glyph("M8 1 L12 8 L10 14 H6 L4 8 Z M8 1 V8 M7 8 A1 1 0 1 0 9 8")],
];
const button: React.CSSProperties = {
  width: 28,
  height: 28,
  padding: 0,
  display: "grid",
  placeItems: "center",
  border: "none",
  borderRadius: 3,
  color: "#333",
  cursor: "pointer",
};
/** Illustrator's None: white with a red diagonal. */
const NONE = "linear-gradient(to top left, #FFF 45%, #E00 45% 55%, #FFF 55%)";

/** A Fill or Stroke box; a click makes it active and opens the browser's color picker. */
function Box({ fillStroke, box }: { fillStroke: FillStroke; box: "fill" | "stroke" }) {
  const color = fillStroke[box];
  const size = 22;
  const at = box === "fill" ? 0 : 10;
  return (
    <label
      title={box === "fill" ? "Fill" : "Stroke"}
      style={{
        position: "absolute",
        left: at,
        top: at,
        width: size,
        height: size,
        boxSizing: "border-box",
        zIndex: fillStroke.active === box ? 1 : 0,
        cursor: "pointer",
        border: "1px solid #666",
        background: box === "stroke" ? (color ?? NONE) : "#FFF",
        padding: box === "stroke" ? 5 : 0,
      }}
      onPointerDown={() => useStore.setState({ fillStroke: { ...fillStroke, active: box } })}
    >
      <span
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          boxSizing: "border-box",
          background: box === "fill" ? (color ?? NONE) : "#F5F5F5",
          border: box === "stroke" ? "1px solid #666" : "none",
        }}
      />
      <input
        type="color"
        aria-label={box === "fill" ? "Fill" : "Stroke"}
        value={(color ?? "#000000").toLowerCase()}
        onChange={(e) => {
          const { fillStroke } = useStore.getState();
          useStore.setState({ fillStroke: { ...fillStroke, [box]: e.target.value.toUpperCase() } });
        }}
        // Over the whole box, invisible, so a click on the box opens the picker.
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          margin: 0,
          padding: 0,
          border: 0,
          opacity: 0,
          cursor: "pointer",
        }}
      />
    </label>
  );
}

/** Illustrator's Tools panel on the canvas's left: the tools, then the Fill and Stroke boxes. */
export const Tools = memo(function Tools() {
  const tool = useStore((s) => s.tool);
  const fillStroke = useStore((s) => s.fillStroke);
  const key = (keys: string) => () => {
    const next = fillStrokeKey(useStore.getState().fillStroke, keys);
    if (next) useStore.setState({ fillStroke: next });
  };
  const small = { ...button, width: 16, height: 16, background: "none", font: "10px system-ui" };
  return (
    <div
      role="toolbar"
      aria-label="Tools"
      aria-orientation="vertical"
      // A click must not leave focus on a button, where Enter and Space would press it again.
      onMouseDown={(e) => (e.target as Element).closest("button") && e.preventDefault()}
      style={{
        position: "absolute",
        top: 8,
        left: 8,
        padding: 4,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 2,
        background: "#F5F5F5",
        border: "1px solid #CCC",
        borderRadius: 4,
      }}
    >
      {TOOLS.map(([t, label, icon]) => (
        <button
          key={t}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={tool === t}
          onClick={() => setTool(t)}
          style={{ ...button, background: tool === t ? "#DCE6FF" : "none" }}
        >
          {icon}
        </button>
      ))}
      <div style={{ position: "relative", width: 32, height: 32, marginTop: 6 }}>
        <Box fillStroke={fillStroke} box="fill" />
        <Box fillStroke={fillStroke} box="stroke" />
      </div>
      <div style={{ display: "flex" }}>
        <button type="button" title="Default Fill and Stroke (D)" style={small} onClick={key("D")}>
          ◩
        </button>
        <button
          type="button"
          title="Swap Fill and Stroke (Shift+X)"
          style={small}
          onClick={key("Shift+X")}
        >
          ⇄
        </button>
        <button type="button" title="None (/)" style={small} onClick={key("/")}>
          ⊘
        </button>
      </div>
    </div>
  );
});
