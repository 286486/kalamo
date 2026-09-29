/** `GET /api/docs/:docId/members` (ADR-0047). */
interface Member {
  login: string;
  role: "editor" | "viewer";
}

const ROLES = ["editor", "viewer"] as const;

/** A role picker set to `role`. */
function roleSelect(role: Member["role"], label: string) {
  const select = Object.assign(document.createElement("select"), { ariaLabel: label });
  for (const r of ROLES) select.add(new Option(r === "editor" ? "Can edit" : "Can view", r));
  select.value = role;
  return select;
}

/**
 * File > Share… (owner only): share the Document with a GitHub login that has signed in to
 * Kalamo, as an editor or a viewer, and change or remove its members.
 */
export function shareDialog(docId: string) {
  const dialog = Object.assign(document.createElement("dialog"), { ariaLabel: "Share" });
  dialog.style.font = "13px system-ui, sans-serif";
  dialog.style.minWidth = "320px";
  dialog.innerHTML = `<h2 style="font-size:15px;margin-top:0">Share</h2>
<form data-add style="display:flex;gap:6px"><input name="login" placeholder="GitHub login" aria-label="GitHub login" required></form>
<p role="alert" style="color:#B00020"></p>
<table><tbody></tbody></table>
<p style="text-align:right;margin-bottom:0"><button data-close>Close</button></p>`;
  const add = dialog.querySelector("form") as HTMLFormElement;
  const alert = dialog.querySelector("[role=alert]") as HTMLElement;
  const rows = dialog.querySelector("tbody") as HTMLElement;
  const addRole = roleSelect("editor", "Role");
  add.append(addRole, Object.assign(document.createElement("button"), { textContent: "Share" }));

  const url = (login = "") =>
    `/api/docs/${encodeURIComponent(docId)}/members${login && `/${encodeURIComponent(login)}`}`;
  /** Sends one change and shows the list again, or the server's message. */
  const change = async (login: string, init: RequestInit) => {
    alert.textContent = "";
    const res = await fetch(url(login), init);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string; hint?: string };
      alert.textContent = body ? `${body.message} ${body.hint}` : `Failed: ${res.status}`;
      return false;
    }
    await load();
    return true;
  };
  const put = (login: string, role: string) =>
    change(login, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    });
  const load = async () => {
    const res = await fetch(url());
    if (!res.ok) {
      alert.textContent = "Could not load the members.";
      return;
    }
    const { members } = (await res.json()) as { members: Member[] };
    rows.replaceChildren(
      ...members.map((m) => {
        const tr = document.createElement("tr");
        const role = roleSelect(m.role, `${m.login}'s role`);
        role.onchange = () => put(m.login, role.value);
        const remove = Object.assign(document.createElement("button"), { textContent: "Remove" });
        remove.onclick = () => change(m.login, { method: "DELETE" });
        for (const cell of [m.login, role, remove]) tr.insertCell().append(cell);
        return tr;
      }),
    );
  };
  add.onsubmit = async (e) => {
    e.preventDefault();
    const login = new FormData(add).get("login") as string;
    if (await put(login.trim(), addRole.value)) add.reset();
  };
  (dialog.querySelector("[data-close]") as HTMLElement).onclick = () => dialog.close();
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
  void load();
}
