import type { DocSummary } from "@kalamo/sync";
import { useCallback, useEffect, useState } from "react";
import { MenuBar } from "./MenuBar.tsx";
import { listMenus } from "./menu.ts";
import { OPENABLE, type Opened, openFile } from "./tabs.ts";

/**
 * The Documents the User owns or was shared, newest first, with Delete on owned ones, and Open file
 * for an .svg or .kalamo.json.
 */
export function List() {
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  // Visiting /docs/<id> adds its tab (Tabs.tsx).
  const open = (file: File) => {
    setOpenError(null);
    openFile(file).then(
      (body) =>
        body.warnings.length === 0 ? location.assign(`/docs/${body.docId}`) : setOpened(body),
      (err: Error) => setOpenError(err.message),
    );
  };
  const load = useCallback(() => {
    fetch("/api/docs")
      .then((r) => r.json() as Promise<{ documents: DocSummary[] }>)
      .then((r) => setDocs(r.documents))
      .catch((e: unknown) => setError(String(e)));
  }, []);
  useEffect(load, [load]);
  const remove = async (d: DocSummary) => {
    if (!confirm(`Delete "${d.name}" for everyone it is shared with? This cannot be undone.`))
      return;
    const res = await fetch(`/api/docs/${encodeURIComponent(d.docId)}`, { method: "DELETE" });
    if (!res.ok) setError(`Could not delete ${d.name}: ${res.status}`);
    load();
  };
  return (
    <>
      <MenuBar menus={listMenus(open)} />
      <main style={{ padding: 24 }}>
        <h1>Documents</h1>
        <label>
          Open file{" "}
          <input
            type="file"
            accept={OPENABLE}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) open(file);
            }}
          />
        </label>
        {openError && <p role="alert">Could not open the file: {openError}</p>}
        {opened && (
          <div role="status">
            <p>Opened, with what did not come across:</p>
            <ul>
              {opened.warnings.map((w) => (
                <li key={w.code + w.message}>{w.message}</li>
              ))}
            </ul>
            <a href={`/docs/${opened.docId}`}>Open the Document</a>
          </div>
        )}
        {error ? (
          <p>Could not load Documents: {error}</p>
        ) : docs === null ? (
          <p>Loading…</p>
        ) : docs.length === 0 ? (
          <p>No Documents yet. Ask an Agent to call kalamo_doc_create.</p>
        ) : (
          <ul>
            {docs.map((d) => (
              <li key={d.docId}>
                <a href={`/docs/${d.docId}`}>{d.name}</a>{" "}
                <small>
                  {new Date(d.createdAt).toLocaleString()}
                  {d.role !== "owner" && ` · shared with you as ${d.role}`}
                </small>{" "}
                {d.role === "owner" && (
                  <button type="button" onClick={() => remove(d)}>
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
