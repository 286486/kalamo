import {
  ARRANGE,
  type Combining,
  type Document,
  isCompoundPath,
  type Node,
  operandLeaves,
  PATH_OP_TEXT,
  type PathOpInput,
  type ReorderOp,
  reorderNodes,
  serializeDocument,
} from "@kalamo/core";
import { toSvg } from "@kalamo/io/write";
import { sendAnchorEdits } from "./anchorTools.ts";
import { cleanUpDialog } from "./cleanUp.ts";
import { curvatureClearInputs, removeCurveAnchor } from "./curvature.ts";
import { anchorOpTargets, clearInputs, inRange, removeAnchorInputs } from "./direct.ts";
import { exitLevel, isLeaf, isolate } from "./isolation.ts";
import { offsetDialog } from "./offset.ts";
import { PLACEABLE, pasteClipboard, place, relink } from "./place.ts";
import {
  editable,
  embeddable,
  expandable,
  inverse,
  maskInput,
  objects,
  pathTargets,
  releasable,
  relinkable,
} from "./selection.ts";
import { shareDialog } from "./share.ts";
import { startSimplify } from "./simplify.ts";
import { splitGridDialog } from "./splitGrid.ts";
import { canEdit, type State, send, useStore } from "./store.ts";
import { OPENABLE } from "./tabs.ts";
import { drawing, undoAnchor } from "./tools.ts";
import { artboardsRect, fit, zoomAt, zoomStep } from "./viewport.ts";

/**
 * One Menu Item (ADR-0031). The menu bar draws it and the `keydown` handler runs it by `keys`, so a
 * shortcut and its menu entry cannot drift apart.
 */
export interface MenuItem {
  label: string;
  /** Illustrator's Windows notation, modifiers in the order Alt, Shift, Ctrl; Ctrl is Cmd on macOS. */
  keys?: string;
  /** The browser runs the shortcut itself: the clipboard events only a real key press fires. */
  native?: true;
  /** The canvas runs the shortcut once no tool takes the key (Viewer.tsx), not the menu bar. */
  canvas?: true;
  /** Greyed out when false; always enabled without it. */
  enabled?: (s: State) => boolean;
  checked?: (s: State) => boolean;
  run: () => void;
}
export interface Menu {
  label: string;
  items: Item[];
}
/** A submenu, a separator, or a Menu Item. */
export type Item = MenuItem | Menu | "-";

/** Opens the browser's file dialog; `then` never runs when the user cancels. */
export function pickFile(accept: string, then: (file: File) => void) {
  const input = Object.assign(document.createElement("input"), { type: "file", accept });
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) then(file);
  };
  input.click();
}

/** Saves text the browser made from its Document: the same text `export` returns at that rev. */
function download(text: string, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  Object.assign(document.createElement("a"), { href: url, download: filename }).click();
  URL.revokeObjectURL(url);
}

/** Makes a download once every image file it embeds is here (ADR-0023). */
async function save(
  make: (doc: Document, images: (id: string) => string | undefined) => [string, string, string],
) {
  const { doc, images } = useStore.getState();
  if (!doc || !images) return;
  try {
    await images.ready(doc);
    download(...make(doc, (id) => images.get(id)?.dataUrl));
  } catch (e) {
    useStore.setState({ notice: `Could not download: ${String(e)}` });
  }
}

/**
 * Items that change the Document, greyed out for a viewer as well as when their own test fails
 * (ADR-0047). The server refuses a viewer's command regardless.
 */
const edits = (items: Item[]): Item[] =>
  items.map((item) =>
    item === "-"
      ? item
      : "items" in item
        ? { ...item, items: edits(item.items) }
        : { ...item, enabled: (s) => canEdit(s) && (item.enabled?.(s) ?? true) },
  );

const hasDoc = (s: State) => s.doc !== null;
const hasView = (s: State) => s.viewport !== null;
const hasSelection = (s: State) => s.selection.length > 0;

const hasPathTargets = ({ doc, selection }: State) =>
  doc !== null && pathTargets(doc, selection).length > 0;

