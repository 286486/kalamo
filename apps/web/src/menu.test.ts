import { createDocument, createNodes, makeMask, type Node } from "@kalamo/core";
import { expect, it } from "vitest";
import {
  documentMenus,
  findByKeys,
  type Item,
  keysOf,
  type Menu,
  shapeModeTargets,
  shortcut,
} from "./menu.ts";
import { useStore } from "./store.ts";

const press = (key: string, mods: Partial<KeyboardEvent> = {}, code = "") => ({
  key,
  code,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

it("names a key press in Illustrator's Windows notation, Cmd as Ctrl", () => {
  expect(keysOf(press("Z", { shiftKey: true, ctrlKey: true }))).toBe("Shift+Ctrl+Z");
  expect(keysOf(press("a", { metaKey: true }))).toBe("Ctrl+A");
  // macOS Option turns the letter into another character; the physical key names it.
  expect(keysOf(press("ß", { altKey: true, metaKey: true }, "KeyS"))).toBe("Alt+Ctrl+S");
  expect(keysOf(press("+", { ctrlKey: true }, "NumpadAdd"))).toBe("Ctrl+=");
  expect(keysOf(press("+", { ctrlKey: true, shiftKey: true }, "Equal"))).toBe("Ctrl+=");
  expect(keysOf(press("Backspace"))).toBe("Delete");
  expect(keysOf(press("F7"))).toBe("F7");
  expect(keysOf(press("\\", {}, "Backslash"))).toBe("\\");
  expect(keysOf(press("]", { ctrlKey: true }, "BracketRight"))).toBe("Ctrl+]");
  expect(keysOf(press("}", { ctrlKey: true, shiftKey: true }, "BracketRight"))).toBe(
    "Shift+Ctrl+]",
  );
  expect(keysOf(press("{", { metaKey: true, shiftKey: true }, "BracketLeft"))).toBe("Shift+Ctrl+[");
});

it("shows a shortcut as the platform's menus do", () => {
  expect(shortcut("Shift+Ctrl+Z", true)).toBe("⇧⌘Z");
  expect(shortcut("Shift+Ctrl+Z", false)).toBe("Shift+Ctrl+Z");
  expect(shortcut("Alt+Ctrl+S", true)).toBe("⌥⌘S");
  expect(shortcut("Ctrl+=", false)).toBe("Ctrl++");
  expect(shortcut("Ctrl+=", true)).toBe("⌘+");
  expect(shortcut("Delete", true)).toBe("⌫");
});

const tabs = { open: () => {}, close: () => {} };
const menus = documentMenus(tabs);

const leaves = (items: Item[]): Exclude<Item, Menu | "-">[] =>
  items.flatMap((i) => (i === "-" ? [] : "items" in i ? leaves(i.items) : [i]));

it("lists Illustrator's menus in its order", () => {
  expect(menus.map((m) => m.label)).toEqual(["File", "Edit", "Object", "Select", "View", "Window"]);
});

it("binds each shortcut once, and none the browser keeps for itself", () => {
  const keys = leaves(menus).flatMap((i) => (i.keys ? [i.keys] : []));
  expect(new Set(keys).size).toBe(keys.length);
  for (const k of keys) expect(k).not.toMatch(/^(Shift\+)?Ctrl\+(N|T|W|Tab)$/);
});

it("finds the Menu Item a shortcut runs", () => {
  expect(findByKeys(menus, "Ctrl+A")?.label).toBe("All");
  expect(findByKeys(menus, "Shift+Ctrl+A")?.label).toBe("Deselect");
  expect(findByKeys(menus, "Ctrl+7")?.label).toBe("Make");
  expect(findByKeys(menus, "Alt+Ctrl+7")?.label).toBe("Release");
  expect(findByKeys(menus, "Shift+Ctrl+]")?.label).toBe("Bring to Front");
  expect(findByKeys(menus, "Ctrl+]")?.label).toBe("Bring Forward");
  expect(findByKeys(menus, "Ctrl+[")?.label).toBe("Send Backward");
  expect(findByKeys(menus, "Shift+Ctrl+[")?.label).toBe("Send to Back");
  expect(findByKeys(menus, "Ctrl+Q")).toBeUndefined();
});

it("enables Relink… on exactly one Image, and Embed on linked Images with pixels that are not locked", () => {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100 }],
  });
  const src = "a".repeat(64);
  doc.images.set(src, { mime: "image/png", width: 2, height: 2 });
  const image = (clientKey: string, extra: object) =>
    ({ type: "image", clientKey, parentId, x: 0, y: 0, width: 2, height: 2, ...extra }) as const;
  const { keyMap } = createNodes(doc, [
    image("embedded", { src }),
    image("linked", { src, file: "a.png" }),
    image("missing", { file: "gone.png" }),
    image("locked", { src, file: "a.png" }),
    { type: "group", clientKey: "g", parentId, children: [] },
    { type: "rect", clientKey: "r", parentId, x: 0, y: 0, width: 1, height: 1 },
  ]);
  const id = (k: string) => keyMap[k] as string;
  const lock = (nodeId: string) =>
    doc.nodes.set(nodeId, { ...(doc.nodes.get(nodeId) as Node), locked: true });
  lock(id("locked"));
  const object = menus.find((m) => m.label === "Object")?.items ?? [];
  const item = (label: string) => leaves(object).find((i) => i.label === label);
  const enabled = (label: string, keys: string[]) =>
    item(label)?.enabled?.({ ...useStore.getState(), doc, selection: keys.map(id) });

  expect(enabled("Relink…", ["missing"])).toBe(true);
  expect(enabled("Relink…", ["embedded"])).toBe(true);
  expect(enabled("Relink…", ["embedded", "linked"])).toBe(false);
  expect(enabled("Relink…", ["r"])).toBe(false);
  expect(enabled("Relink…", [])).toBe(false);

  expect(enabled("Embed", ["linked", "r"])).toBe(true);
  expect(enabled("Embed", ["missing"])).toBe(false);
  expect(enabled("Embed", ["embedded"])).toBe(false);
  expect(enabled("Embed", ["locked"])).toBe(false);
  lock(parentId);
  expect(enabled("Embed", ["linked"])).toBe(false);
});

