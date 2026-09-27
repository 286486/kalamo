import { bounds, formatPath, fromAnchors } from "@zibel/core";
import { toSvg } from "@zibel/io/write";
import { drawDocument } from "@zibel/render/canvas";
import blackUrl from "@zibel/render/fonts/SourceSans3-Black.ttf?url";
import blackItalicUrl from "@zibel/render/fonts/SourceSans3-BlackIt.ttf?url";
import boldUrl from "@zibel/render/fonts/SourceSans3-Bold.ttf?url";
import boldItalicUrl from "@zibel/render/fonts/SourceSans3-BoldIt.ttf?url";
import italicUrl from "@zibel/render/fonts/SourceSans3-It.ttf?url";
import regularUrl from "@zibel/render/fonts/SourceSans3-Regular.ttf?url";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { SELECTION } from "./canvas.ts";
import { anchorsOf, hasAnchors } from "./direct.ts";
import { imageCache } from "./images.ts";
import { Layers } from "./Layers.tsx";
import { keysTaken } from "./MenuBar.tsx";
import { keysOf } from "./menu.ts";
import { pastedArt, place, placeable } from "./place.ts";
import { preview, previewEdit, previewOp } from "./receive.ts";
import { editable } from "./selection.ts";
import { connect, send, useStore } from "./store.ts";
import { Tools } from "./Tools.tsx";
import { type CanvasTool, TOOL_KEYS, TOOLS, type ToolEvent } from "./toolbox.ts";
import { fillStrokeKey, finishPen, setTool } from "./tools.ts";
import { artboardsRect, fit, toDoc, type Viewport, zoomAt } from "./viewport.ts";

const PASTEBOARD = "#E6E6E6";
/** Simplify's original path, drawn under the preview's Selection colour. */
const ORIGINAL = "#E8413C";
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

/** Sizes `el` to `size` in device pixels, cleared, and returns its context in Document coordinates. */
function sized(
  el: HTMLCanvasElement | null,
  size: { width: number; height: number },
  { x, y, scale }: Viewport,
) {
  const ctx = el?.getContext("2d");
  if (!el || !ctx) return null;
  const dpr = devicePixelRatio;
  el.width = Math.round(size.width * dpr);
  el.height = Math.round(size.height * dpr);
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * x, dpr * y);
  return ctx;
}

