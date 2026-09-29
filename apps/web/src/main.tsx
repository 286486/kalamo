import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Account, SignIn, useMe } from "./Account.tsx";
import { List } from "./List.tsx";
import { MenuBar } from "./MenuBar.tsx";
import { documentMenus } from "./menu.ts";
import { receiveCarried } from "./storage.ts";
import { goSignIn } from "./store.ts";
import { Tabs, useTabs } from "./Tabs.tsx";
import { Viewer } from "./Viewer.tsx";

/**
 * The menu bar, the Document Tabs, then the active tab's canvas (ADR-0031). `hosted` offers
 * File > Share…: dev mode has no one to share with.
 */
function DocumentPage({ docId, hosted }: { docId: string; hosted: boolean }) {
  const tabs = useTabs(docId);
  const menus = documentMenus({
    open: tabs.open,
    close: () => tabs.close(docId),
    ...(hosted && { share: docId }),
  });
  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column" }}>
      <MenuBar menus={menus} />
      <Tabs state={tabs} />
      <div style={{ flex: 1, position: "relative" }}>
        <Viewer key={docId} docId={docId} />
      </div>
    </div>
  );
}

/**
 * The Document list at `/`; the active Document Tab at `/docs/<id>`, switched in place by `go`.
 * Signed out in GitHub mode, the list offers sign-in and every other page goes there and back.
 */
function App() {
  const me = useMe();
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const follow = () => setPath(location.pathname);
    addEventListener("popstate", follow);
    return () => removeEventListener("popstate", follow);
  }, []);
  const away = me === "signed-out" && path !== "/";
  useEffect(() => {
    if (away) goSignIn();
  }, [away]);
  if (me === null || away) return null;
  if (me === "signed-out") return <SignIn />;
  const docId = path.match(/^\/docs\/([^/]+)$/)?.[1];
  return (
    <>
      {docId ? (
        <DocumentPage docId={docId} hosted={me !== "unknown" && me.mode === "github"} />
      ) : (
        <List />
      )}
      {me !== "unknown" && <Account me={me} />}
    </>
  );
}

receiveCarried();
createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
