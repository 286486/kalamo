---
status: accepted
date: 2026-09-27
---

# A desktop-style menu bar above the Document Tabs, built from one table that also binds the shortcuts

The browser's commands are a row of floating buttons over the canvas (Select All, Deselect, Inverse, Download .zibel.json, Download SVG) plus a `keydown` switch in `Viewer.tsx` that binds the shortcuts again. Each new feature (Copy and Paste in #70, clipping masks in #52, and the `Object > Path` commands of F-PATH-03) would add another button and another case in that switch. The P2 persona expects Illustrator's menus and shortcuts (REQUIREMENTS §4, principle 10), so Zibel gets Illustrator's menu bar.

## Decision

**Layout, top to bottom:** the menu bar, then the Document Tabs (ADR-0030), then the canvas with the Layers panel on the right. The floating button row is removed. The zoom level and "connecting…" move to a status bar at the canvas's bottom left, where Illustrator shows the zoom. The menu bar sits above the tabs because it acts on whichever tab is active, as in Illustrator.

**One table.** `apps/web/src/menu.ts` holds every Menu Item as data: `label`, optional `keys`, `enabled(state)`, optional `checked(state)`, and `run()`. The menu bar is drawn from this table, and the `keydown` handler looks shortcuts up in the same table, so a shortcut and its menu entry cannot drift apart. Tool keys (V, Z, Space and later P, M, L, T) are not Menu Items and stay with the tools, just as Illustrator lists Tools and Menu Commands separately in its Keyboard Shortcuts dialog. A later context menu (right-click, and long-press for F-FREE-08) reads the same table.

**Illustrator's menus, in Illustrator's order:** File, Edit, Object, Type, Select, Effect, View, Window, Help. A menu is shown only once it has an item, and an item only once its feature exists: a greyed-out entry for something Zibel cannot do yet would read as a bug. An item that exists but does not apply right now, such as Clear with nothing selected, is greyed out, as in Illustrator. Labels and shortcuts are Illustrator's; the shortcut is shown right-aligned, as `⇧⌘Z` on macOS and `Shift+Ctrl+Z` elsewhere.

The first contents are today's features, plus Place… and the Layers toggle, both of which are small:

| Menu | Item | Keys | Replaces |
|---|---|---|---|
| File | Open… | Ctrl+O | tab bar's Open file… (kept there too) |
| File | Close | none, see below | a tab's × |
| File | Save a Copy… | Alt+Ctrl+S | Download .zibel.json |
| File | Export > Export As SVG | none (Illustrator gives Export As none) | Download SVG |
| File | Place… | Shift+Ctrl+P | new: a file picker for the drop and paste Place (ADR-0017) |
| Edit | Undo, Redo | Ctrl+Z, Shift+Ctrl+Z | `keydown` switch |
| Edit | Clear | Delete | `keydown` switch |
| Select | All, Deselect, Inverse | Ctrl+A, Shift+Ctrl+A, none | buttons |
| View | Zoom In, Zoom Out | Ctrl+=, Ctrl+- | new |
| View | Fit Artboard in Window, Actual Size | Ctrl+0, Ctrl+1 | `keydown` switch |
| Window | Layers ✓ | F7 | new: hides and shows the Layers panel |

Cut, Copy, Paste and Paste in Place join Edit with #70. Object appears with Make and Release Clipping Mask (#52). Help appears with its first item.

Undo and Redo stay enabled: the browser does not know the server's stacks (ADR-0011), and an empty stack comes back as a rejection notice, as it does today.

**Browser-reserved shortcuts.** A page cannot intercept Ctrl+N, Ctrl+T, Ctrl+W, their Shift variants, or Ctrl+Tab; Chrome handles them before the page sees them. An item whose Illustrator shortcut is reserved shows no shortcut rather than one that does not work, so Close has none. Ctrl+O, Ctrl+S, Ctrl+P, Ctrl+=, Ctrl+- and Ctrl+0 can be intercepted and are taken. Ctrl+S is swallowed without doing anything, because every edit is already saved and the browser's Save Page would save the app's HTML. An installed PWA with Keyboard Lock may later get the reserved keys; the table does not change for that.

**Behaviour follows the WAI-ARIA menubar pattern.** A click opens a menu, and while one is open, hovering another title switches to it. Escape, a click outside, or running an item closes it. F10 focuses the menu bar. The arrow keys move between and within menus, Enter runs the item, and typing a letter jumps to the next item that starts with it. There is one level of submenu (Export >). A menu is a native `popover="auto"`, which gives the top layer and light dismiss without a library. While a menu is open, the canvas's key handler ignores keys. On the Document list, the bar shows only File > Open….

## Considered Options

- **A menu library (Radix Menubar and similar).** It adds a dependency for roughly 150 lines, and the Popover API already covers the hard part.
- **Keep and grow the button row.** It does not scale past about ten commands, hides the shortcuts, and matches nothing Illustrator users know.
- **Every Illustrator menu with its unimplemented items greyed out.** It shows the roadmap, but users would read the greyed entries as broken, and every entry would need a stub.
- **A single command palette (Ctrl+K) instead of menus.** A good second way into the same table later, but Illustrator users look for the menu bar first.

## Consequences

- `Viewer.tsx`'s `keydown` switch loses every case that becomes a Menu Item. The button row goes. The e2e tests that click "Download SVG", "Select All" and the others switch to the menu items.
- CONTEXT.md needs no new term: "Menu Item" is plain English, and a Menu Item that edits the Document sends a Command (ADR-0010).
- New requirement F-VIEW-10. Implemented in #72; not started yet.