it("disables every entry that changes the Document for a viewer, and Share… for all but the owner", () => {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100 }],
  });
  const { keyMap } = createNodes(doc, [
    { type: "rect", clientKey: "r", parentId, x: 0, y: 0, width: 10, height: 10 },
  ]);
  const shared = documentMenus({ ...tabs, share: "d" });
  const state = {
    ...useStore.getState(),
    doc,
    selection: [keyMap.r as string],
    viewport: { scale: 1, x: 0, y: 0 },
  };
  const enabled = (role: "owner" | "editor" | "viewer") =>
    leaves(shared)
      .filter((i) => i.enabled?.({ ...state, role }) ?? true)
      .map((i) => i.label);
  // What looks at, copies or leaves the Document without changing it.
  const reading = [
    "Open…",
    "Close",
    "Save a Copy…",
    "Export As SVG",
    "Copy",
    "All",
    "Deselect",
    "Inverse",
    "Zoom In",
    "Zoom Out",
    "Fit Artboard in Window",
    "Actual Size",
    "Layers",
    "Gradient",
    "Pathfinder",
    "Isolate Selected Path",
  ];
  expect(enabled("viewer").sort()).toEqual(reading.sort());
  // The same state enables edits for an editor, so the viewer's greying is the Role's.
  expect(enabled("editor")).toEqual(
    expect.arrayContaining(["Undo", "Redo", "Cut", "Paste", "Clear", "Place…"]),
  );
  expect(enabled("editor")).not.toContain("Share…");
  expect(enabled("owner")).toContain("Share…");
  expect(leaves(menus).map((i) => i.label)).not.toContain("Share…");
});

it("isolates one editable Group, and exits it from the menu or with Esc (ADR-0057)", () => {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100 }],
  });
  const rect = { type: "rect", x: 0, y: 0, width: 1, height: 1 } as const;
  const { keyMap } = createNodes(doc, [
    { type: "group", clientKey: "g", parentId, children: [rect] },
    { type: "group", clientKey: "h", parentId, children: [rect] },
    { ...rect, clientKey: "r", parentId },
  ]);
  const id = (k: string) => keyMap[k] as string;
  const item = (label: string) => leaves(menus).find((i) => i.label === label);
  const base = { ...useStore.getState(), doc, role: "viewer" as const };
  const isolate = (keys: string[]) =>
    item("Isolate Selected Group")?.enabled?.({ ...base, selection: keys.map(id) });
  // A viewer isolates as it selects.
  expect(isolate(["g"])).toBe(true);
  expect(isolate(["g", "h"])).toBe(false);
  expect(isolate(["r"])).toBe(false);

  expect(findByKeys(menus, "Escape")?.label).toBe("Exit Isolation Mode");
  expect(shortcut("Escape", false)).toBe("Esc");
  const exit = (s: Partial<typeof base>) =>
    item("Exit Isolation Mode")?.enabled?.({ ...base, isolated: id("g"), ...s });
  expect(exit({})).toBe(true);
  expect(exit({ isolated: null })).toBe(false);
  // The tools take Esc before the canvas runs the item; the menu bar never binds it.
  expect(findByKeys(menus, "Escape")?.canvas).toBe(true);
  expect(exit({ tool: "pen", pen: { anchors: [], closed: false } })).toBe(true);
});

