/** Document Tabs (ADR-0030): browser state only, the active tab is the URL. */

import { getItem } from "./storage.ts";

const KEY = "kalamo:tabs" as const;

/** The open tabs' docIds, remembered per browser; empty when storage is blocked or cleared. */
export function loadTabs(): string[] {
  try {
    const tabs: unknown = JSON.parse(getItem(KEY) ?? "[]");
    return Array.isArray(tabs) ? tabs.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function saveTabs(tabs: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(tabs));
  } catch {
    // Storage blocked: the tabs last for this page only.
  }
}

export const withTab = (tabs: string[], docId: string) =>
  tabs.includes(docId) ? tabs : [...tabs, docId];

/** Closing the active tab shows the one after it, or before it when it was last, as Illustrator does. */
export function closeTab(tabs: string[], docId: string, active: string) {
  const i = tabs.indexOf(docId);
  const rest = tabs.filter((id) => id !== docId);
  const next = docId === active ? (rest[i] ?? rest[i - 1] ?? null) : active;
  return { tabs: rest, next };
}

/**
 * Shows `/docs/<docId>` in this page, so the other tabs keep their view (main.tsx follows it).
 * `replace` for a tab shown because the active one closed, so Back does not reopen it.
 */
export function go(docId: string, replace = false) {
  history[replace ? "replaceState" : "pushState"](null, "", `/docs/${docId}`);
  dispatchEvent(new PopStateEvent("popstate"));
}

export interface Opened {
  docId: string;
  warnings: { code: string; message: string }[];
}

/**
 * What Open file takes, for the file input's `accept` and a drop on the tab bar: any image, as
 * Place, so the Worker refuses one it cannot open with Place's reason (ADR-0098).
 */
export const OPENABLE = ".svg,.json,image/*,application/json";
export const openable = (file: File) =>
  /\.(svg|json)$/i.test(file.name) ||
  file.type === "application/json" ||
  file.type.startsWith("image/");

/**
 * Open: a new Document from an .svg, a .kalamo.json or a PNG, JPEG or GIF, its bytes sent over HTTP
 * and read in the Worker, like kalamo_doc_open (ADR-0017, ADR-0098).
 */
export async function openFile(file: File): Promise<Opened> {
  const res = await fetch(`/api/docs?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    body: file,
  });
  const body = (await res.json()) as Opened & { message?: string; hint?: string };
  if (!res.ok) throw new Error(`${body.message} ${body.hint ?? ""}`);
  return body;
}
