import { useEffect, useState } from "react";
import { pickFile } from "./menu.ts";
import { useStore } from "./store.ts";
import { closeTab, go, loadTabs, OPENABLE, openable, openFile, saveTabs, withTab } from "./tabs.ts";

/** The Document Tabs' state, which the tab bar and the menu bar's File > Open… and Close share. */
export function useTabs(docId: string) {
  const [tabs, setTabs] = useState(() => withTab(loadTabs(), docId));
  const [names, setNames] = useState<Map<string, string> | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => setTabs((t) => withTab(t, docId)), [docId]);
  useEffect(() => saveTabs(tabs), [tabs]);

  // Names come from the Document list, which is also how a tab whose Document is gone drops.
  // The shown one stays: it is the URL, and its Viewer is up.
  // ponytail: the whole list per tab shown; fetch only the tabs' names once the list is long.
  useEffect(() => {
    let stale = false;
    fetch("/api/docs")
      .then((r) => r.json() as Promise<{ documents: { docId: string; name: string }[] }>)
      .then(({ documents }) => {
        if (stale) return;
        const found = new Map(documents.map((d) => [d.docId, d.name]));
        setNames(found);
        setTabs((t) => t.filter((id) => id === docId || found.has(id)));
      })
      .catch((e: unknown) => console.warn("Could not load the Document list for the tabs.", e));
    return () => {
      stale = true;
    };
  }, [docId]);

  const open = (file: File) => {
    setMessage(null);
    openFile(file).then(
      ({ docId, warnings }) => {
        if (warnings.length > 0)
          setMessage(
            `Opened ${file.name}, with what did not come across: ${warnings.map((w) => w.message).join(" ")}`,
          );
        go(docId);
      },
      (e: Error) => setMessage(`Could not open ${file.name}: ${e.message}`),
    );
  };

  /** Closing only closes the view; the Document stays in the list. */
  const close = (id: string) => {
    const { tabs: rest, next } = closeTab(tabs, id, docId);
    setTabs(rest);
    if (!next) location.assign("/");
    else if (next !== docId) go(next, true);
  };

  return { docId, tabs, names, message, setMessage, open, close };
}

/**
 * Document Tabs, as Illustrator's (F-VIEW-09): the Document list, one tab per open Document, and Open
 * file, which also takes an .svg or .kalamo.json dropped on the bar. `docId` is the active tab.
 */
export function Tabs({
  state: { docId, tabs, names, message, setMessage, open, close },
}: {
  state: ReturnType<typeof useTabs>;
}) {
  // The store holds the last tab's Document until this one's arrives.
  const activeName = useStore((s) => (s.doc?.id === docId ? s.doc.name : undefined));

  const tabStyle = (active: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    background: active ? "#FFFFFF" : "transparent",
    borderRight: "1px solid #CCC",
  });
  const plain: React.CSSProperties = {
    border: 0,
    background: "none",
    font: "inherit",
    padding: "0 8px",
  };

  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        alignItems: "stretch",
        height: 32,
        background: "#D6D6D6",
        borderBottom: "1px solid #BBB",
        font: "13px system-ui, sans-serif",
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = [...e.dataTransfer.files].find(openable);
        if (file) open(file);
      }}
    >
      <a href="/" style={{ alignSelf: "center", padding: "0 12px" }}>
        Documents
      </a>
      {tabs.map((id) => {
        const active = id === docId;
        const name = (active && activeName) || names?.get(id) || id;
        return (
          <div key={id} style={tabStyle(active)}>
            <button
              type="button"
              role="tab"
              aria-selected={active}
              style={plain}
              onClick={() => {
                setMessage(null);
                if (!active) go(id);
              }}
            >
              {name}
            </button>
            <button
              type="button"
              aria-label={`Close ${name}`}
              style={plain}
              onClick={() => close(id)}
            >
              ×
            </button>
          </div>
        );
      })}
      <button type="button" style={plain} onClick={() => pickFile(OPENABLE, open)}>
        Open file…
      </button>
      {message && (
        <span role="status" style={{ alignSelf: "center", color: "#B00020" }}>
          {message}
        </span>
      )}
    </div>
  );
}
