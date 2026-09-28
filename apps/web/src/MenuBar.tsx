import { useEffect, useRef, useState } from "react";
import { findByKeys, type Item, keysOf, type Menu, type MenuItem, shortcut } from "./menu.ts";
import { type State, useStore } from "./store.ts";

const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const ITEMS = ":scope > [role^=menuitem], :scope > [role=none] > [role^=menuitem]";
/** What inline styles cannot say: the focused item, a greyed-out one, the open menu's title. */
const CSS = `
[role=menubar] button { border: 0; background: none; font: inherit; color: inherit; }
[role=menubar] [role^=menuitem]:focus, [role=menubar] [aria-expanded=true] { background: #DCE6FF; outline: none; }
[role=menubar] [aria-disabled=true] { color: #999; }
`;

/** True while a menu or a dialog is open, when the canvas and the shortcuts leave the keys to it. */
export const keysTaken = () =>
  document.querySelector("[role=menubar] [popover]:popover-open, dialog[open]") !== null;

const itemsOf = (menu: Element) => [...menu.querySelectorAll<HTMLElement>(ITEMS)];
/** The role=menu or role=menubar an item sits in. */
const parentOf = (item: HTMLElement) =>
  item.parentElement?.closest<HTMLElement>("[role=menu],[role=menubar]") ?? null;
/** The menu a title or submenu item opens, its next sibling. */
const popupOf = (item: Element) => {
  const next = item.nextElementSibling;
  return next?.getAttribute("role") === "menu" ? (next as HTMLElement) : null;
};
const isOpen = (el: Element) => el.matches(":popover-open");

/** Shows the menu `item` opens and focuses its first or last item. */
function openPopup(item: HTMLElement, at: "first" | "last" | null) {
  const popup = popupOf(item);
  if (!popup) return;
  if (!isOpen(popup)) popup.showPopover();
  const items = itemsOf(popup);
  (at === "first" ? items[0] : at === "last" ? items.at(-1) : undefined)?.focus();
}

/** Puts a menu under its title, or a submenu beside its item (popovers are in the top layer). */
function position(e: React.ToggleEvent<HTMLDivElement>, beside: boolean) {
  const r = e.currentTarget.previousElementSibling?.getBoundingClientRect();
  if (e.newState !== "open" || !r) return;
  Object.assign(e.currentTarget.style, {
    left: `${beside ? r.right : r.left}px`,
    top: `${beside ? r.top - 4 : r.bottom}px`,
  });
}

const popupStyle: React.CSSProperties = {
  position: "fixed",
  inset: "auto",
  margin: 0,
  padding: "4px 0",
  minWidth: 200,
  background: "#F5F5F5",
  border: "1px solid #BBB",
  boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
  font: "13px system-ui, sans-serif",
};
const rowStyle: React.CSSProperties = {
  display: "flex",
  width: "100%",
  gap: 24,
  padding: "3px 20px",
  textAlign: "left",
};

/** Where a checked item shows its ✓. */
const gutter: React.CSSProperties = { width: 12, marginLeft: -14 };

/**
 * An Illustrator-style menu bar drawn from Menu Items (ADR-0031), which also binds their shortcuts.
 * It follows the WAI-ARIA menubar pattern on native `popover="auto"` menus.
 */
