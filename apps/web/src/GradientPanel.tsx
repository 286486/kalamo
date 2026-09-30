import {
  type ColorStop,
  type Document,
  drawnStops,
  type Gradient,
  type LeafNode,
  worldTransform,
} from "@kalamo/core";
import { memo, useEffect, useRef, useState } from "react";
import { TEAR_OFF } from "./annotator.ts";
import {
  activeGradient,
  addStop,
  angleOf,
  type Box,
  cancelPaint,
  DEFAULT_STOPS,
  moveStop,
  ownAngle,
  paintTargets,
  paintUpdates,
  placeOn,
  previewPaint,
  removeStop,
  reverseStops,
  sendPaint,
  setColor,
  setMidpoint,
  withAngle,
  withPaints,
} from "./gradient.ts";
import { canEdit, useStore } from "./store.ts";

/** The slider's width in CSS px. */
const WIDTH = 220;

/** The gradient's drawn stops as a CSS gradient, as the canvas draws them. */
const css = (stops: ColorStop[]) =>
  `linear-gradient(to right, ${drawnStops({ stops })
    .map((s) => `${s.color} ${s.offset * 100}%`)
    .join(", ")})`;

const round = (v: number, places = 1) => Math.round(v * 10 ** places) / 10 ** places;

/** A number field that commits on Enter or blur, one Transaction each, not per keystroke. */
function NumberField(props: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  commit: (v: number) => void;
}) {
  const { label, value, min, max, commit } = props;
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const done = () => {
    const v = Number(text);
    if (text.trim() === "" || !Number.isFinite(v) || v === value) return setText(String(value));
    commit(Math.min(max ?? v, Math.max(min ?? v, v)));
  };
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
      {label}
      <input
        type="number"
        aria-label={label}
        value={text}
        min={min}
        max={max}
        style={{ width: 56 }}
        onChange={(e) => setText(e.target.value)}
        onBlur={done}
        onKeyDown={(e) => {
          if (e.key === "Enter") done();
          // A field's keys are not the canvas's.
          e.stopPropagation();
        }}
      />
    </label>
  );
}

/**
 * Illustrator's Gradient panel (ADR-0081): the active paint of the Selection's leaves, as the Fill or
 * Stroke box chooses; each change is one Transaction, a drag's once on release.
 */
