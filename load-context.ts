import { type PlatformProxy } from "wrangler";

type Cloudflare = Omit<PlatformProxy<Env>, "dispose">;

declare module "@remix-run/cloudflare" {
  interface AppLoadContext {
    cloudflare: Cloudflare;
  }
}

export interface Env {
  APPAPPROVE_PROJECT_SLUG: string;
  SHOPIFY_API_KEY?: string;
  SHOPIFY_API_SECRET?: string;
  SHOPIFY_APP_URL?: string;
  SCOPES?: string;
  SUPPORT_EMAIL?: string;
  EMERGENCY_CONTACT_EMAIL?: string;
  DPA_CONTACT_NAME?: string;
  DPA_CONTACT_EMAIL?: string;
  DATA_DELETION_INSTRUCTIONS_URL?: string;
  STATUS_INGEST_URL?: string;
  // Cloudflare KV namespace for Shopify session storage. Bind in wrangler.toml:
  //   [[kv_namespaces]]
  //   binding = "SESSIONS"
  //   id = "<your KV namespace id>"
  SESSIONS?: KVNamespace;
  // Cloudflare KV namespace for the GDPR audit log. Bind separately so
  // session secrets and compliance records have isolated retention policies.
  GDPR_AUDIT?: KVNamespace;
  // Phase 3.8 B + D — outbound link to AppApprove for QA feedback +
  // event ingest. Both are pushed by the AppApprove deploy pipeline at
  // provisioning time (mirroring APPAPPROVE_DEPLOY_SECRET from the
  // deploy-callback flow). Without them bound, reportToAppApprove()
  // silently no-ops so forks of the scaffold keep working stand-alone.
  APPAPPROVE_DEPLOY_URL?: string;
  APPAPPROVE_DEPLOY_SECRET?: string;
  // Optional Cloudflare bindings — declared here so AI-generated routes
  // that reference env.D1 / env.R2 / env.QUEUE / env.MY_DO compile cleanly
  // even when the user hasn't yet bound them in wrangler.toml. Bindings
  // that are unbound at runtime are `undefined`; route code that uses
  // them must defensively check first or the user will see a runtime error.
  // To activate: add the matching block to wrangler.toml:
  //   [[d1_databases]] / [[r2_buckets]] / [[queues.producers]] /
  //   [[durable_objects.bindings]]
  D1?: D1Database;
  R2?: R2Bucket;
  QUEUE?: Queue;
  // Phase 3.7 — Cloudflare D1 binding for the managed sync layer.
  D1?: import("@cloudflare/workers-types").D1Database;
  // Bearer token gating /sync/status. Set by the AppApprove deploy
  // pipeline; without it the endpoint returns 503.
  SYNC_STATUS_TOKEN?: string;
  // (Offline session enumeration uses the existing SESSIONS KV
  // declared on the base Env interface — no additional binding needed.)
}
