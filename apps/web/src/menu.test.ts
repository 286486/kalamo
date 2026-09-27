import { createDocument, createNodes, type Node } from "@zibel/core";
import { expect, it } from "vitest";
import { documentMenus, findByKeys, type Item, keysOf, type Menu, shortcut } from "./menu.ts";
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
