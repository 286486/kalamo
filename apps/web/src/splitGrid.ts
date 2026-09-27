import type { PathOpInput } from "@zibel/core";
import { pathTargets } from "./selection.ts";
import { send, useStore } from "./store.ts";

/** Kept between uses as Illustrator's dialog keeps them; a blank Total is the shape's own size. */
const settings = {
  rows: 2,
  cols: 2,
  gutter: 0,
  totalHeight: "",
  totalWidth: "",
  preview: false,
};

/**
 * Object > Path > Split Into Grid… (research 06 §5): Rows, Columns, Gutter and each Total, with a
 * Preview. OK sends one `path_op split_into_grid` for the Selection's paths.
 */
export function splitGridDialog() {
  const { doc, selection } = useStore.getState();
  const nodeIds = doc ? pathTargets(doc, selection) : [];
  if (!doc || nodeIds.length === 0) return;
  const dialog = Object.assign(document.createElement("dialog"), { ariaLabel: "Split Into Grid" });
  dialog.style.font = "13px system-ui, sans-serif";
  const row = "display:flex;gap:6px;align-items:center;margin:6px 0";
  const numberField = (name: keyof typeof settings, min: number, step = "any") =>
    `<input type="number" name="${name}" min="${min}" step="${step}" value="${settings[name]}"${typeof settings[name] === "number" ? " required" : ` placeholder="Shape size"`}>`;
  // OK comes first: Enter submits with it.
  dialog.innerHTML = `<form method="dialog">
<label style="${row}">Rows: ${numberField("rows", 1, "1")}</label>
<label style="${row}">Rows total: ${numberField("totalHeight", 0)} pt</label>
<label style="${row}">Columns: ${numberField("cols", 1, "1")}</label>
<label style="${row}">Columns total: ${numberField("totalWidth", 0)} pt</label>
<label style="${row}">Gutter: ${numberField("gutter", 0)} pt</label>
<label style="${row}"><input type="checkbox" name="preview"${settings.preview ? " checked" : ""}> Preview</label>
<p style="text-align:right;margin-bottom:0"><button value="ok">OK</button> <button value="cancel" formnovalidate>Cancel</button></p>
</form>`;
  const form = dialog.querySelector("form") as HTMLFormElement;
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  const input = (): PathOpInput => {
    const { rows, cols, gutter, totalHeight, totalWidth } = settings;
    return {
      nodeIds,
      op: "split_into_grid",
      rows,
      cols,
      gutter,
      ...(Number(totalHeight) > 0 && { totalHeight: Number(totalHeight) }),
      ...(Number(totalWidth) > 0 && { totalWidth: Number(totalWidth) }),
    };
  };
  form.oninput = () => {
    if (!form.checkValidity()) return;
    settings.rows = Number(field("rows").value);
    settings.cols = Number(field("cols").value);
    settings.gutter = Number(field("gutter").value);
    settings.totalHeight = field("totalHeight").value;
    settings.totalWidth = field("totalWidth").value;
    settings.preview = field("preview").checked;
    useStore.setState({
      opPreview: settings.preview ? { input: input(), showOriginal: false, commandId: null } : null,
    });
  };
  dialog.onclose = () => {
    dialog.remove();
    const { opPreview, doc: now } = useStore.getState();
    // A tab switch meanwhile drops the preview, and these paths are not in the new tab.
    if (dialog.returnValue !== "ok" || now?.id !== doc.id) {
      useStore.setState({ opPreview: null });
      return;
    }
    const commandId = send({ type: "path_op", input: input() });
    // The preview stays drawn until the answer, so the grid does not flicker.
    useStore.setState({ opPreview: opPreview && { ...opPreview, input: input(), commandId } });
  };
  document.body.append(dialog);
  dialog.showModal();
  if (settings.preview) form.oninput(new Event("input"));
}
