import { memo, useEffect, useRef, useState } from "react";
import { VIEWER_TOOLS } from "./receive.ts";
import { canEdit, useStore } from "./store.ts";
import { TOOLS, type Tool, type ToolSlot, toolSlots } from "./toolbox.ts";
import { type FillStroke, fillStrokeKey, setTool } from "./tools.ts";

const glyph = (d: string, fill = "none") => (
  <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true">
    <path d={d} fill={fill} stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);
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

const ALL_TOOLS = Object.keys(TOOLS) as Tool[];
const labelOf = (t: Tool) => {
  const { title, shortcut } = TOOLS[t];
  return shortcut ? `${title} (${shortcut})` : title;
};
/** How long a press on a group's button holds before its flyout opens, in ms. */
const HOLD_MS = 300;

/**
 * A Tools panel button. A group's shows the tool last chosen from it, with a corner triangle;
 * holding it, right-clicking it, or Enter or Space on it opens a flyout of the group's tools.
 */
function ToolButton({ slot, tool }: { slot: ToolSlot; tool: Tool }) {
  const { shown } = slot;
  const group = slot.tools.length > 1;
  /** How the flyout was opened: a keyboard's leaves focus on the button when it closes. */
  const [open, setOpen] = useState<"key" | "pointer" | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const hold = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** Set when a hold opened the flyout, so the press's click selects nothing. */
  const held = useRef(false);
  const stopHold = () => clearTimeout(hold.current);
  const close = (focusButton: boolean) => {
    setOpen(null);
    if (focusButton) wrap.current?.querySelector<HTMLElement>("button")?.focus();
    else if (wrap.current?.contains(document.activeElement))
      (document.activeElement as HTMLElement).blur();
  };
  const choose = (t: Tool, byKey: boolean) => {
    held.current = false;
    setTool(t);
    close(byKey && open === "key");
  };

  useEffect(() => {
    if (!open) return;
    wrap.current?.querySelector<HTMLElement>("[role=menuitemradio][aria-checked=true]")?.focus();
    const outside = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(null);
    };
    addEventListener("pointerdown", outside, true);
    return () => removeEventListener("pointerdown", outside, true);
  }, [open]);
  useEffect(() => () => clearTimeout(hold.current), []);

  const onMenuKey = (e: React.KeyboardEvent) => {
    const items = [...(wrap.current?.querySelectorAll<HTMLElement>("[role=menuitemradio]") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (step) items[(at + step + items.length) % items.length]?.focus();
    else if (e.key === "Home") items[0]?.focus();
    else if (e.key === "End") items.at(-1)?.focus();
    else if (e.key === "Escape") close(open === "key");
    // Pressed here: the Viewer takes Space's keyup to pan, which would cancel the native press.
    else if (e.key === "Enter" || e.key === " ") items[at]?.click();
    // Another key, a tool's shortcut or Tab, leaves the flyout.
    else return setOpen(null);
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div ref={wrap} style={{ position: "relative" }}>
      <button
        type="button"
        title={labelOf(shown)}
        aria-label={labelOf(shown)}
        aria-pressed={tool === shown}
        aria-haspopup={group ? "menu" : undefined}
        aria-expanded={group ? open !== null : undefined}
        onPointerDown={(e) => {
          held.current = false;
          if (!group || e.button !== 0) return;
          // A touch's release must land on the tool it is over, not on this button.
          e.currentTarget.releasePointerCapture(e.pointerId);
          hold.current = setTimeout(() => {
            held.current = true;
            setOpen("pointer");
          }, HOLD_MS);
        }}
        onPointerUp={stopHold}
        onPointerLeave={stopHold}
        onClick={() => {
          if (held.current) held.current = false;
          else choose(shown, false);
        }}
        onContextMenu={(e) => {
          if (!group) return;
          e.preventDefault();
          setOpen("pointer");
        }}
        onKeyDown={(e) => {
          if (!group || (e.key !== "Enter" && e.key !== " ")) return;
          // The flyout, not a click; and Space does not pan.
          e.preventDefault();
          e.stopPropagation();
          setOpen("key");
        }}
        onDoubleClick={() => TOOLS[shown].options?.()}
        style={{ ...button, position: "relative", background: tool === shown ? "#DCE6FF" : "none" }}
      >
        {glyph(TOOLS[shown].icon, TOOLS[shown].iconFill)}
        {group && (
          <svg
            width="4"
            height="4"
            viewBox="0 0 4 4"
            aria-hidden="true"
            style={{ position: "absolute", right: 2, bottom: 2 }}
          >
            <path d="M4 0 V4 H0 Z" fill="currentColor" />
          </svg>
        )}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={`${TOOLS[slot.tools[0] ?? shown].title}s`}
          aria-orientation="vertical"
          onKeyDown={onMenuKey}
          onBlur={(e) => {
            if (!wrap.current?.contains(e.relatedTarget)) setOpen(null);
          }}
          style={{
            position: "absolute",
            left: "calc(100% + 6px)",
            top: -4,
            zIndex: 10,
            padding: 4,
            display: "flex",
            flexDirection: "column",
            background: "#F5F5F5",
            border: "1px solid #CCC",
            borderRadius: 4,
            boxShadow: "0 2px 6px rgb(0 0 0 / 20%)",
          }}
        >
          {slot.tools.map((t) => (
            <button
              key={t}
              type="button"
              role="menuitemradio"
              aria-checked={t === shown}
              aria-label={labelOf(t)}
              // A hold's release over a tool chooses it, as in Illustrator.
              onPointerUp={() => held.current && choose(t, false)}
              onClick={(e) => choose(t, e.detail === 0)}
              style={{
                ...button,
                width: "auto",
                display: "flex",
                gap: 8,
                padding: "0 8px 0 4px",
                whiteSpace: "nowrap",
                font: "12px system-ui",
                background: t === shown ? "#DCE6FF" : "none",
              }}
            >
              {glyph(TOOLS[t].icon, TOOLS[t].iconFill)}
              <span style={{ flex: 1, textAlign: "left" }}>{TOOLS[t].title}</span>
              <span style={{ color: "#777" }}>{TOOLS[t].shortcut}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Illustrator's Tools panel on the canvas's left: the tools, then the Fill and Stroke boxes. */
export const Tools = memo(function Tools() {
  const tool = useStore((s) => s.tool);
  const fillStroke = useStore((s) => s.fillStroke);
  const tools = useStore((s) => (canEdit(s) ? ALL_TOOLS : VIEWER_TOOLS));
  const front = useStore((s) => s.front);
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
      {toolSlots(tools, front).map((slot) => (
        <ToolButton key={slot.tools[0]} slot={slot} tool={tool} />
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
