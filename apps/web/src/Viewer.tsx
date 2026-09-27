import { bounds, type Rect } from "@zibel/core";
import { toSvg } from "@zibel/io/write";
import { drawDocument } from "@zibel/render/canvas";
import blackUrl from "@zibel/render/fonts/SourceSans3-Black.ttf?url";
import blackItalicUrl from "@zibel/render/fonts/SourceSans3-BlackIt.ttf?url";
import boldUrl from "@zibel/render/fonts/SourceSans3-Bold.ttf?url";
import boldItalicUrl from "@zibel/render/fonts/SourceSans3-BoldIt.ttf?url";
import italicUrl from "@zibel/render/fonts/SourceSans3-It.ttf?url";
import regularUrl from "@zibel/render/fonts/SourceSans3-Regular.ttf?url";
import { useEffect, useMemo, useRef, useState } from "react";
import { imageCache } from "./images.ts";
import { Layers } from "./Layers.tsx";
import { menuOpen } from "./MenuBar.tsx";
import { keysOf } from "./menu.ts";
import { pastedArt, place, placeable } from "./place.ts";
import { preview } from "./receive.ts";
import { combine, editable, hitTest, marquee } from "./selection.ts";
import { connect, send, useStore } from "./store.ts";
import { Tools } from "./Tools.tsx";
import { drawing, fillStrokeKey, finishPen, pathD, penClick, setTool, TOOL_KEYS } from "./tools.ts";
import { artboardsRect, fit, toDoc, type Viewport, zoomAt } from "./viewport.ts";

const PASTEBOARD = "#E6E6E6";
/** Illustrator's first Layer colour, used for the Selection and the marquee. */
const SELECTION = "#4F80FF";
/** Screen px the pointer may wander before a press becomes a drag, and the hit tolerance. */
const SLOP = 3;

type Point = { x: number; y: number };
type Mods = { shift: boolean; alt: boolean };
/** A press of the Selection tool: moving the Selection, or drawing a marquee. */
type Gesture =
  | { kind: "move"; start: Point; nodeIds: string[]; moved: boolean }
  | { kind: "marquee"; start: Point; mods: Mods; moved: boolean };

const rectOf = (a: Point, b: Point): Rect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(a.x - b.x),
  height: Math.abs(a.y - b.y),
});

/** Pinch sends small deltas and passes through; a mouse-wheel notch (about 100) is capped to x1.65. */
const wheelZoom = (deltaY: number) => Math.exp(-Math.max(-50, Math.min(50, deltaY)) * 0.01);

// The faces the Worker renders with (ADR-0013, ADR-0028), loaded once per page.
// Settled, not all: a face that fails leaves the others to draw.
const fontLoaded = Promise.allSettled(
  (
    [
      [regularUrl, "400", "normal"],
      [italicUrl, "400", "italic"],
      [boldUrl, "700", "normal"],
      [boldItalicUrl, "700", "italic"],
      [blackUrl, "900", "normal"],
      [blackItalicUrl, "900", "italic"],
    ] as const
  ).map(([url, weight, style]) => {
    const face = new FontFace("Source Sans 3", `url(${url})`, { weight, style });
    document.fonts.add(face);
    return face.load();
  }),
);

