import { bounds, type Document, fidelityTolerance, union } from "@kalamo/core";
import { hasAnchors, localAnchors } from "./direct.ts";
import { previewOp } from "./receive.ts";
import { pathTargets } from "./selection.ts";
import { afterReverse, type NodeOp, send, useStore } from "./store.ts";

/** The slider's middle, Auto-Simplify: within 1 screen px of the path (ADR-0035). */
const AUTO = 50;

/** The Simplify Curve slider, Minimum 0 to Maximum 100 Anchors, as a tolerance in pt at `zoom`. */
export const sliderTolerance = (s: number, zoom: number) => fidelityTolerance(100 - s) / zoom;

/** The Anchors of the Nodes in `doc`. */
export function anchorCount(doc: Document, nodeIds: string[]): number {
  return nodeIds.reduce((sum, id) => {
    const n = doc.nodes.get(id);
    return sum + (hasAnchors(n) ? localAnchors(n).reduce((k, s) => k + s.anchors.length, 0) : 0);
  }, 0);
}

interface Settings {
  curve: number;
  cornerAngle: number;
  toLines: boolean;
  showOriginal: boolean;
}

/** The bar or dialog on screen: how to take it down, and to redo the preview at a new zoom. */
let open: { close: () => void; update: () => void } | null = null;

/**
 * Whether Simplify's bar or dialog is on screen: its Enter and Escape pass the pressed tool by.
 * The dialog makes the canvas inert, so counting it only keeps the rule the same for both.
 */
export const simplifyOpen = () => !!open;

/** Closes the bar or dialog without touching the preview. */
function takeDown() {
  const was = open;
  open = null;
  was?.close();
}

/**
 * Sends Simplify's, Offset Path's or Split Into Grid's `path_op` on OK, once a Reverse Path
 * Direction press in flight is answered (ADR-0110). The op preview on screen stays drawn while it
 * waits and until its answer, so nothing flickers (ADR-0035), unless a later op's preview takes its
 * place: the op is sent all the same.
 */
export function sendPreviewedOp(input: NodeOp) {
  const shown = useStore.getState().opPreview;
  // Only this op's own preview: Offset Path or Split Into Grid with Preview off leaves the slot alone.
  const own = shown && !shown.commandId && shown.input.op === input.op;
  const held = own ? { ...shown, input, showOriginal: false } : null;
  if (held) useStore.setState({ opPreview: held });
  afterReverse((_s, w) => {
    const commandId = send({ type: "path_op", input }, w);
    if (held && useStore.getState().opPreview === held) {
      useStore.setState({ opPreview: { ...held, commandId } });
    }
  });
}

/** OK: the preview as one `path_op` Command, drawn until its answer. */
export function commitSimplify() {
  takeDown();
  const { opPreview } = useStore.getState();
  if (opPreview && !opPreview.commandId) sendPreviewedOp(opPreview.input);
}

function cancel() {
  takeDown();
  useStore.setState({ opPreview: null });
}

// A tab switch drops the preview, so its bar goes; a new Selection applies it, as a click
// elsewhere does in Illustrator. The slider is in screen px, so a zoom refits.
useStore.subscribe((s, prev) => {
  if (!open) return;
  if (!s.opPreview) takeDown();
  else if (s.selection.join(" ") !== prev.selection.join(" ")) commitSimplify();
  else if (s.viewport?.scale !== prev.viewport?.scale) open.update();
});

const button = (label: string, onclick: () => void, ariaLabel = label) =>
  Object.assign(document.createElement("button"), {
    type: "button",
    textContent: label,
    ariaLabel,
    onclick,
  });

/**
 * Object > Path > Simplify… (research 06 §5): previews the auto result on the Selection's paths at
 * once and shows Illustrator's on-canvas bar, whose More Options opens the dialog (ADR-0035).
 */
