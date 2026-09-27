import { useCallback, useEffect, useState } from "react";

/** `GET /api/me` (ADR-0047). */
export interface Me {
  userId: string;
  login: string;
  avatarUrl: string | null;
  mode: "dev" | "github";
}

/**
 * The signed-in User; "signed-out" when GitHub mode has no session; "unknown" when `/api/me` fails,
 * which leaves each page to show its own error; null while loading.
 */
export function useMe() {
  const [me, setMe] = useState<Me | "signed-out" | "unknown" | null>(null);
  useEffect(() => {
    const load = async () => {
      const r = await fetch("/api/me");
      return r.status === 401 ? "signed-out" : r.ok ? ((await r.json()) as Me) : "unknown";
    };
    load().then(setMe, () => setMe("unknown"));
  }, []);
  return me;
}

/**
 * The GitHub login and avatar at the menu bar's right end, opening the account menu: Connected
 * Agents and Sign out. Nothing in dev mode.
 */
export function Account({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState(false);
  if (me.mode !== "github") return null;
  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 8,
        font: "13px system-ui, sans-serif",
        zIndex: 10,
      }}
    >
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        style={{ height: 26, display: "flex", alignItems: "center", gap: 6 }}
      >
        {me.avatarUrl && (
          <img src={me.avatarUrl} alt="" width={18} height={18} style={{ borderRadius: 9 }} />
        )}
        {me.login}
      </button>
      {open && (
        <div
          role="menu"
          style={{ position: "absolute", right: 0, background: "white", border: "1px solid #ccc" }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setAgents(true);
            }}
          >
            Connected Agents…
          </button>
          <form method="post" action="/auth/signout">
            <button type="submit" role="menuitem">
              Sign out
            </button>
          </form>
        </div>
      )}
      {agents && <ConnectedAgents onClose={() => setAgents(false)} />}
    </div>
  );
}

/** `GET /api/agents` (ADR-0047). */
interface Agent {
  actorId: string;
  name: string;
  access: "write" | "read";
  createdAt: string;
}

/** The MCP clients the User approved, each revocable. */
function ConnectedAgents({ onClose }: { onClose: () => void }) {
  const [agents, setAgents] = useState<Agent[] | "error" | null>(null);
  const load = useCallback(() => {
    fetch("/api/agents")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((body: { agents: Agent[] }) => setAgents(body.agents))
      .catch(() => setAgents("error"));
  }, []);
  useEffect(load, [load]);
  const revoke = async (agent: Agent) => {
    if (!confirm(`Revoke ${agent.name}? It stops working now and must connect again.`)) return;
    await fetch(`/api/agents/${encodeURIComponent(agent.actorId)}`, { method: "DELETE" });
    load();
  };
  return (
    <dialog
      open
      aria-label="Connected Agents"
      style={{ position: "fixed", top: 40, right: 8, left: "auto", minWidth: 320 }}
    >
      <h2 style={{ fontSize: 15, marginTop: 0 }}>Connected Agents</h2>
      {agents === null && <p>Loading…</p>}
      {agents === "error" && <p>Could not load your Agents.</p>}
      {Array.isArray(agents) && agents.length === 0 && <p>No MCP client is connected.</p>}
      {Array.isArray(agents) && agents.length > 0 && (
        <table>
          <tbody>
            {agents.map((a) => (
              <tr key={a.actorId}>
                <td>{a.name}</td>
                <td>{a.access === "write" ? "Read and edit" : "Read only"}</td>
                <td>{new Date(a.createdAt).toLocaleDateString()}</td>
                <td>
                  <button type="button" onClick={() => revoke(a)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </p>
    </dialog>
  );
}

/** The Document list's place for a signed-out person; sign-in comes back to `?return=`. */
export function SignIn() {
  const back = new URLSearchParams(location.search).get("return") ?? "/";
  return (
    <main style={{ padding: 24 }}>
      <h1>Documents</h1>
      <p>
        <a href={`/auth/github?return=${encodeURIComponent(back)}`}>Sign in with GitHub</a>
      </p>
    </main>
  );
}