/** An Object > Path item that runs `op` on the Selection's paths and Live Shapes (pathTargets). */
const pathOp = (
  op: Exclude<PathOpInput["op"], "convert_to_path" | "offset" | "split_into_grid" | "clean_up">,
): MenuItem => ({
  label: PATH_OP_TEXT[op].menu,
  enabled: hasPathTargets,
  run: () => {
    const { doc, selection } = useStore.getState();
    const nodeIds = doc ? pathTargets(doc, selection) : [];
    if (nodeIds.length > 0) send({ type: "path_op", input: { nodeIds, op } });
  },
});

/** The Selection's Nodes Object > Arrange restacks: those not hidden or locked. */
const arrangeable = ({ doc, selection }: Pick<State, "doc" | "selection">) =>
  doc ? selection.filter((id) => editable(doc, doc.nodes.get(id))) : [];

/**
 * The Pathfinder panel's Shape Mode operands: the arrangeable Nodes, a Group as one (ADR-0104), or
 * none for a viewer or fewer than two. The server rejects what ADR-0104 cannot combine.
 */
export const shapeModeTargets = (s: Pick<State, "doc" | "selection" | "role">) => {
  const nodeIds = canEdit(s) ? arrangeable(s) : [];
  return nodeIds.length >= 2 ? nodeIds : [];
};

/** Runs `op` on `nodeIds`; the Nodes it creates become the Selection, as in Illustrator. */
function selectingPathOp(nodeIds: string[], op: PathOpInput["op"]) {
  if (nodeIds.length === 0) return;
  const commandId = send({ type: "path_op", input: { nodeIds, op } });
  useStore.setState((s) => ({
    notice: null,
    pending: [...s.pending, { commandId, nodes: [], select: true }],
  }));
}

/** Runs a Shape Mode or Pathfinder on the Selection. */
export const shapeMode = (op: Combining) =>
  selectingPathOp(shapeModeTargets(useStore.getState()), op);

/**
 * Object > Compound Path > Make's operands: the selected paths and Live Shapes, and those that paint
 * in a selected Group, editable, two or more (ADR-0107).
 */
export const makeTargets = ({ doc, selection }: Pick<State, "doc" | "selection">) => {
  const nodeIds = doc ? compoundParts(doc, selection).map((n) => n.id) : [];
  return nodeIds.length >= 2 ? nodeIds : [];
};

/** Object > Compound Path > Release's targets: the selected paths of two or more subpaths. */
export const releaseTargets = ({ doc, selection }: Pick<State, "doc" | "selection">) =>
  doc
    ? compoundParts(doc, selection)
        .filter(isCompoundPath)
        .map((n) => n.id)
    : [];

/** The Selection's editable leaves that core's operandLeaves takes, each once. */
export const compoundParts = (doc: Document, selection: string[]) => [
  ...new Set(
    selection
      .map((id) => doc.nodes.get(id))
      .filter((n): n is Node => editable(doc, n))
      .flatMap((n) => operandLeaves(doc, n))
      .filter((n) => editable(doc, n)),
  ),
];

/** An Object > Arrange item: restacks each selected Node in its own parent (ADR-0074). */
const arrange = (op: ReorderOp, keys: string): MenuItem => ({
  label: ARRANGE[op],
  keys,
  enabled: (s) => arrangeable(s).length > 0,
  run: () => {
    const { doc, selection } = useStore.getState();
    const nodeIds = arrangeable({ doc, selection });
    // Nothing is sent when every Node is already where op puts it, so Undo has no empty step.
    const moves = doc && reorderNodes({ ...doc, nodes: new Map(doc.nodes) }, nodeIds, op).nodes;
    if (moves && moves.length > 0) send({ type: "reorder", nodeIds, op });
  },
});

/** Join or Average on the selected Anchors, else on the Selection's paths (anchorOpTargets). */
const anchorOp = (op: "join" | "average") => ({
  enabled: ({ doc, selection, anchors }: State) =>
    doc !== null && anchorOpTargets(doc, selection, anchors, op) !== null,
  targets: () => {
    const { doc, selection, anchors } = useStore.getState();
    return doc && anchorOpTargets(doc, selection, anchors, op);
  },
});
const join = anchorOp("join");
const average = anchorOp("average");

type Axis = NonNullable<PathOpInput["axis"]>;
const AXES: Axis[] = ["horizontal", "vertical", "both"];

