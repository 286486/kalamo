import { BUNDLED_FONT, type BundledFamily, bounds, formatPath, fromAnchors } from "@kalamo/core";
import { toSvg } from "@kalamo/io/write";
import { drawDocument } from "@kalamo/render/canvas";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AnchorsBar } from "./AnchorsBar.tsx";
import { AttributesPanel } from "./AttributesPanel.tsx";
import { type AreaPill, drawAreas, drawPeers, drawPending, SELECTION } from "./canvas.ts";
import { anchorsOf, hasAnchors } from "./direct.ts";
import { drawnLazyFamilies, loadFamily } from "./fonts.ts";
import { GradientPanel } from "./GradientPanel.tsx";
import { withPaints } from "./gradient.ts";
import { IsolationBar } from "./IsolationBar.tsx";
import { imageCache } from "./images.ts";
import { Layers } from "./Layers.tsx";
import { keysTaken } from "./MenuBar.tsx";
import { PathfinderPanel } from "./PathfinderPanel.tsx";
import { pastedArt, place, placeable } from "./place.ts";
import { AREA_SHOWN, visibleAreas } from "./presence.ts";
import { previewAll, previewEdit, previewOp, previewsOf } from "./receive.ts";
import { editable } from "./selection.ts";
import { simplifyOpen } from "./simplify.ts";
import { afterReverse, canEdit, connect, pointerAt, send, useStore } from "./store.ts";
import { Tools } from "./Tools.tsx";
import {
  type CanvasTool,
  canvasKey,
  nextTap,
  pressedKey,
  type Tap,
  TOOLS,
  type ToolEvent,
} from "./toolbox.ts";
import { finishPen } from "./tools.ts";
import { artboardsRect, fit, toDoc, type Viewport, zoomAt } from "./viewport.ts";

const PASTEBOARD = "#E6E6E6";
/** Simplify's original path, drawn under the preview's Selection colour. */
const ORIGINAL = "#E8413C";
/** Pinch sends small deltas and passes through; a mouse-wheel notch (about 100) is capped to x1.65. */
const wheelZoom = (deltaY: number) => Math.exp(-Math.max(-50, Math.min(50, deltaY)) * 0.01);

