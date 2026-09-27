/** Resolves the Agent Actor for a request from `Authorization: Bearer <dev token>`, or null. */
export function actorFor(request: Request, devTokens: string): string | null {
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (!token) return null;
  for (const pair of devTokens.split(",")) {
    const [t, actor] = pair.split("=");
    if (t?.trim() === token && actor) return actor.trim();
  }
  return null;
}

export const permissionDenied = () =>
  Response.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32001,
        message: "PERMISSION_DENIED",
        data: {
          code: "PERMISSION_DENIED",
          hint: "Send Authorization: Bearer <dev token> with a token from DEV_TOKENS.",
        },
      },
    },
    { status: 401, headers: { "www-authenticate": "Bearer" } },
  );