export function startSimplify() {
  const { doc, selection, viewport } = useStore.getState();
  const nodeIds = doc ? pathTargets(doc, selection) : [];
  if (!doc || !viewport || nodeIds.length === 0) return;
  takeDown();
  const settings: Settings = { curve: AUTO, cornerAngle: 90, toLines: false, showOriginal: false };
  const update = () => {
    const { curve, cornerAngle, toLines, showOriginal } = settings;
    const scale = useStore.getState().viewport?.scale ?? viewport.scale;
    const tolerance = sliderTolerance(curve, scale);
    const input = { nodeIds, op: "simplify" as const, tolerance, cornerAngle, toLines };
    useStore.setState({ opPreview: { input, showOriginal, commandId: null } });
  };
  update();

  const bar = document.createElement("div");
  Object.assign(bar, { role: "toolbar", ariaLabel: "Simplify" });
  const slider = Object.assign(document.createElement("input"), {
    type: "range",
    min: "0",
    max: "100",
    value: String(AUTO),
    ariaLabel: "Simplify Curve",
    oninput: () => {
      settings.curve = Number(slider.value);
      update();
    },
  });
  const auto = () => {
    settings.curve = AUTO;
    slider.value = String(AUTO);
    update();
  };
  const more = () => {
    takeDown();
    moreOptions(doc, nodeIds, settings, update);
  };
  const min = Object.assign(document.createElement("span"), { textContent: "Min" });
  const max = Object.assign(document.createElement("span"), { textContent: "Max" });
  bar.append(
    min,
    slider,
    max,
    button("Auto-Simplify", auto),
    button("…", more, "More Options"),
    button("OK", commitSimplify),
    button("Cancel", cancel),
  );
  // Under the paths, as Illustrator shows it.
  const canvas = document.querySelector("canvas")?.getBoundingClientRect();
  const box = union(
    nodeIds.map((id) => {
      const n = doc.nodes.get(id);
      return n ? bounds(doc, n) : null;
    }),
  );
  const left = (canvas?.left ?? 0) + (box ? box.x * viewport.scale + viewport.x : 0);
  const top = (canvas?.top ?? 0) + (box ? (box.y + box.height) * viewport.scale + viewport.y : 0);
  Object.assign(bar.style, {
    position: "fixed",
    left: `${Math.max(8, Math.min(left, innerWidth - 480))}px`,
    top: `${Math.max(8, Math.min(top + 12, innerHeight - 48))}px`,
    display: "flex",
    gap: "6px",
    alignItems: "center",
    padding: "4px 8px",
    background: "#FFFFFF",
    border: "1px solid #999",
    borderRadius: "4px",
    font: "12px system-ui, sans-serif",
    zIndex: "10",
  });
  // Enter is OK and Esc is Cancel. Viewer's pressed-tool listener comes first but lets them by
  // while the bar is open, and the tools' shortcuts come after; Enter on a button presses it.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== "Escape") return;
    if (e.key === "Enter" && e.target instanceof HTMLButtonElement) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Enter") commitSimplify();
    else cancel();
  };
  addEventListener("keydown", onKey, true);
  document.body.append(bar);
  open = {
    close: () => {
      removeEventListener("keydown", onKey, true);
      bar.remove();
    },
    update,
  };
}

/** The Simplify dialog: every setting, and the Anchor counts before and after. */
function moreOptions(doc: Document, nodeIds: string[], settings: Settings, update: () => void) {
  const dialog = Object.assign(document.createElement("dialog"), { ariaLabel: "Simplify" });
  dialog.style.font = "13px system-ui, sans-serif";
  const check = (name: string, on: boolean) =>
    `<input type="checkbox" name="${name}"${on ? " checked" : ""}>`;
  const row = "display:flex;gap:6px;align-items:center;margin:6px 0";
  // OK comes first: Enter submits with it.
  dialog.innerHTML = `<form method="dialog">
<label style="${row}">Simplify Curve: Min <input type="range" name="curve" min="0" max="100" value="${settings.curve}"> Max</label>
<label style="${row}">Corner Point Angle Threshold: <input type="range" name="cornerAngle" min="0" max="180" value="${settings.cornerAngle}"> <output name="angle">${settings.cornerAngle}°</output></label>
<p style="${row}"><button type="button" name="auto">Auto-Simplify</button></p>
<label style="${row}">${check("toLines", settings.toLines)} Convert to Straight Lines</label>
<label style="${row}">${check("showOriginal", settings.showOriginal)} Show Original Path</label>
<p>Original: <output name="original"></output> Anchors · Current: <output name="current"></output> Anchors</p>
<p style="text-align:right;margin-bottom:0"><button value="ok">OK</button> <button value="cancel">Cancel</button></p>
</form>`;
  const form = dialog.querySelector("form") as HTMLFormElement;
  const field = <T extends Element>(name: string) => form.elements.namedItem(name) as T;
  field<HTMLOutputElement>("original").value = String(anchorCount(doc, nodeIds));
  const refresh = () => {
    const { opPreview, doc: now } = useStore.getState();
    const shown = opPreview && now ? previewOp(now, opPreview) : doc;
    field<HTMLOutputElement>("current").value = String(anchorCount(shown, nodeIds));
    field<HTMLOutputElement>("angle").value = `${settings.cornerAngle}°`;
  };
  const onInput = () => {
    settings.curve = Number(field<HTMLInputElement>("curve").value);
    settings.cornerAngle = Number(field<HTMLInputElement>("cornerAngle").value);
    settings.toLines = field<HTMLInputElement>("toLines").checked;
    settings.showOriginal = field<HTMLInputElement>("showOriginal").checked;
    update();
    refresh();
  };
  form.oninput = onInput;
  field<HTMLButtonElement>("auto").onclick = () => {
    field<HTMLInputElement>("curve").value = String(AUTO);
    onInput();
  };
  dialog.onclose = () => {
    const ok = dialog.returnValue === "ok";
    dialog.remove();
    if (!open) return; // A tab switch took it down.
    if (ok) commitSimplify();
    else cancel();
  };
  document.body.append(dialog);
  refresh();
  dialog.showModal();
  open = { close: () => dialog.open && dialog.close(), update: onInput };
}