/** Object > Path > Average…'s dialog, Illustrator's Axis choice; `then` never runs on Cancel. */
function averageDialog(then: (axis: Axis) => void) {
  const dialog = Object.assign(document.createElement("dialog"), { ariaLabel: "Average" });
  dialog.style.font = "13px system-ui, sans-serif";
  const radios = AXES.map(
    (a) =>
      `<label style="display:block"><input type="radio" name="axis" value="${a}"${a === "both" ? " checked" : ""}> ${a[0]?.toUpperCase()}${a.slice(1)}</label>`,
  );
  // OK comes first: Enter submits with it.
  dialog.innerHTML = `<form method="dialog"><fieldset><legend>Axis</legend>${radios.join("")}</fieldset><p style="text-align:right;margin-bottom:0"><button value="ok">OK</button> <button value="cancel">Cancel</button></p></form>`;
  dialog.onclose = () => {
    const form = dialog.querySelector("form") as HTMLFormElement;
    if (dialog.returnValue === "ok") then(new FormData(form).get("axis") as Axis);
    dialog.remove();
  };
  document.body.append(dialog);
  dialog.showModal();
}

const select =
  (pick: (doc: Document, selection: string[], scope: string | null) => string[]) => () => {
    const { doc, selection, isolated } = useStore.getState();
    if (doc) useStore.setState({ selection: pick(doc, selection, isolated) });
  };

/**
 * Object > Isolate Selected Group or Isolate Selected Path: the one selected Node, a Group or a
 * Live Shape or Path as `kind` says, when it can be isolated (ADR-0057, ADR-0058).
 */
function isolating(doc: Document, selection: string[], kind: (n: Node) => boolean) {
  const [id, ...rest] = selection;
  const n = doc.nodes.get(id ?? "");
  return n && rest.length === 0 && kind(n) ? isolate(doc, n.id) : null;
}
const isGroup = (n: Node) => n.type === "group";

/** Object > Exit Isolation Mode, and Esc when no tool takes it: up one level (ADR-0057). */
export function exitIsolation() {
  const { doc, isolated } = useStore.getState();
  if (doc && isolated) useStore.setState(exitLevel(doc, isolated));
}

const view =
  (next: (s: State & { viewport: NonNullable<State["viewport"]> }) => State["viewport"]) => () => {
    const s = useStore.getState();
    if (s.viewport) useStore.setState({ viewport: next({ ...s, viewport: s.viewport }) });
  };
const zoom = (dir: 1 | -1) =>
  view(({ viewport: v, size }) =>
    zoomAt(v, zoomStep(v.scale, dir) / v.scale, size.width / 2, size.height / 2),
  );

const openItem = (open: (file: File) => void): MenuItem => ({
  label: "Open…",
  keys: "Ctrl+O",
  run: () => pickFile(OPENABLE, open),
});

/** The Document list's menu bar: File > Open… only. */
export const listMenus = (open: (file: File) => void): Menu[] => [
  { label: "File", items: [openItem(open)] },
];

/**
 * The menu bar over the Document Tabs; every item acts on the active tab's Document. `share` is
 * the Document's id when File > Share… applies: GitHub mode, where there are others to share with.
 */
