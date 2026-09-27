import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { List } from "./List.tsx";
import { MenuBar } from "./MenuBar.tsx";
import { documentMenus } from "./menu.ts";
import { Tabs, useTabs } from "./Tabs.tsx";
import { Viewer } from "./Viewer.tsx";

/** The menu bar, the Document Tabs, then the active tab's canvas (ADR-0031). */
function DocumentPage({ docId }: { docId: string }) {
  const tabs = useTabs(docId);
  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column" }}>
      <MenuBar menus={documentMenus({ open: tabs.open, close: () => tabs.close(docId) })} />
      <Tabs state={tabs} />
      <div style={{ flex: 1, position: "relative" }}>
        <Viewer key={docId} docId={docId} />
      </div>
    </div>
  );
}

/** The Document list at `/`; the active Document Tab at `/docs/<id>`, switched in place by `go`. */
function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const follow = () => setPath(location.pathname);
    addEventListener("popstate", follow);
    return () => removeEventListener("popstate", follow);
  }, []);
  const docId = path.match(/^\/docs\/([^/]+)$/)?.[1];
  return docId ? <DocumentPage docId={docId} /> : <List />;
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