export const GradientPanel = memo(function GradientPanel() {
  const doc = useStore((s) => s.doc);
  const selection = useStore((s) => s.selection);
  const preview = useStore((s) => s.paintPreview);
  const box = useStore((s) => s.fillStroke.active);
  const editor = useStore(canEdit);
  const [picked, setPicked] = useState<{ kind: "stop" | "midpoint"; index: number }>({
    kind: "stop",
    index: 0,
  });
  const drag = useRef<{ index: number; kind: "stop" | "midpoint"; stops: ColorStop[] } | null>(
    null,
  );
  const colorRef = useRef<HTMLInputElement>(null);

  const targets = doc ? paintTargets(doc, selection) : [];
  const shownDoc = doc && preview ? withPaints(doc, preview.updates) : doc;
  const first = targets[0] && (shownDoc?.nodes.get(targets[0].id) as LeafNode | undefined);
  const g = activeGradient(first, box);
  const enabled = editor && targets.length > 0;
  const stops = g?.stops ?? DEFAULT_STOPS;
  const index = Math.min(picked.index, stops.length - 1);
  const stop = stops[index] as ColorStop;

  const apply = (next: (g: Gradient | null, n: LeafNode) => Gradient | null, live = false) => {
    const updates = paintUpdates(targets, box, next);
    if (live) previewPaint(updates);
    else sendPaint(updates);
  };
  /** Every target's stops made `s`, a solid paint taking the default geometry. */
  const withStops =
    (s: ColorStop[]) =>
    (old: Gradient | null, n: LeafNode): Gradient =>
      old ? { ...old, stops: s } : placeOn(n, { type: "linear", stops: s });

  // The browser's picker commits once, on its change event; its input events preview.
  useEffect(() => {
    const el = colorRef.current;
    if (!el) return;
    const commit = () => {
      const alpha = stop.color.slice(7);
      apply(withStops(setColor(stops, index, el.value.toUpperCase() + alpha)));
    };
    el.addEventListener("change", commit);
    return () => el.removeEventListener("change", commit);
  });

  const toggle = (b: Box) => () =>
    useStore.setState((s) => ({ fillStroke: { ...s.fillStroke, active: b } }));
  const offsetAt = (e: React.PointerEvent, el: Element) => {
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };

  return (
    <section
      aria-label="Gradient"
      style={{ padding: 8, borderBottom: "1px solid #CCC", display: "grid", gap: 6 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <strong style={{ flex: 1 }}>Gradient</strong>
        {(["fill", "stroke"] as const).map((b) => (
          <button
            key={b}
            type="button"
            aria-pressed={box === b}
            onClick={toggle(b)}
            style={{ background: box === b ? "#DCE6FF" : undefined }}
          >
            {b === "fill" ? "Fill" : "Stroke"}
          </button>
        ))}
      </div>
      <fieldset
        disabled={!enabled}
        style={{ border: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button
            type="button"
            aria-label="Gradient thumbnail"
            title="Apply the gradient"
            // On a solid paint or none, Illustrator's default gradient: white to black, linear.
            onClick={() => apply((old, n) => (old ? null : placeOn(n, { type: "linear", stops })))}
            style={{ width: 32, height: 32, border: "1px solid #666", background: css(stops) }}
          />
          <select
            aria-label="Type"
            value={g?.type ?? "linear"}
            // Keeps the stops and midpoints; the geometry is the new type's default.
            onChange={(e) => {
              const type = e.target.value as Gradient["type"];
              apply((_, n) => placeOn(n, { type, stops }));
            }}
          >
            <option value="linear">Linear</option>
            <option value="radial">Radial</option>
          </select>
          <button
            type="button"
            title="Reverse Gradient"
            onClick={() => apply(withStops(reverseStops(stops)))}
          >
            ⇄
          </button>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <NumberField
            label="Angle"
            value={round(g && first && doc ? angleOf(g, worldTransform(doc, first)) : 0)}
            commit={(a) =>
              apply((old, n) => {
                const m = worldTransform(doc as Document, n);
                return old
                  ? withAngle(old, a, m)
                  : placeOn(n, { type: "linear", stops, angle: ownAngle(m, a) });
              })
            }
          />
          {g?.type === "radial" && (
            <NumberField
              label="Aspect Ratio %"
              value={round(g.aspectRatio * 100)}
              min={1}
              commit={(v) =>
                apply((old, n) =>
                  old?.type === "radial" ? placeOn(n, { ...old, aspectRatio: v / 100 }) : null,
                )
              }
            />
          )}
        </div>
        {/* The slider: midpoints above it, Color Stops below; a click below adds a stop. */}
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would reset the slider's layout */}
        <div
          role="group"
          aria-label="Gradient slider"
          style={{ position: "relative", width: WIDTH, height: 44, margin: "0 8px" }}
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget || e.nativeEvent.offsetY < 26) return;
            const added = addStop(stops, offsetAt(e, e.currentTarget));
            setPicked({ kind: "stop", index: added.index });
            apply(withStops(added.stops));
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const t = offsetAt(e, e.currentTarget);
            const r = e.currentTarget.getBoundingClientRect();
            if (d.kind === "midpoint") {
              const [s, next] = [d.stops[d.index], d.stops[d.index + 1]];
              if (!s || !next || next.offset === s.offset) return;
              const m = (t - s.offset) / (next.offset - s.offset);
              return apply(withStops(setMidpoint(d.stops, d.index, m)), true);
            }
            const off = e.clientY - r.bottom > TEAR_OFF && removeStop(d.stops, d.index);
            apply(withStops(off || moveStop(d.stops, d.index, t).stops), true);
          }}
          onPointerUp={() => {
            const d = drag.current;
            drag.current = null;
            const shown = useStore.getState().paintPreview;
            if (!d || !shown || shown.commandId) return;
            sendPaint(shown.updates);
          }}
          onPointerCancel={() => {
            drag.current = null;
            cancelPaint();
          }}
        >
          <div
            style={{
              position: "absolute",
              top: 12,
              left: 0,
              right: 0,
              height: 14,
              border: "1px solid #999",
              background: css(stops),
              pointerEvents: "none",
            }}
          />
          {stops.map((s, i) => {
            const next = stops[i + 1];
            if (!next) return null;
            const at = s.offset + (s.midpoint ?? 0.5) * (next.offset - s.offset);
            const chosen = picked.kind === "midpoint" && picked.index === i;
            return (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: a midpoint has no identity but its place
                key={`m${i}`}
                type="button"
                aria-label={`Midpoint ${i + 1}`}
                onPointerDown={(e) => {
                  e.currentTarget.parentElement?.setPointerCapture(e.pointerId);
                  setPicked({ kind: "midpoint", index: i });
                  drag.current = { kind: "midpoint", index: i, stops };
                }}
                style={{
                  position: "absolute",
                  left: at * WIDTH - 5,
                  top: 0,
                  width: 10,
                  height: 10,
                  padding: 0,
                  transform: "rotate(45deg)",
                  border: "1px solid #333",
                  background: chosen ? "#333" : "#FFF",
                }}
              />
            );
          })}
          {stops.map((s, i) => (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: stops have no identity but their place
              key={`s${i}`}
              type="button"
              aria-label={`Color Stop ${i + 1}`}
              aria-pressed={picked.kind === "stop" && index === i}
              onPointerDown={(e) => {
                e.currentTarget.parentElement?.setPointerCapture(e.pointerId);
                setPicked({ kind: "stop", index: i });
                drag.current = { kind: "stop", index: i, stops };
              }}
              style={{
                position: "absolute",
                left: s.offset * WIDTH - 6,
                top: 30,
                width: 12,
                height: 12,
                padding: 0,
                border:
                  picked.kind === "stop" && index === i ? "2px solid #4F80FF" : "1px solid #333",
                background: s.color,
              }}
            />
          ))}
        </div>
        {picked.kind === "stop" ? (
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <input
              ref={colorRef}
              type="color"
              aria-label="Stop color"
              value={stop.color.slice(0, 7).toLowerCase()}
              onChange={(e) => {
                const color = e.target.value.toUpperCase() + stop.color.slice(7);
                apply(withStops(setColor(stops, index, color)), true);
              }}
            />
            <NumberField
              label="Opacity %"
              min={0}
              max={100}
              value={round(
                (stop.color.length === 9 ? Number.parseInt(stop.color.slice(7), 16) : 255) / 2.55,
                0,
              )}
              commit={(v) => {
                const a = Math.round((v / 100) * 255);
                const hex = a === 255 ? "" : a.toString(16).padStart(2, "0").toUpperCase();
                apply(withStops(setColor(stops, index, stop.color.slice(0, 7) + hex)));
              }}
            />
            <NumberField
              label="Location %"
              min={0}
              max={100}
              value={round(stop.offset * 100)}
              commit={(v) => {
                const moved = moveStop(stops, index, v / 100);
                setPicked({ kind: "stop", index: moved.index });
                apply(withStops(moved.stops));
              }}
            />
            <button
              type="button"
              title="Delete Stop"
              disabled={stops.length <= 2}
              onClick={() => {
                const left = removeStop(stops, index);
                if (left) apply(withStops(left));
              }}
            >
              Delete
            </button>
          </div>
        ) : (
          <NumberField
            label="Midpoint Location %"
            min={13}
            max={87}
            value={round((stops[picked.index]?.midpoint ?? 0.5) * 100)}
            commit={(v) => apply(withStops(setMidpoint(stops, picked.index, v / 100)))}
          />
        )}
      </fieldset>
    </section>
  );
});
