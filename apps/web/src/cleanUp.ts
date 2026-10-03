import { pathOp } from "@kalamo/core";
import { afterRenumbering, type NodeOp, send, useStore } from "./store.ts";

/**
 * Object > Path > Clean Up… (research 06 §5): Stray Points, Unpainted Objects and Empty Text Paths,
 * all on by default, over the whole Document. The count comes from core run on a copy, so the
 * notice can say how many objects go, or that there is nothing to clean up without a round trip.
 */
export function cleanUpDialog() {
  const dialog = Object.assign(document.createElement("dialog"), { ariaLabel: "Clean Up" });
  dialog.style.font = "13px system-ui, sans-serif";
  const box = (name: string, label: string) =>
    `<label style="display:block;margin:6px 0"><input type="checkbox" name="${name}" checked> ${label}</label>`;
  // OK comes first: Enter submits with it.
  dialog.innerHTML = `<form method="dialog">
${box("strayPoints", "Stray Points")}${box("unpainted", "Unpainted Objects")}${box("emptyText", "Empty Text Paths")}
<p style="text-align:right;margin-bottom:0"><button value="ok">OK</button> <button value="cancel">Cancel</button></p>
</form>`;
  const form = dialog.querySelector("form") as HTMLFormElement;
  const checked = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).checked;
  dialog.onclose = () => {
    dialog.remove();
    if (dialog.returnValue !== "ok") return;
    const input: NodeOp = {
      op: "clean_up",
      strayPoints: checked("strayPoints"),
      unpainted: checked("unpainted"),
      emptyText: checked("emptyText"),
    };
    cleanUp(input);
  };
  document.body.append(dialog);
  dialog.showModal();
}

/**
 * Clean Up's OK: one `path_op clean_up` once the person's own renumbering command is answered
 * (ADR-0110), and a notice that counts what it removes from the Document then.
 */
export function cleanUp(input: NodeOp) {
  afterRenumbering(({ doc }, w) => {
    if (!doc) return;
    try {
      const { deletedIds, updated } = pathOp({ ...doc, nodes: new Map(doc.nodes) }, input);
      send({ type: "path_op", input }, w);
      const trimmed = updated.length > 0 ? `, and Stray Points from ${updated.length} path(s)` : "";
      useStore.setState({ notice: `Clean Up removed ${deletedIds.length} object(s)${trimmed}.` });
    } catch (e) {
      useStore.setState({ notice: e instanceof Error ? e.message : String(e) });
    }
  });
}
