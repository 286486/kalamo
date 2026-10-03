import type { Geometry, PathOpInput } from "@kalamo/core";
import { pathTargets } from "./selection.ts";
import { type NodeOp, sendPathOp, useStore } from "./store.ts";

type Join = NonNullable<PathOpInput["join"]>;

/** Illustrator's defaults, kept between uses as its dialog keeps them. */
const settings = { distance: 10, join: "miter" as Join, miterLimit: 4, preview: false };

/** PathKit for the preview, fetched the first time Preview is checked (ADR-0034). */
const loadGeometry = async () => (await import("@kalamo/geometry/browser")).loadGeometry();

/**
 * Object > Path > Offset Path… (research 06 §5): Offset, Joins and Miter limit, with a Preview
 * drawn by the browser's PathKit. OK sends one `path_op offset` for the Selection's paths.
 */
export function offsetDialog() {
  const { doc, selection } = useStore.getState();
  const nodeIds = doc ? pathTargets(doc, selection) : [];
  if (!doc || nodeIds.length === 0) return;
  const dialog = Object.assign(document.createElement("dialog"), { ariaLabel: "Offset Path" });
  dialog.style.font = "13px system-ui, sans-serif";
  const row = "display:flex;gap:6px;align-items:center;margin:6px 0";
  const joins = (["miter", "round", "bevel"] as const).map(
    (j) =>
      `<option value="${j}"${j === settings.join ? " selected" : ""}>${j[0]?.toUpperCase()}${j.slice(1)}</option>`,
  );
  // OK comes first: Enter submits with it.
  dialog.innerHTML = `<form method="dialog">
<label style="${row}">Offset: <input type="number" name="distance" step="any" required value="${settings.distance}"> pt</label>
<label style="${row}">Joins: <select name="join">${joins.join("")}</select></label>
<label style="${row}">Miter limit: <input type="number" name="miterLimit" min="1" step="any" required value="${settings.miterLimit}"></label>
<label style="${row}"><input type="checkbox" name="preview"${settings.preview ? " checked" : ""}> Preview</label>
<p style="text-align:right;margin-bottom:0"><button value="ok">OK</button> <button value="cancel" formnovalidate>Cancel</button></p>
</form>`;
  const form = dialog.querySelector("form") as HTMLFormElement;
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  const input = (): NodeOp => {
    const { distance, join, miterLimit } = settings;
    return { nodeIds, op: "offset", distance, join, miterLimit };
  };
  /** PathKit once loaded: the dialog draws its preview only then. */
  let geometry: Geometry | undefined;
  const update = async () => {
    if (!form.checkValidity()) return;
    settings.distance = Number(field("distance").value);
    settings.join = field("join").value as Join;
    settings.miterLimit = Number(field("miterLimit").value);
    settings.preview = field("preview").checked;
    if (!settings.preview) {
      useStore.setState({ opPreview: null });
      return;
    }
    geometry = await loadGeometry();
    // The dialog may have closed, or Preview been unchecked, while PathKit loaded.
    if (!dialog.open || !settings.preview) return;
    useStore.setState({ opPreview: { input: input(), showOriginal: false, geometry } });
  };
  form.oninput = update;
  dialog.onclose = () => {
    dialog.remove();
    // A tab switch meanwhile drops the preview, and these paths are not in the new tab.
    if (dialog.returnValue !== "ok" || useStore.getState().doc?.id !== doc.id) {
      useStore.setState({ opPreview: null });
      return;
    }
    // Its own preview goes with it, of the settings at OK; none while PathKit is still loading.
    sendPathOp(input(), settings.preview && geometry ? { geometry } : undefined);
  };
  document.body.append(dialog);
  dialog.showModal();
  if (settings.preview) void update();
}