export function MenuBar({ menus }: { menus: Menu[] }) {
  const bar = useRef<HTMLDivElement>(null);
  const latest = useRef(menus);
  latest.current = menus;
  /** The open top-level menu: while one is, the items follow the store to grey out. */
  const [open, setOpen] = useState<string | null>(null);
  const followed = useStore((s) => (open ? s : null));
  const state = followed ?? useStore.getState();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const keys = keysOf(e);
      // Every edit is already saved; the browser's Save Page would save the app's HTML.
      if (keys === "Ctrl+S") e.preventDefault();
      // An open menu takes the keys; Delete on a focused title is not Clear.
      const inBar = (e.target as Element).closest?.("[role=menubar]");
      if (keysTaken() || (inBar && keys === "Delete")) return;
      if (e.key === "F10") {
        e.preventDefault();
        bar.current?.querySelector<HTMLElement>(ITEMS)?.focus();
        return;
      }
      const item = findByKeys(latest.current, keys);
      if (!item || item.native || item.canvas) return;
      e.preventDefault();
      if (item.enabled?.(useStore.getState()) ?? true) item.run();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const closeAll = () => {
    for (const m of bar.current?.querySelectorAll<HTMLElement>(
      ":scope > [role=none] > [role=menu]",
    ) ?? [])
      if (isOpen(m)) m.hidePopover();
    // Illustrator hands the keys back to the Document once a command has run.
    if (bar.current?.contains(document.activeElement))
      (document.activeElement as HTMLElement).blur();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const item = e.target as HTMLElement;
    const parent = parentOf(item);
    if (!parent || e.ctrlKey || e.metaKey || e.altKey) return;
    const siblings = itemsOf(parent);
    const i = siblings.indexOf(item);
    const titles = itemsOf(bar.current as HTMLElement);
    /** The title whose menu `item` is in, or `item` when it is a title. */
    const title = titles.find((t) => t === item || popupOf(t)?.contains(item));
    const toTitle = (step: number, at: "first" | null) => {
      const next =
        titles[(titles.indexOf(title as HTMLElement) + step + titles.length) % titles.length];
      next?.focus();
      if (at) openPopup(next as HTMLElement, at);
    };
    const inBar = parent === bar.current;
    const inSubmenu =
      !inBar && parentOf(parent.previousElementSibling as HTMLElement) !== bar.current;
    const anyOpen = titles.some((t) => isOpen(popupOf(t) as HTMLElement));
    const key = e.key;
    if (inBar && (key === "ArrowRight" || key === "ArrowLeft"))
      toTitle(key === "ArrowRight" ? 1 : -1, anyOpen ? "first" : null);
    else if (inBar && (key === "ArrowDown" || key === "Enter" || key === " "))
      openPopup(item, "first");
    else if (inBar && key === "ArrowUp") openPopup(item, "last");
    else if (inBar && key === "Escape") {
      const popup = popupOf(item);
      if (popup && isOpen(popup)) popup.hidePopover();
      else item.blur();
    } else if (inBar) return;
    else if (key === "ArrowDown" || key === "ArrowUp")
      siblings[(i + (key === "ArrowDown" ? 1 : -1) + siblings.length) % siblings.length]?.focus();
    else if (key === "Home" || key === "End")
      (key === "Home" ? siblings[0] : siblings.at(-1))?.focus();
    else if (key === "ArrowRight" && popupOf(item)) openPopup(item, "first");
    else if (key === "ArrowRight") toTitle(1, "first");
    else if (key === "ArrowLeft" && inSubmenu) {
      parent.hidePopover();
      (parent.previousElementSibling as HTMLElement).focus();
    } else if (key === "ArrowLeft") toTitle(-1, "first");
    else if (key === "Escape") {
      parent.hidePopover();
      (parent.previousElementSibling as HTMLElement).focus();
    } else if (key === "Enter" || key === " ") {
      if (popupOf(item)) openPopup(item, "first");
      else item.click();
    } else if (key === "Tab") closeAll();
    else if (key.length === 1) {
      // Typeahead: the next item, after this one, whose label starts with the letter.
      const letter = key.toLowerCase();
      const order = [...siblings.slice(i + 1), ...siblings.slice(0, i + 1)];
      order.find((s) => s.dataset.label?.toLowerCase().startsWith(letter))?.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  /** While a menu is open, pointing at another title opens it instead. */
  const onTitleEnter = (e: React.PointerEvent<HTMLButtonElement>) => {
    const t = e.currentTarget;
    if (open && popupOf(t)?.id !== open) {
      t.focus();
      openPopup(t, null);
    }
  };

  /** Pointing at an item focuses it, and opens its submenu or closes a sibling's. */
  const onItemEnter = (e: React.PointerEvent<HTMLButtonElement>) => {
    const item = e.currentTarget;
    item.focus();
    const parent = parentOf(item);
    for (const s of parent ? itemsOf(parent) : []) {
      const popup = popupOf(s);
      if (popup && s !== item && isOpen(popup)) popup.hidePopover();
    }
    if (popupOf(item)) openPopup(item, null);
  };

  const renderItems = (items: Item[], path: string) =>
    items.map((item, i) => {
      // biome-ignore lint/suspicious/noArrayIndexKey: a separator has no identity, and the table is static
      if (item === "-") return <hr key={i} style={{ border: 0, borderTop: "1px solid #CCC" }} />;
      if ("items" in item) {
        const id = `${path}-${item.label}`;
        return (
          <div key={item.label} role="none">
            <button
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              data-label={item.label}
              tabIndex={-1}
              style={rowStyle}
              onPointerEnter={onItemEnter}
              // Opens, never toggles: pointing at it has already opened it.
              onClick={(e) => openPopup(e.currentTarget, null)}
            >
              <span style={gutter} />
              <span style={{ flex: 1 }}>{item.label}</span>
              <span aria-hidden="true">▸</span>
            </button>
            <div
              id={id}
              role="menu"
              aria-label={item.label}
              popover="auto"
              style={popupStyle}
              onBeforeToggle={(e) => position(e, true)}
            >
              {renderItems(item.items, id)}
            </div>
          </div>
        );
      }
      return (
        <Row key={item.label} item={item} state={state} onEnter={onItemEnter} onRun={closeAll} />
      );
    });

  return (
    <div
      ref={bar}
      role="menubar"
      aria-label="Menu bar"
      style={{
        display: "flex",
        height: 26,
        background: "#EBEBEB",
        borderBottom: "1px solid #CCC",
        font: "13px system-ui, sans-serif",
      }}
      onKeyDown={onKeyDown}
    >
      <style>{CSS}</style>
      {menus.map((menu, i) => {
        const id = `menu-${menu.label}`;
        return (
          <div key={menu.label} role="none" style={{ display: "flex" }}>
            <button
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={open === id}
              data-label={menu.label}
              tabIndex={i === 0 ? 0 : -1}
              popoverTarget={id}
              style={{ padding: "0 10px" }}
              onPointerEnter={onTitleEnter}
            >
              {menu.label}
            </button>
            <div
              id={id}
              role="menu"
              aria-label={menu.label}
              popover="auto"
              style={popupStyle}
              onBeforeToggle={(e) => {
                position(e, false);
                // Before it shows, so its items are greyed out from the first frame.
                const opened = e.newState === "open";
                setOpen((o) => (opened ? id : o === id ? null : o));
              }}
            >
              {renderItems(menu.items, id)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Row({
  item,
  state,
  onEnter,
  onRun,
}: {
  item: MenuItem;
  state: State;
  onEnter: (e: React.PointerEvent<HTMLButtonElement>) => void;
  onRun: () => void;
}) {
  const enabled = item.enabled?.(state) ?? true;
  const checked = item.checked?.(state);
  return (
    <button
      type="button"
      role="menuitem"
      {...(checked !== undefined && { role: "menuitemcheckbox", "aria-checked": checked })}
      aria-disabled={!enabled}
      aria-keyshortcuts={item.keys && ariaKeys(item.keys)}
      data-label={item.label}
      tabIndex={-1}
      style={rowStyle}
      onPointerEnter={onEnter}
      onClick={() => {
        if (!enabled) return;
        // Run inside the click, a user gesture, before closing: Copy and Cut need it.
        item.run();
        onRun();
      }}
    >
      <span style={gutter} aria-hidden="true">
        {checked && "✓"}
      </span>
      <span style={{ flex: 1 }}>{item.label}</span>
      {item.keys && <span aria-hidden="true">{shortcut(item.keys, MAC)}</span>}
    </button>
  );
}

/** `keys` in aria-keyshortcuts' notation. */
const ariaKeys = (keys: string) =>
  keys
    .split("+")
    .map((k) => (k === "Ctrl" ? (MAC ? "Meta" : "Control") : k))
    .join("+");