export function documentMenus(tabs: {
  open: (file: File) => void;
  close: () => void;
  share?: string;
}): Menu[] {
  const { share } = tabs;
  return [
    {
      label: "File",
      items: [
        openItem(tabs.open),
        { label: "Close", run: tabs.close },
        "-",
        {
          label: "Save a Copy…",
          keys: "Alt+Ctrl+S",
          enabled: hasDoc,
          run: () =>
            save((doc, images) => [
              serializeDocument(doc, images),
              "application/json",
              `${doc.name}.kalamo.json`,
            ]),
        },
        {
          label: "Export",
          items: [
            {
              label: "Export As SVG",
              enabled: hasDoc,
              run: () =>
                save((doc, images) => [
                  toSvg(doc, undefined, { images }),
                  "image/svg+xml",
                  `${doc.name}.svg`,
                ]),
            },
          ],
        },
        ...(share
          ? [
              "-" as const,
              {
                label: "Share…",
                enabled: (s: State) => s.role === "owner",
                run: () => shareDialog(share),
              },
            ]
          : []),
        "-",
        ...edits([
          {
            label: "Place…",
            keys: "Shift+Ctrl+P",
            enabled: hasDoc,
            run: () => pickFile(PLACEABLE, place),
          },
        ]),
      ],
    },
    {
      label: "Edit",
      items: [
        ...edits([
          // Undo and Redo stay enabled: an empty stack answers with a rejection notice (ADR-0011).
          {
            label: "Undo",
            keys: "Ctrl+Z",
            enabled: hasDoc,
            // While the Pen draws, Undo takes back its last Anchor and sends nothing (ADR-0032).
            run: () => {
              if (!undoAnchor()) send({ type: "undo" });
            },
          },
          {
            label: "Redo",
            keys: "Shift+Ctrl+Z",
            enabled: hasDoc,
            run: () => send({ type: "redo" }),
          },
          "-",
          // A click is a user gesture, so execCommand fires the copy or cut event a key press would.
          {
            label: "Cut",
            keys: "Ctrl+X",
            native: true,
            enabled: hasSelection,
            run: () => document.execCommand("cut"),
          },
        ]),
        {
          label: "Copy",
          keys: "Ctrl+C",
          native: true,
          enabled: hasSelection,
          run: () => document.execCommand("copy"),
        },
        ...edits([
          {
            label: "Paste",
            keys: "Ctrl+V",
            native: true,
            enabled: hasView,
            run: () => pasteClipboard(false),
          },
          {
            label: "Paste in Place",
            keys: "Shift+Ctrl+V",
            native: true,
            enabled: hasView,
            run: () => pasteClipboard(true),
          },
          {
            label: "Clear",
            keys: "Delete",
            enabled: (s) => {
              const { doc } = s;
              if (s.tool === "curvature" && drawing(s)) return true;
              return doc !== null && s.selection.some((id) => editable(doc, doc.nodes.get(id)));
            },
            run: () => {
              const { doc, selection, anchors, segments, tool } = useStore.getState();
              // The Curvature tool removes an Anchor and keeps the curve connected (research 06 §2).
              if (tool === "curvature" && removeCurveAnchor()) return;
              if (!doc) return;
              if (tool === "curvature" && anchors.length > 0) {
                sendAnchorEdits(curvatureClearInputs(doc, selection, anchors));
                return;
              }
              if (anchors.length > 0 || segments.length > 0) {
                // Selected Anchors go with their segments and selected segments alone, opening the
                // path (research §4), and selected objects with neither go whole: one command per
                // path.
                sendAnchorEdits(clearInputs(doc, selection, anchors, segments));
                return;
              }
              // The answering tx prunes the Selection; a rejection keeps it for another press.
              const nodeIds = selection.filter((id) => editable(doc, doc.nodes.get(id)));
              if (nodeIds.length > 0) send({ type: "delete", nodeIds });
            },
          },
        ]),
      ],
    },
    {
      label: "Object",
      items: [
        ...edits([
          {
            label: "Arrange",
            items: [
              arrange("front", "Shift+Ctrl+]"),
              arrange("forward", "Ctrl+]"),
              arrange("backward", "Ctrl+["),
              arrange("back", "Shift+Ctrl+["),
            ],
          },
          {
            // Illustrator's order; Smooth takes its place when it arrives.
            label: "Path",
            items: [
              {
                label: PATH_OP_TEXT.join.menu,
                keys: "Ctrl+J",
                enabled: join.enabled,
                run: () => {
                  const input = join.targets();
                  if (input) send({ type: "path_op", input: { ...input, op: "join" } });
                },
              },
              {
                label: PATH_OP_TEXT.average.menu,
                keys: "Alt+Ctrl+J",
                enabled: average.enabled,
                run: () => {
                  if (!average.targets()) return;
                  averageDialog((axis) => {
                    // The Selection may have changed while the dialog was open.
                    const input = average.targets();
                    if (input) send({ type: "path_op", input: { ...input, op: "average", axis } });
                  });
                },
              },
              pathOp("outline_stroke"),
              { label: PATH_OP_TEXT.offset.menu, enabled: hasPathTargets, run: offsetDialog },
              pathOp("reverse"),
              { label: PATH_OP_TEXT.simplify.menu, enabled: hasPathTargets, run: startSimplify },
              pathOp("add_anchors"),
              {
                label: "Remove Anchor Points",
                enabled: ({ doc, anchors }) => doc !== null && anchors.some((k) => inRange(doc, k)),
                run: () => {
                  const { doc, anchors } = useStore.getState();
                  if (doc) sendAnchorEdits(removeAnchorInputs(doc, anchors));
                },
              },
              {
                ...pathOp("divide_below"),
                // Illustrator's needs one object selected.
                enabled: ({ doc, selection }) =>
                  doc !== null && pathTargets(doc, selection).length === 1,
              },
              {
                label: PATH_OP_TEXT.split_into_grid.menu,
                enabled: hasPathTargets,
                run: splitGridDialog,
              },
              { label: PATH_OP_TEXT.clean_up.menu, enabled: hasDoc, run: cleanUpDialog },
            ],
          },
          {
            label: "Shape",
            items: [
              {
                label: PATH_OP_TEXT.convert_to_path.menu,
                enabled: ({ doc, selection }) =>
                  doc !== null && expandable(doc, selection).length > 0,
                run: () => {
                  const { doc, selection } = useStore.getState();
                  const nodeIds = doc ? expandable(doc, selection) : [];
                  if (nodeIds.length > 0) {
                    send({ type: "path_op", input: { nodeIds, op: "convert_to_path" } });
                  }
                },
              },
            ],
          },
          {
            label: "Clipping Mask",
            items: [
              {
                label: "Make",
                keys: "Ctrl+7",
                enabled: ({ doc, selection }) => doc !== null && maskInput(doc, selection) !== null,
                run: () => {
                  const { doc, selection } = useStore.getState();
                  const input = doc && maskInput(doc, selection);
                  if (input) send({ type: "mask_make", input });
                },
              },
              {
                label: "Release",
                keys: "Alt+Ctrl+7",
                enabled: ({ doc, selection }) =>
                  doc !== null && releasable(doc, selection).length > 0,
                run: () => {
                  const { doc, selection } = useStore.getState();
                  const nodeIds = doc ? releasable(doc, selection) : [];
                  if (nodeIds.length > 0) send({ type: "mask_release", nodeIds });
                },
              },
            ],
          },
          {
            label: "Compound Path",
            items: [
              {
                label: PATH_OP_TEXT.make_compound_path.menu,
                keys: "Ctrl+8",
                enabled: (s) => makeTargets(s).length > 0,
                run: () => selectingPathOp(makeTargets(useStore.getState()), "make_compound_path"),
              },
              {
                label: PATH_OP_TEXT.release_compound_path.menu,
                keys: "Alt+Shift+Ctrl+8",
                enabled: (s) => releaseTargets(s).length > 0,
                run: () =>
                  selectingPathOp(releaseTargets(useStore.getState()), "release_compound_path"),
              },
            ],
          },
        ]),
        // A viewer isolates as it selects (ADR-0057).
        {
          label: "Isolate Selected Group",
          enabled: ({ doc, selection }) =>
            doc !== null && isolating(doc, selection, isGroup) !== null,
          run: () => {
            const { doc, selection } = useStore.getState();
            const isolated = doc && isolating(doc, selection, isGroup);
            if (isolated) useStore.setState({ isolated, selection: [] });
          },
        },
        {
          label: "Isolate Selected Path",
          enabled: ({ doc, selection }) =>
            doc !== null && isolating(doc, selection, isLeaf) !== null,
          run: () => {
            const { doc, selection } = useStore.getState();
            const isolated = doc && isolating(doc, selection, isLeaf);
            // The leaf stays selected (ADR-0058).
            if (isolated) useStore.setState({ isolated });
          },
        },
        {
          label: "Exit Isolation Mode",
          keys: "Escape",
          // A Pen or Curvature path, the Zoom tool, Simplify or a dialog takes Esc first.
          canvas: true,
          enabled: (s) => s.isolated !== null,
          run: exitIsolation,
        },
        ...edits([
          "-",
          {
            label: "Relink…",
            enabled: ({ doc, selection }) =>
              doc !== null && relinkable(doc, selection) !== undefined,
            run: () => {
              const { doc, selection } = useStore.getState();
              const nodeId = doc && relinkable(doc, selection);
              if (nodeId) pickFile("image/*", (file) => relink(nodeId, file));
            },
          },
          {
            label: "Embed",
            enabled: ({ doc, selection }) => doc !== null && embeddable(doc, selection).length > 0,
            run: () => {
              const { doc, selection } = useStore.getState();
              const nodeIds = doc ? embeddable(doc, selection) : [];
              if (nodeIds.length > 0) send({ type: "embed", nodeIds });
            },
          },
        ]),
      ],
    },
    {
      label: "Select",
      items: [
        {
          label: "All",
          keys: "Ctrl+A",
          enabled: hasDoc,
          run: select((doc, _, scope) => objects(doc, scope).map((n) => n.id)),
        },
        { label: "Deselect", keys: "Shift+Ctrl+A", enabled: hasSelection, run: select(() => []) },
        { label: "Inverse", enabled: hasDoc, run: select(inverse) },
      ],
    },
    {
      label: "View",
      items: [
        { label: "Zoom In", keys: "Ctrl+=", enabled: hasView, run: zoom(1) },
        { label: "Zoom Out", keys: "Ctrl+-", enabled: hasView, run: zoom(-1) },
        "-",
        {
          label: "Fit Artboard in Window",
          keys: "Ctrl+0",
          enabled: (s) => hasView(s) && hasDoc(s),
          run: view(({ doc, size, viewport }) =>
            doc ? fit(artboardsRect(doc), size.width, size.height) : viewport,
          ),
        },
        {
          label: "Actual Size",
          keys: "Ctrl+1",
          enabled: hasView,
          run: view(({ viewport: v, size }) =>
            zoomAt(v, 1 / v.scale, size.width / 2, size.height / 2),
          ),
        },
      ],
    },
    {
      label: "Window",
      items: [
        {
          label: "Layers",
          keys: "F7",
          checked: (s) => s.layersShown,
          run: () => useStore.setState((s) => ({ layersShown: !s.layersShown })),
        },
        {
          label: "Gradient",
          keys: "Ctrl+F9",
          checked: (s) => s.gradientShown,
          run: () => useStore.setState((s) => ({ gradientShown: !s.gradientShown })),
        },
        {
          label: "Pathfinder",
          keys: "Shift+Ctrl+F9",
          checked: (s) => s.pathfinderShown,
          run: () => useStore.setState((s) => ({ pathfinderShown: !s.pathfinderShown })),
        },
        {
          label: "Attributes",
          keys: "Ctrl+F11",
          checked: (s) => s.attributesShown,
          run: () => useStore.setState((s) => ({ attributesShown: !s.attributesShown })),
        },
      ],
    },
  ];
}