/** A live view of one Document: select, drag-move and delete its objects, and draw with the Pen. */
export function Viewer({ docId }: { docId: string }) {
  /** The Document; the overlay canvas over it takes the pointer and draws the tools and Selection. */
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlayCanvas = useRef<HTMLCanvasElement>(null);
  const {
    doc,
    live,
    viewport,
    selection,
    anchors,
    segments,
    drag,
    edit,
    opPreview,
    pen,
    notice,
    size,
    layersShown,
    tool,
    fillStroke,
  } = useStore();
  /** Space held: drag pans. */
  const [hand, setHand] = useState(false);
  const [alt, setAlt] = useState(false);
  /** Pointer position at the last pan step; movementX/Y scale with devicePixelRatio in some Chromes. */
  const last = useRef({ x: 0, y: 0 });
  /** Space was held at the press: the drag pans. */
  const panning = useRef(false);
  /** The tool that captured the pointer, which gets its moves and release even if the tool changes. */
  const pressed = useRef<CanvasTool | null>(null);
  /** Counts changes to a tool's overlay, so the canvas redraws. */
  const [overlay, redraw] = useReducer((n: number) => n + 1, 0);
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

  // Simplify's preview refits every path, so it runs once per change, not once per frame.
  const simplified = useMemo(
    () => (doc && opPreview ? previewOp(doc, opPreview) : doc),
    [doc, opPreview],
  );

  // Hit tests use `doc`; only the drawing shows the drag.
  const shown = useMemo(() => {
    const moved = simplified && drag ? preview(simplified, drag) : simplified;
    return moved && edit ? previewEdit(moved, edit) : moved;
  }, [simplified, drag, edit]);

  // ponytail: redraws every Node on every Document change; add viewport culling and dirty rects for 5k+ Nodes (F-VIEW-08).
  // biome-ignore lint/correctness/useExhaustiveDependencies: fontReady and imagesLoaded redraw text and Images once their font or files are in
  useEffect(() => {
    // On a tab switch the store holds the last tab's Document until connect clears it.
    if (!doc || !shown || doc.id !== docId || !viewport) return;
    const ctx = sized(canvas.current, size, viewport);
    if (!ctx) return;
    const { scale } = viewport;
    // The pasteboard is the page's background, under both canvases.
    for (const { frame } of doc.artboards) {
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(frame.x, frame.y, frame.width, frame.height);
      ctx.lineWidth = 1 / scale;
      ctx.strokeStyle = "#000000";
      ctx.strokeRect(frame.x, frame.y, frame.width, frame.height);
    }
    images.want(shown);
    // Fonts load for the document, so layers are DOM canvases too.
    const layer = () => {
      const el = document.createElement("canvas");
      [el.width, el.height] = [ctx.canvas.width, ctx.canvas.height];
      return { ctx: el.getContext("2d") as CanvasRenderingContext2D, image: el };
    };
    drawDocument(ctx, shown, layer, images.get);
  }, [doc, shown, docId, viewport, size, fontReady, images, imagesLoaded]);

  // The overlay redraws on its own canvas, without repainting the Document's Nodes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: anchors, segments, pen, fillStroke and overlay redraw the tools' overlays
  useEffect(() => {
    if (!doc || !shown || doc.id !== docId || !viewport) return;
    const ctx = sized(overlayCanvas.current, size, viewport);
    if (!ctx) return;
    const { scale } = viewport;
    ctx.lineWidth = 1 / scale;
    ctx.strokeStyle = SELECTION;
    const active = TOOLS[tool];
    for (const id of selection) {
      const node = shown.nodes.get(id);
      if (!node || active.drawSelected?.(ctx, shown, node, scale)) continue;
      const b = bounds(shown, node);
      if (b) ctx.strokeRect(b.x, b.y, b.width, b.height);
    }
    for (const t of Object.values(TOOLS)) t.draw?.(ctx, shown, scale);
    // Simplify's Show Original Path.
    if (opPreview?.showOriginal) {
      ctx.strokeStyle = ORIGINAL;
      for (const id of opPreview.input.nodeIds ?? []) {
        const node = doc.nodes.get(id);
        if (hasAnchors(node)) ctx.stroke(new Path2D(formatPath(fromAnchors(anchorsOf(doc, node)))));
      }
    }
  }, [
    doc,
    shown,
    opPreview,
    docId,
    viewport,
    size,
    selection,
    anchors,
    segments,
    tool,
    pen,
    fillStroke,
    overlay,
  ]);

  // Ctrl+wheel (and trackpad pinch) zooms at the cursor; plain wheel and two-finger scroll pan.
  // A native listener, because React's onWheel is passive and cannot preventDefault.
  useEffect(() => {
    const el = overlayCanvas.current;
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
      if (down && (keysTaken() || (e.target as Element).closest?.("[role=menubar]"))) return;
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
      else TOOLS[useStore.getState().tool].onKey?.(keys);
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

  /** A pointer event for a tool, or null before the Document and viewport are in. */
  const toolEvent = (e: React.PointerEvent<HTMLCanvasElement>): ToolEvent | null => {
    const { doc, viewport } = useStore.getState();
    const el = e.currentTarget;
    const ctx = el.getContext("2d");
    if (!doc || !viewport || !ctx) return null;
    const r = el.getBoundingClientRect();
    const at = (p: { clientX: number; clientY: number }) =>
      toDoc(viewport, p.clientX - r.left, p.clientY - r.top);
    const coalesced = e.nativeEvent.getCoalescedEvents?.() ?? [];
    return {
      ...at(e),
      points: (coalesced.length > 0 ? coalesced : [e]).map((p) => {
        const { x, y } = at(p);
        return [x, y];
      }),
      shift: e.shiftKey,
      alt: e.altKey,
      ctrl: e.ctrlKey || e.metaKey,
      space: hand,
      doc,
      viewport,
      ctx,
      capture: () => el.setPointerCapture(e.pointerId),
      redraw,
    };
  };
  const target = () => pressed.current ?? TOOLS[tool];

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ev = toolEvent(e);
    if (!ev) return;
    if (hand) {
      ev.capture();
      panning.current = true;
      last.current = { x: e.clientX, y: e.clientY };
      return;
    }
    const t = TOOLS[tool];
    t.down(ev);
    pressed.current = e.currentTarget.hasPointerCapture(e.pointerId) ? t : null;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ev = toolEvent(e);
    if (!ev) return;
    if (panning.current) {
      const v = ev.viewport;
      const dx = e.clientX - last.current.x;
      const dy = e.clientY - last.current.y;
      last.current = { x: e.clientX, y: e.clientY };
      useStore.setState({ viewport: { ...v, x: v.x + dx, y: v.y + dy } });
    }
    target().move?.(ev);
  };

  const onPointerEnd = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const t = target();
    panning.current = false;
    pressed.current = null;
    const ev = toolEvent(e);
    if (ev && e.type === "pointerup") t.up?.(ev);
    else t.cancel?.(redraw);
  };

  const cursor = hand ? "grab" : (alt && TOOLS[tool].altCursor) || TOOLS[tool].cursor;

  return (
    <div style={{ position: "absolute", inset: 0, background: PASTEBOARD }}>
      <canvas
        ref={canvas}
        data-testid="canvas"
        style={{ width: "100%", height: "100%", display: "block" }}
      />
      <canvas
        ref={overlayCanvas}
        data-testid="overlay"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onPointerLeave={(e) => {
          const ev = toolEvent(e);
          if (ev) for (const t of Object.values(TOOLS)) t.leave?.(ev);
        }}
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
