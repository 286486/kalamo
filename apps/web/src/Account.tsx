import { useEffect, useState } from "react";

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

/** The GitHub login, avatar and Sign out, at the menu bar's right end; nothing in dev mode. */
export function Account({ me }: { me: Me }) {
  if (me.mode !== "github") return null;
  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 8,
        height: 26,
        display: "flex",
        alignItems: "center",
        gap: 6,
        font: "13px system-ui, sans-serif",
      }}
    >
      {me.avatarUrl && (
        <img src={me.avatarUrl} alt="" width={18} height={18} style={{ borderRadius: 9 }} />
      )}
      <span>{me.login}</span>
      <form method="post" action="/auth/signout">
        <button type="submit">Sign out</button>
      </form>
    </div>
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