// Source Sans 3 loads with the page; the other families only for a Document that draws in them.
const fontLoaded = loadFamily(BUNDLED_FONT);

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
    drag,
    edit,
    reversing,
    held,
    ran,
    opPreview,
    pending,
    notice,
    isolated,
    size,
    layersShown,
    gradientShown,
    pathfinderShown,
    attributesShown,
    paintPreview,
    tool,
    peers,
    actorNames,
    actorKinds,
    areas,
  } = useStore();
  /** Space held: drag pans. */
  const [hand, setHand] = useState(false);
  /** Space held, for the key handler, which outlives the render that made it. */
  const spaceHeld = useRef(false);
  const [alt, setAlt] = useState(false);
  /** Pointer position at the last pan step; movementX/Y scale with devicePixelRatio in some Chromes. */
  const last = useRef({ x: 0, y: 0 });
  /** Space was held at the press: the drag pans. */
  const panning = useRef(false);
  /** The last mousedown's click count, for a mouse press (ToolEvent.clicks). */
  const clicks = useRef(0);
  /** The last touch or pen press, which counts its own clicks; null after a mouse press. */
  const tap = useRef<Tap | null>(null);
  /** The tool that captured the pointer, which gets its moves and release even if the tool changes. */
  const pressed = useRef<CanvasTool | null>(null);
  /** Counts changes to a tool's overlay, so the canvas redraws. */
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  /** The Working Area pills last drawn, which the pointer hovers for the whole `intent`. */
  const pills = useRef<AreaPill[]>([]);
  /** The hovered pill's `intent`, at the pointer in CSS px over the canvas. */
  const [tip, setTip] = useState<{ x: number; y: number; intent: string } | null>(null);
  /** True once the faces have settled; until then text draws in a fallback font. */
  const [fontReady, setFontReady] = useState(false);
  /** The families besides Source Sans 3 that have settled, each loaded once a Document draws in it. */
  const [lazyReady, setLazyReady] = useState<ReadonlySet<BundledFamily>>(new Set());
  /** Counts image files decoded, so the canvas redraws as each arrives. */
  const [imagesLoaded, setImagesLoaded] = useState(0);
  const images = useMemo(() => imageCache(docId, () => setImagesLoaded((n) => n + 1)), [docId]);
  useEffect(() => {
    useStore.setState({ images });
    // Until the next tab's Viewer sets its own, a download must not pair its cache with this Document.
    return () => useStore.setState({ images: null });
  }, [images]);

  useEffect(() => {
    fontLoaded.then(() => setFontReady(true));
  }, []);

  useEffect(() => {
    if (!doc) return;
    for (const family of drawnLazyFamilies(doc))
      if (!lazyReady.has(family))
        loadFamily(family).then(() =>
          setLazyReady((ready) => (ready.has(family) ? ready : new Set(ready).add(family))),
        );
  }, [doc, lazyReady]);

  useEffect(() => {
    const stop = connect(docId);
    // Leaving the tab finishes a path the Pen is drawing, as a tool switch does.
    return () => {
      finishPen();
      stop();
    };
  }, [docId]);

  // A hidden window shows no cursor to the Peers (ADR-0090).
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) pointerAt(null);
    };
    addEventListener("visibilitychange", onVisibility);
    return () => removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (doc) document.title = `${doc.name} – Kalamo`;
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
    const edited = simplified && previewAll(simplified, previewsOf({ ran, held, edit, drag }));
    return edited && paintPreview ? withPaints(edited, paintPreview.updates) : edited;
  }, [simplified, ran, held, drag, edit, paintPreview]);
  // A Reverse Path Direction press in flight shows on the Document only: the overlay's Anchors keep
  // the committed numbering the keys use, at the same places (ADR-0110).
  const drawn = useMemo(
    () => (shown && reversing ? previewEdit(shown, reversing) : shown),
    [shown, reversing],
  );

  // ponytail: redraws every Node on every Document change; add viewport culling and dirty rects for 5k+ Nodes (F-VIEW-08).
  // biome-ignore lint/correctness/useExhaustiveDependencies: fontReady, lazyReady and imagesLoaded redraw text and Images once their fonts or files are in
  useEffect(() => {
    // On a tab switch the store holds the last tab's Document until connect clears it.
    if (!doc || !drawn || doc.id !== docId || !viewport) return;
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
    images.want(drawn);
    // Fonts load for the document, so layers are DOM canvases too.
    const layer = () => {
      const el = document.createElement("canvas");
      [el.width, el.height] = [ctx.canvas.width, ctx.canvas.height];
      return { ctx: el.getContext("2d") as CanvasRenderingContext2D, image: el };
    };
    // Isolation Mode (ADR-0057): the isolated Node draws over the rest, faded halfway to white.
    drawDocument(ctx, drawn, layer, images.get, isolated);
  }, [doc, drawn, isolated, docId, viewport, size, fontReady, lazyReady, images, imagesLoaded]);

  // The overlay redraws on its own canvas after every render, without repainting the Document's Nodes.
  // The Viewer renders on every store change, so no tool can read a slice this misses.
  useEffect(() => {
    if (!doc || !shown || doc.id !== docId || !viewport) return;
    const ctx = sized(overlayCanvas.current, size, viewport);
    if (!ctx) return;
    const { scale } = viewport;
    const now = Date.now();
    const working = visibleAreas(areas, actorKinds, now);
    pills.current = drawAreas(ctx, working, actorNames, scale);
    drawPeers(ctx, shown, peers, actorNames, scale);
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
    drawPending(ctx, pending, scale);
    // Simplify's Show Original Path.
    if (opPreview?.showOriginal) {
      ctx.strokeStyle = ORIGINAL;
      for (const id of opPreview.input.nodeIds ?? []) {
        const node = doc.nodes.get(id);
        if (hasAnchors(node)) ctx.stroke(new Path2D(formatPath(fromAnchors(anchorsOf(doc, node)))));
      }
    }
    // The earliest Working Area to expire goes then, with no message or input to redraw it.
    if (working.length === 0) return;
    const ends = Math.min(...working.map((a) => a.at + AREA_SHOWN));
    const timer = setTimeout(redraw, ends - now);
    return () => clearTimeout(timer);
  });

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
    // A menu, or the menu bar with focus, takes the keys it handles.
    const menus = (e: KeyboardEvent) =>
      e.type === "keydown" && (keysTaken() || !!(e.target as Element).closest?.("[role=menubar]"));
    // The tool holding the pointer hears a key before the menu bar and the Tools panel; a key it
    // took stops here. Simplify listens on window too, so stopping here would not stop it: while
    // its bar or dialog is open, Enter and Escape pass the tool by and are Simplify's alone. Space
    // is counted here, for it, even when a focused Tools panel button then takes it.
    const toPressed = (e: KeyboardEvent) => {
      if (menus(e)) return;
      if (e.code === "Space") spaceHeld.current = e.type === "keydown";
      if (pressedKey(e, pressed.current, spaceHeld.current, simplifyOpen(), redraw)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (menus(e)) return;
      const down = e.type === "keydown";
      setAlt(e.altKey);
      if (e.code === "Space") {
        e.preventDefault();
        setHand(down);
      }
      // Its paste event comes between keydown and keyup.
      if (e.key.toLowerCase() === "v")
        inPlace.current = down && (e.ctrlKey || e.metaKey) && e.shiftKey;
      canvasKey(e);
    };
    for (const type of ["keydown", "keyup"] as const) {
      addEventListener(type, toPressed, true);
      addEventListener(type, onKey);
    }
    return () => {
      for (const type of ["keydown", "keyup"] as const) {
        removeEventListener(type, toPressed, true);
        removeEventListener(type, onKey);
      }
    };
  }, []);

  /** Set by Ctrl+Shift+V for the paste event it fires: Paste in Place (ADR-0030). */
  const inPlace = useRef(false);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const data = e.clipboardData;
      const text = data?.getData("image/svg+xml") || data?.getData("text/plain") || "";
      const pasted = pastedArt(text, [...(data?.files ?? [])]);
      // A viewer's native Paste shortcut greys out nowhere, so it stops here (ADR-0047).
      if (!pasted || !canEdit(useStore.getState())) return;
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
          templates: true,
        });
      } catch (err) {
        useStore.setState({ notice: `Could not ${e.type}: ${String(err)}` });
        return;
      }
      e.clipboardData.setData("text/plain", svg);
      e.clipboardData.setData("image/svg+xml", svg);
      const nodeIds = selection.filter((id) => editable(doc, doc.nodes.get(id)));
      // A viewer's Cut copies and deletes nothing. The delete waits for a Reverse Path Direction
      // press in flight, as Edit > Clear's does (ADR-0110).
      if (e.type === "cut" && nodeIds.length > 0 && canEdit(useStore.getState())) {
        afterReverse(() => send({ type: "delete", nodeIds }));
      }
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
    if (file && canEdit(useStore.getState())) place(file);
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
      clicks: tap.current?.count ?? clicks.current,
      doc,
      viewport,
      ctx,
      capture: () => el.setPointerCapture(e.pointerId),
      redraw,
    };
  };
  const target = () => pressed.current ?? TOOLS[tool];

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    tap.current =
      e.pointerType === "mouse" ? null : nextTap(tap.current, e.clientX, e.clientY, e.timeStamp);
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
    pointerAt({ x: ev.x, y: ev.y });
    const pill = pills.current.find(
      (p) => ev.x >= p.x && ev.x <= p.x + p.width && ev.y >= p.y && ev.y <= p.y + p.height,
    );
    const r = e.currentTarget.getBoundingClientRect();
    setTip(
      pill?.intent ? { x: e.clientX - r.left, y: e.clientY - r.top, intent: pill.intent } : null,
    );
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
        onMouseDown={(e) => {
          clicks.current = e.detail;
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onPointerLeave={(e) => {
          pointerAt(null);
          setTip(null);
          const ev = toolEvent(e);
          if (ev) for (const t of Object.values(TOOLS)) t.leave?.(ev);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
      />
      {tip && (
        <div
          role="tooltip"
          style={{
            position: "absolute",
            left: tip.x + 12,
            top: tip.y + 16,
            maxWidth: 320,
            padding: "4px 6px",
            background: "#333",
            color: "#FFF",
            font: "12px system-ui, sans-serif",
            borderRadius: 4,
            pointerEvents: "none",
          }}
        >
          {tip.intent}
        </div>
      )}
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
      <IsolationBar />
      <AnchorsBar />
      <Tools />
      {(layersShown || gradientShown || pathfinderShown || attributesShown) && (
        // Illustrator's panel dock, on the right: Gradient, Pathfinder, Attributes, then Layers.
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
          {gradientShown && <GradientPanel />}
          {pathfinderShown && <PathfinderPanel />}
          {attributesShown && <AttributesPanel />}
          {layersShown && <Layers />}
        </div>
      )}
    </div>
  );
}
