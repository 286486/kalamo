type Env = Cloudflare.Env;

declare namespace Cloudflare {
  interface Env {
    DOCUMENT: DurableObjectNamespace<import("./document-object.ts").DocumentObject>;
    DB: D1Database;
    IMAGES: R2Bucket;
    /** `dev` or `github` (ADR-0047); anything else is `github`. */
    AUTH_MODE: string;
    /** `token=actor` pairs; dev mode's browser-free MCP, and GitHub mode's until MCP OAuth. */
    DEV_TOKENS?: string;
    /** GitHub mode: the browser app's origin, without a trailing slash. */
    APP_ORIGIN: string;
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
