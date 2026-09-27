type Env = Cloudflare.Env;

declare namespace Cloudflare {
  interface Env {
    DOCUMENT: DurableObjectNamespace<import("./document-object.ts").DocumentObject>;
    DB: D1Database;
    IMAGES: R2Bucket;
    /** `dev` or `github` (ADR-0047); anything else is `github`. */
    AUTH_MODE: string;
    /** `token=actor` pairs: dev mode's MCP tokens. GitHub mode ignores them. */
    DEV_TOKENS?: string;
    /** GitHub mode: the browser app's origin, also the OAuth issuer, without a trailing slash. */
    APP_ORIGIN: string;
    /** GitHub mode: the origin of `/mcp`, the OAuth resource; APP_ORIGIN when unset. */
    MCP_ORIGIN?: string;
    /** GitHub mode: MCP OAuth grants and tokens (workers-oauth-provider). */
    OAUTH_KV: KVNamespace;
    /** Set by workers-oauth-provider for the handlers it wraps. */
    OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
    /** Set by vitest.config.ts only. */
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
  interface GlobalProps {
    mainModule: typeof import("./index.ts");
    durableNamespaces: "DocumentObject";
  }
}
