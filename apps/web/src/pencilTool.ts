import { drawDrawing } from "./canvas.ts";
import {
  DEFAULT_PENCIL,
  type PencilOptions,
  pencilCancel,
  pencilDown,
  pencilFill,
  pencilInk,
  pencilMove,
  pencilOptions,
  pencilUp,
  savePencilOptions,
} from "./pencil.ts";
import { useStore } from "./store.ts";
import type { CanvasTool } from "./toolbox.ts";
import { pathD } from "./tools.ts";

/** Drags draw freehand; see pencil.ts. */
export const pencilTool: CanvasTool = {
  title: "Pencil Tool",
  shortcut: "N",
  icon: "M11 2 L14 5 L6 13 L2 14 L3 10 Z M9.5 3.5 L12.5 6.5",
  cursor: "crosshair",
  down(e) {
    e.capture();
    pencilDown([e.x, e.y]);
  },
  move(e) {
    if (!pencilInk()) return;
    pencilMove(e.points, e);
    e.redraw();
  },
  up(e) {
    pencilUp(e.viewport.scale);
    e.redraw();
  },
  cancel(redraw) {
    pencilCancel();
    redraw();
  },
  options: showOptions,
  draw(ctx, _doc, scale) {
    const { pen, fillStroke } = useStore.getState();
    const ink = pencilInk();
    // The Ink as drawn, then the fitted path until its Transaction arrives.
    if (ink && ink.length > 1) {
      const path = new Path2D(`M ${ink.map((p) => p.join(" ")).join(" L ")}`);
      drawDrawing(ctx, path, { ...fillStroke, fill: pencilFill(fillStroke.fill) }, scale);
    } else if (pen?.pencil) {
      const path = new Path2D(pathD(pen.anchors, pen.closed));
      drawDrawing(ctx, path, { ...fillStroke, fill: pen.pencil.fill }, scale);
    }
  },
};

/** Pencil Tool Options, from a double-click on the tool (research 06 §3). */
function showOptions() {
  const o = pencilOptions();
  const dialog = Object.assign(document.createElement("dialog"), {
    ariaLabel: "Pencil Tool Options",
  });
  dialog.style.font = "13px system-ui, sans-serif";
  const row = "display:flex;gap:6px;align-items:center;margin:6px 0";
  const check = (name: keyof PencilOptions, label: string) =>
    `<label style="${row}"><input type="checkbox" name="${name}"${o[name] ? " checked" : ""}> ${label}</label>`;
  const px = (name: keyof PencilOptions) =>
    `<input type="number" name="${name}" min="1" max="100" value="${o[name]}" style="width:4em"> pixels`;
  // OK comes first: Enter submits with it.
  dialog.innerHTML = `<form method="dialog">
<label style="${row}">Fidelity: Accurate <input type="range" name="fidelity" min="0" max="100" step="25" value="${o.fidelity}"> Smooth</label>
${check("fillNew", "Fill new pencil strokes")}
${check("keepSelected", "Keep selected")}
<p style="${row}">${check("close", "Close paths when ends are within:")} ${px("closeWithin")}</p>
<p style="${row}">${check("editSelected", "Edit selected paths")} Within: ${px("editWithin")}</p>
<p style="text-align:right;margin-bottom:0"><button value="ok">OK</button> <button type="button" name="reset">Reset</button> <button value="cancel">Cancel</button></p>
</form>`;
  const form = dialog.querySelector("form") as HTMLFormElement;
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  (field("reset") as HTMLElement).onclick = () => {
    for (const [name, v] of Object.entries(DEFAULT_PENCIL)) {
      if (typeof v === "boolean") field(name).checked = v;
      else field(name).value = String(v);
    }
  };
  dialog.onclose = () => {
    dialog.remove();
    if (dialog.returnValue !== "ok") return;
    const clampedPx = (name: keyof PencilOptions) =>
      Math.min(100, Math.max(1, Number(field(name).value) || (DEFAULT_PENCIL[name] as number)));
    savePencilOptions({
      fidelity: Number(field("fidelity").value),
      fillNew: field("fillNew").checked,
      keepSelected: field("keepSelected").checked,
      close: field("close").checked,
      closeWithin: clampedPx("closeWithin"),
      editSelected: field("editSelected").checked,
      editWithin: clampedPx("editWithin"),
    });
  };
  document.body.append(dialog);
  dialog.showModal();
}
