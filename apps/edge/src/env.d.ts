type Env = Cloudflare.Env;

declare namespace Cloudflare {
  interface Env {
    DOCUMENT: DurableObjectNamespace<import("./document-object.ts").DocumentObject>;
    DB: D1Database;
    IMAGES: R2Bucket;
    DEV_TOKENS: string;
    /** Set by vitest.config.ts only. */
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
  interface GlobalProps {
    mainModule: typeof import("./index.ts");
    durableNamespaces: "DocumentObject";
  }
}
