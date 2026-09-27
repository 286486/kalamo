import { type Document, type PathOpInput, serializeDocument } from "@zibel/core";
import { toSvg } from "@zibel/io/write";
import { curvatureClearInputs, removeCurveAnchor } from "./curvature.ts";
import { clearInputs, inRange, removeAnchorInputs } from "./direct.ts";
import { PLACEABLE, pasteClipboard, place } from "./place.ts";
import {
  editable,
  expandable,
  inverse,
  maskInput,
  objects,
  pathTargets,
  releasable,
} from "./selection.ts";
import { type State, send, useStore } from "./store.ts";
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

const hasDoc = (s: State) => s.doc !== null;
const hasView = (s: State) => s.viewport !== null;
const hasSelection = (s: State) => s.selection.length > 0;

/** One `path_edit` per path and one `delete`, for edits on the selected Anchors, which they clear. */
function sendAnchorEdits({ edits, deleteIds }: ReturnType<typeof clearInputs>) {
  for (const input of edits) send({ type: "path_edit", input });
  if (deleteIds.length > 0) send({ type: "delete", nodeIds: deleteIds });
  useStore.setState({ anchors: [] });
}

/** An Object > Path item that runs `op` on the Selection's paths and Live Shapes (pathTargets). */
const pathOp = (label: string, op: Exclude<PathOpInput["op"], "convert_to_path">): MenuItem => ({
  label,
  enabled: ({ doc, selection }) => doc !== null && pathTargets(doc, selection).length > 0,
  run: () => {
    const { doc, selection } = useStore.getState();
    const nodeIds = doc ? pathTargets(doc, selection) : [];
    if (nodeIds.length > 0) send({ type: "path_op", input: { nodeIds, op } });
  },
});

const select = (pick: (doc: Document, selection: string[]) => string[]) => () => {
  const { doc, selection } = useStore.getState();
  if (doc) useStore.setState({ selection: pick(doc, selection) });
};

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

/** The menu bar over the Document Tabs; every item acts on the active tab's Document. */
export function documentMenus(tabs: { open: (file: File) => void; close: () => void }): Menu[] {
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
              `${doc.name}.zibel.json`,
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
        "-",
        {
          label: "Place…",
          keys: "Shift+Ctrl+P",
          enabled: hasDoc,
          run: () => pickFile(PLACEABLE, place),
        },
      ],
    },
    {
      label: "Edit",
      items: [
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
        { label: "Redo", keys: "Shift+Ctrl+Z", enabled: hasDoc, run: () => send({ type: "redo" }) },
        "-",
        // A click is a user gesture, so execCommand fires the copy or cut event a key press would.
        {
          label: "Cut",
          keys: "Ctrl+X",
          native: true,
          enabled: hasSelection,
          run: () => document.execCommand("cut"),
        },
        {
          label: "Copy",
          keys: "Ctrl+C",
          native: true,
          enabled: hasSelection,
          run: () => document.execCommand("copy"),
        },
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
            const { doc, selection, anchors, tool } = useStore.getState();
            // The Curvature tool removes an Anchor and keeps the curve connected (research 06 §2).
            if (tool === "curvature" && removeCurveAnchor()) return;
            if (!doc) return;
            if (tool === "curvature" && anchors.length > 0) {
              sendAnchorEdits(curvatureClearInputs(doc, selection, anchors));
              return;
            }
            if (anchors.length > 0) {
              // Selected Anchors go with their segments, opening the path (research §4), and
              // selected objects without a selected Anchor go whole: one command per path.
              sendAnchorEdits(clearInputs(doc, selection, anchors));
              return;
            }
            // The answering tx prunes the Selection; a rejection keeps it for another press.
            const nodeIds = selection.filter((id) => editable(doc, doc.nodes.get(id)));
            if (nodeIds.length > 0) send({ type: "delete", nodeIds });
          },
        },
      ],
    },
    {
      label: "Object",
      items: [
        {
          // Illustrator's order; Join, Average, Outline Stroke, Offset Path, Simplify and Smooth
          // take their places as they arrive.
          label: "Path",
          items: [
            pathOp("Reverse Path Direction", "reverse"),
            pathOp("Add Anchor Points", "add_anchors"),
            {
              label: "Remove Anchor Points",
              enabled: ({ doc, anchors }) => doc !== null && anchors.some((k) => inRange(doc, k)),
              run: () => {
                const { doc, anchors } = useStore.getState();
                if (doc) sendAnchorEdits(removeAnchorInputs(doc, anchors));
              },
            },
          ],
        },
        {
          label: "Shape",
          items: [
            {
              label: "Expand Shape",
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
      ],
    },
    {
      label: "Select",
      items: [
        {
          label: "All",
          keys: "Ctrl+A",
          enabled: hasDoc,
          run: select((doc) => objects(doc).map((n) => n.id)),
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
  // Ctrl++ is Shift+Ctrl+= on a US keyboard, and Ctrl+= wherever + has a key of its own.
  const plus = key === "+";
  if (plus) key = "=";
  else if (key === "Backspace") key = "Delete";
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
  const parts = keys.split("+").map((k) => (k === "=" ? "+" : k));
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