it("isolates one selected Live Shape or Path and keeps it selected (ADR-0058)", () => {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100 }],
  });
  const rect = { type: "rect", parentId, x: 0, y: 0, width: 10, height: 10 } as const;
  const { keyMap } = createNodes(doc, [
    { ...rect, clientKey: "r" },
    { ...rect, clientKey: "s" },
    { type: "path", clientKey: "p", parentId, d: "M0 0 L10 10" },
    { type: "text", clientKey: "t", parentId, x: 0, y: 5, content: "Hi" },
    { type: "image", clientKey: "i", parentId, x: 0, y: 0, width: 2, height: 2, file: "a.png" },
    {
      type: "group",
      clientKey: "g",
      parentId,
      children: [{ type: "rect", x: 0, y: 0, width: 1, height: 1 }],
    },
    { ...rect, clientKey: "content" },
    { ...rect, clientKey: "clip" },
  ]);
  const id = (k: string) => keyMap[k] as string;
  makeMask(doc, { clipNodeId: id("clip"), contentIds: [id("content")] });
  const labels = leaves(menus).map((i) => i.label);
  expect(labels.indexOf("Isolate Selected Path")).toBe(
    labels.indexOf("Isolate Selected Group") + 1,
  );
  expect(labels.indexOf("Exit Isolation Mode")).toBe(labels.indexOf("Isolate Selected Path") + 1);
  const item = leaves(menus).find((i) => i.label === "Isolate Selected Path");
  const enabled = (keys: string[]) =>
    item?.enabled?.({ ...useStore.getState(), doc, selection: keys.map(id) });
  expect(enabled(["r"])).toBe(true);
  expect(enabled(["p"])).toBe(true);
  for (const keys of [["t"], ["i"], ["clip"], ["g"], ["r", "s"], []]) {
    expect(enabled(keys)).toBe(false);
  }
  useStore.setState({ doc, selection: [id("r")], isolated: null });
  item?.run?.();
  expect(useStore.getState()).toMatchObject({ isolated: id("r"), selection: [id("r")] });
});

it("runs a Shape Mode on two or more editable Nodes, a Group as one, never for a viewer", () => {
  const { doc, defaultLayerId: parentId } = createDocument({
    id: "d",
    name: "Doc",
    artboards: [{ width: 200, height: 100 }],
  });
  const leaf = { type: "rect", x: 0, y: 0, width: 10, height: 10 } as const;
  const rect = { ...leaf, parentId };
  const { keyMap } = createNodes(doc, [
    { ...rect, clientKey: "a" },
    { ...rect, clientKey: "b" },
    { ...rect, clientKey: "locked" },
    { ...rect, clientKey: "hidden" },
    { type: "group", clientKey: "g", parentId, children: [leaf, leaf] },
    { type: "group", clientKey: "off", parentId, children: [{ ...leaf, clientKey: "inside" }] },
  ]);
  const id = (k: string) => keyMap[k] as string;
  const locked = doc.nodes.get(id("locked")) as Node;
  doc.nodes.set(locked.id, { ...locked, locked: true });
  for (const k of ["hidden", "off"]) {
    const node = doc.nodes.get(id(k)) as Node;
    doc.nodes.set(node.id, { ...node, visible: false });
  }
  const targets = (keys: string[], role: "editor" | "viewer" = "editor") =>
    shapeModeTargets({ doc, role, selection: keys.map(id) });
  expect(targets(["a", "b"])).toEqual([id("a"), id("b")]);
  expect(targets(["a"])).toEqual([]);
  expect(targets(["g", "a"])).toEqual([id("g"), id("a")]);
  expect(targets(["locked", "a"])).toEqual([]);
  expect(targets(["hidden", "a"])).toEqual([]);
  expect(targets(["inside", "a"])).toEqual([]);
  expect(targets(["a", "b"], "viewer")).toEqual([]);
  expect(findByKeys(menus, "Shift+Ctrl+F9")?.label).toBe("Pathfinder");
});