/** A live view of one Document: select, drag-move and delete its objects, and draw with the Pen. */
export function Viewer({ docId }: { docId: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { doc, live, viewport, selection, drag, pen, notice, size, layersShown, tool, fillStroke } =
    useStore();
  /** Space held: drag pans. */
  const [hand, setHand] = useState(false);
  const [alt, setAlt] = useState(false);
  /** Where the Pen's rubber band ends, in document coordinates. */
  const [pointer, setPointer] = useState<[number, number] | null>(null);
  /** Pointer position at the last pan step; movementX/Y scale with devicePixelRatio in some Chromes. */
  const last = useRef({ x: 0, y: 0 });
  const gesture = useRef<Gesture | null>(null);
  const [marqueeRect, setMarqueeRect] = useState<Rect | null>(null);
  /** True once the faces have settled; until then text draws in a fallback font. */
  const [fontReady, setFontReady] = useState(false);
  /** Counts image files decoded, so the canvas redraws as each arrives. */
  const [imagesLoaded, setImagesLoaded] = useState(0);
  const images = useMemo(() => imageCache(docId, () => setImagesLoaded((n) => n + 1)), [docId]);
  useEffect(() => {
    useStore.setState({ images });
    // Until the next tab's Viewer sets its own, a download must not pair its cache with this Document.
    return () => useStore.setState({ images: null });
  }, [images]);

  useEffect(() => {
    fontLoaded.then((faces) => {
      for (const f of faces)
        if (f.status === "rejected")
          console.warn(
            "A Source Sans 3 face did not load; its text draws in a fallback.",
            f.reason,
          );
      setFontReady(true);
    });
  }, []);

  useEffect(() => {
    const stop = connect(docId);
    // Leaving the tab finishes a path the Pen is drawing, as a tool switch does.
    return () => {
      finishPen();
      stop();
    };
  }, [docId]);

  useEffect(() => {
    if (doc) document.title = `${doc.name} – Zibel`;
  }, [doc]);

  // Track the canvas size in CSS px.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        const { width, height } = entry.contentRect;
        useStore.setState({ size: { width, height } });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Fit the Artboards once the first Document arrives.
  useEffect(() => {
    if (doc && !viewport && size.width > 0) {
      useStore.setState({ viewport: fit(artboardsRect(doc), size.width, size.height) });
    }
  }, [doc, viewport, size]);

  // ponytail: redraws everything on every change; add viewport culling and dirty rects for 5k+ Nodes (F-VIEW-08).
  // biome-ignore lint/correctness/useExhaustiveDependencies: fontReady and imagesLoaded redraw text and Images once their font or files are in
  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    // On a tab switch the store holds the last tab's Document until connect clears it.
    if (!el || !ctx || doc?.id !== docId || !viewport) return;
    const dpr = devicePixelRatio;
    el.width = Math.round(size.width * dpr);
    el.height = Math.round(size.height * dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = PASTEBOARD;
    ctx.fillRect(0, 0, el.width, el.height);
    const { x, y, scale } = viewport;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * x, dpr * y);
    for (const { frame } of doc.artboards) {
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(frame.x, frame.y, frame.width, frame.height);
      ctx.lineWidth = 1 / scale;
      ctx.strokeStyle = "#000000";
      ctx.strokeRect(frame.x, frame.y, frame.width, frame.height);
    }
    // Hit tests use `doc`; only the drawing shows the drag.
    const shown = drag ? preview(doc, drag) : doc;
    images.want(shown);
    drawDocument(ctx, shown, images.get);
    ctx.lineWidth = 1 / scale;
    ctx.strokeStyle = SELECTION;
    for (const id of selection) {
      const node = shown.nodes.get(id);
      const b = node && bounds(shown, node);
      if (b) ctx.strokeRect(b.x, b.y, b.width, b.height);
    }
    if (pen) {
      // The path so far in its Fill and Stroke, then its outline, rubber band and Anchors.
      const rubber = drawing(useStore.getState()) && pointer;
      const points = rubber ? [...pen.points, pointer] : pen.points;
      const path = new Path2D(pathD(points, pen.closed));
      if (fillStroke.fill) {
        ctx.fillStyle = fillStroke.fill;
        ctx.fill(path);
      }
      if (fillStroke.stroke) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = fillStroke.stroke;
        ctx.stroke(path);
      }
      ctx.lineWidth = 1 / scale;
      ctx.strokeStyle = SELECTION;
      ctx.stroke(path);
      const r = 3 / scale;
      for (const [px, py] of pen.points) ctx.strokeRect(px - r, py - r, 2 * r, 2 * r);
    }
    if (marqueeRect) {
      ctx.setLineDash([4 / scale, 4 / scale]);
      const { x: mx, y: my, width, height } = marqueeRect;
      ctx.strokeRect(mx, my, width, height);
      ctx.setLineDash([]);
    }
  }, [
    doc,
    docId,
    viewport,
    size,
    selection,
    drag,
    pen,
    pointer,
    fillStroke,
    marqueeRect,
    fontReady,
    images,
    imagesLoaded,
  ]);

  // Ctrl+wheel (and trackpad pinch) zooms at the cursor; plain wheel and two-finger scroll pan.
  // A native listener, because React's onWheel is passive and cannot preventDefault.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = useStore.getState().viewport;
      if (!v) return;
      const r = el.getBoundingClientRect();
      useStore.setState({
        viewport:
          e.ctrlKey || e.metaKey
            ? zoomAt(v, wheelZoom(e.deltaY), e.clientX - r.left, e.clientY - r.top)
            : { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY },
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Tool keys only; menu commands and their shortcuts are in menu.ts (ADR-0031).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const down = e.type === "keydown";
      // A menu, or the menu bar with focus, takes the keys it handles.
      if (down && (menuOpen() || (e.target as Element).closest?.("[role=menubar]"))) return;
      setAlt(e.altKey);
      if (e.code === "Space") {
        e.preventDefault();
        setHand(down);
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      // Its paste event comes between keydown and keyup.
      if (key === "v") inPlace.current = down && mod && e.shiftKey;
      // Typing in a text field is not a tool key; the Fill and Stroke boxes' color inputs are not text.
      const t = e.target;
      if (!down || mod || (t instanceof HTMLInputElement && t.type !== "color")) return;
      const keys = keysOf(e);
      const tool = TOOL_KEYS[keys];
      const fillStroke = fillStrokeKey(useStore.getState().fillStroke, keys);
      if (tool) setTool(tool);
      else if (fillStroke) useStore.setState({ fillStroke });
      else if (keys === "Enter") finishPen();
      else if (keys === "Escape") {
        // Esc ends a path the Pen is drawing, else leaves the Zoom tool.
        if (drawing(useStore.getState())) finishPen();
        else if (useStore.getState().tool === "zoom") setTool("selection");
      }
    };
    addEventListener("keydown", onKey);
    addEventListener("keyup", onKey);
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("keyup", onKey);
    };
  }, []);

  /** Set by Ctrl+Shift+V for the paste event it fires: Paste in Place (ADR-0030). */
  const inPlace = useRef(false);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const data = e.clipboardData;
      const text = data?.getData("image/svg+xml") || data?.getData("text/plain") || "";
      const pasted = pastedArt(text, [...(data?.files ?? [])]);
      if (!pasted) return;
      e.preventDefault();
      place(pasted, inPlace.current);
    };
    // Copy writes the Selection as a nodes-scope export, which paste places without a Group and
    // Inkscape pastes as it is (ADR-0030). Cut then deletes what of it is editable.
    const onCopyOrCut = (e: ClipboardEvent) => {
      const { doc, selection } = useStore.getState();
      // Selected page text, such as a notice, copies as text.
      if (!doc || selection.length === 0 || !e.clipboardData || getSelection()?.toString()) return;
      e.preventDefault();
      let svg: string;
      try {
        svg = toSvg(doc, undefined, {
          scope: { nodeIds: selection },
          images: (id) => images.get(id)?.dataUrl,
        });
      } catch (err) {
        useStore.setState({ notice: `Could not ${e.type}: ${String(err)}` });
        return;
      }
      e.clipboardData.setData("text/plain", svg);
      e.clipboardData.setData("image/svg+xml", svg);
      const nodeIds = selection.filter((id) => editable(doc, doc.nodes.get(id)));
      if (e.type === "cut" && nodeIds.length > 0) send({ type: "delete", nodeIds });
    };
    addEventListener("paste", onPaste);
    addEventListener("copy", onCopyOrCut);
    addEventListener("cut", onCopyOrCut);
    return () => {
      removeEventListener("paste", onPaste);
      removeEventListener("copy", onCopyOrCut);
      removeEventListener("cut", onCopyOrCut);
    };
  }, [images]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = [...e.dataTransfer.files].find(placeable);
    if (file) place(file);
  };

  /** The pointer in document coordinates. */
  const docPoint = (e: React.PointerEvent<HTMLCanvasElement>, v: Viewport) => {
    const r = e.currentTarget.getBoundingClientRect();
    return toDoc(v, e.clientX - r.left, e.clientY - r.top);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { doc, viewport: v, selection } = useStore.getState();
    if (!doc || !v) return;
    if (hand) {
      e.currentTarget.setPointerCapture(e.pointerId);
      last.current = { x: e.clientX, y: e.clientY };
      return;
    }
    if (tool === "zoom") {
      const r = e.currentTarget.getBoundingClientRect();
      const factor = e.altKey ? 0.5 : 2;
      useStore.setState({ viewport: zoomAt(v, factor, e.clientX - r.left, e.clientY - r.top) });
      return;
    }
    if (tool === "pen") {
      const p = docPoint(e, v);
      penClick([p.x, p.y], SLOP / v.scale);
      return;
    }
    const ctx = e.currentTarget.getContext("2d");
    if (!ctx) return;
    const start = docPoint(e, v);
    const mods = { shift: e.shiftKey, alt: e.altKey };
    const hit = hitTest(ctx, doc, start.x, start.y, SLOP / v.scale);
    useStore.setState({ notice: null });
    if (hit && mods.shift) {
      useStore.setState({ selection: combine(selection, [hit], mods) });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    if (hit) {
      // Pressing a selected object keeps the Selection, so all of it that is editable moves.
      const kept = selection.includes(hit);
      if (!kept) useStore.setState({ selection: [hit] });
      const nodeIds = kept ? selection.filter((id) => editable(doc, doc.nodes.get(id))) : [hit];
      gesture.current = { kind: "move", start, nodeIds, moved: false };
    } else {
      gesture.current = { kind: "marquee", start, mods, moved: false };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const v = useStore.getState().viewport;
    if (v && tool === "pen") {
      const p = docPoint(e, v);
      setPointer([p.x, p.y]);
    }
    if (!v || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const g = gesture.current;
    if (!g) {
      const dx = e.clientX - last.current.x;
      const dy = e.clientY - last.current.y;
      last.current = { x: e.clientX, y: e.clientY };
      useStore.setState({ viewport: { ...v, x: v.x + dx, y: v.y + dy } });
      return;
    }
    const p = docPoint(e, v);
    const [dx, dy] = [p.x - g.start.x, p.y - g.start.y];
    g.moved ||= Math.hypot(dx, dy) * v.scale >= SLOP;
    if (!g.moved) return;
    if (g.kind === "move")
      useStore.setState({ drag: { nodeIds: g.nodeIds, dx, dy, commandId: null } });
    else setMarqueeRect(rectOf(g.start, p));
  };

  /** Releasing commits a move as one Transaction, or applies the marquee (a click if it never moved). */
  const onPointerUp = () => {
    const g = gesture.current;
    gesture.current = null;
    const { doc, drag, selection } = useStore.getState();
    if (!g || !doc) return;
    if (g.kind === "marquee") {
      const ids = g.moved && marqueeRect ? marquee(doc, marqueeRect) : [];
      useStore.setState({ selection: combine(selection, ids, g.mods) });
      setMarqueeRect(null);
    } else if (g.moved && drag && drag.commandId === null) {
      // ponytail: TransformInput takes at most 1000 nodeIds: a larger drag crashes preview() and
      // is closed with 1007 by the DO; chunk the command or lift the max when Documents grow.
      const translate = { x: drag.dx, y: drag.dy };
      const commandId = send({ type: "transform", input: { nodeIds: drag.nodeIds, translate } });
      useStore.setState({ drag: { ...drag, commandId } });
    }
  };

  const onPointerCancel = () => {
    gesture.current = null;
    setMarqueeRect(null);
    if (useStore.getState().drag?.commandId === null) useStore.setState({ drag: null });
  };

  const cursor = hand
    ? "grab"
    : { selection: "default", pen: "crosshair", zoom: alt ? "zoom-out" : "zoom-in" }[tool];

  return (
    <div style={{ position: "absolute", inset: 0, background: PASTEBOARD }}>
      <canvas
        ref={canvas}
        style={{ width: "100%", height: "100%", display: "block", cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={() => setPointer(null)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
      />
      {/* The status bar, where Illustrator shows the zoom. */}
      <div
        data-testid="status-bar"
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          padding: "2px 8px",
          background: "rgba(245, 245, 245, 0.9)",
          color: "#444",
          font: "12px system-ui, sans-serif",
        }}
      >
        {[viewport && `${Math.round(viewport.scale * 100)}%`, !live && "connecting…"]
          .filter(Boolean)
          .join(" · ")}
        {notice && (
          <span role="alert" style={{ color: "#B00020", marginLeft: 12 }}>
            {notice}
          </span>
        )}
      </div>
      <Tools />
      {layersShown && <Layers />}
    </div>
  );
}
