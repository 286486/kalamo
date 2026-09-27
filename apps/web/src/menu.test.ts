import { expect, it } from "vitest";
import { documentMenus, findByKeys, type Item, keysOf, type Menu, shortcut } from "./menu.ts";

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
  expect(menus.map((m) => m.label)).toEqual(["File", "Edit", "Select", "View", "Window"]);
});

it("binds each shortcut once, and none the browser keeps for itself", () => {
  const keys = leaves(menus).flatMap((i) => (i.keys ? [i.keys] : []));
  expect(new Set(keys).size).toBe(keys.length);
  for (const k of keys) expect(k).not.toMatch(/^(Shift\+)?Ctrl\+(N|T|W|Tab)$/);
});

it("finds the Menu Item a shortcut runs", () => {
  expect(findByKeys(menus, "Ctrl+A")?.label).toBe("All");
  expect(findByKeys(menus, "Shift+Ctrl+A")?.label).toBe("Deselect");
  expect(findByKeys(menus, "Ctrl+Q")).toBeUndefined();
});