/** A key press named as `MenuItem.keys` names it. */
export function keysOf(
  e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
): string {
  let key = e.key;
  // macOS Option types another character, such as ß for S; the physical key names it then.
  if (key.length === 1 && key > "~") key = e.code.replace(/^(Key|Digit)/, "");
  // Shift+8 types *, and Illustrator names the digit key; + and AZERTY's unshifted - keep theirs.
  else if (e.shiftKey && key !== "+" && /^Digit\d$/.test(e.code)) key = e.code.slice(5);
  // Ctrl++ is Shift+Ctrl+= on a US keyboard, and Ctrl+= wherever + has a key of its own.
  const plus = key === "+";
  if (plus) key = "=";
  else if (key === "Backspace") key = "Delete";
  // Shift+] types }, and Illustrator names the bracket key.
  else if (key === "{") key = "[";
  else if (key === "}") key = "]";
  if (key.length === 1) key = key.toUpperCase();
  return [
    e.altKey && "Alt",
    e.shiftKey && !plus && "Shift",
    (e.ctrlKey || e.metaKey) && "Ctrl",
    key,
  ]
    .filter(Boolean)
    .join("+");
}

const MAC_GLYPHS: Record<string, string> = { Alt: "⌥", Shift: "⇧", Ctrl: "⌘", Delete: "⌫" };

/** `keys` as the platform's menus show it: ⇧⌘Z on macOS, Shift+Ctrl+Z elsewhere. */
export function shortcut(keys: string, mac: boolean): string {
  const parts = keys.split("+").map((k) => (k === "=" ? "+" : k === "Escape" ? "Esc" : k));
  return mac ? parts.map((k) => MAC_GLYPHS[k] ?? k).join("") : parts.join("+");
}

/** The Menu Item whose shortcut is `keys`, wherever it sits. */
export function findByKeys(items: Item[], keys: string): MenuItem | undefined {
  for (const item of items) {
    if (item === "-") continue;
    const found =
      "items" in item ? findByKeys(item.items, keys) : item.keys === keys ? item : undefined;
    if (found) return found;
  }
}
