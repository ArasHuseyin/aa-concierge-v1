import type { WebhookHandler } from "~/lib/appapprove-config";
import type { Env } from "../../load-context";
import { eq, and } from "drizzle-orm";
import { getDb, schema } from "~/lib/db/client.server";

interface CustomerDeletePayload {
  id: number;
}

// Note: Shopify's customers/delete is independent of GDPR redaction.
// For redaction (customers/redact), see the dedicated GDPR handler — it
// keeps the row but clears PII. This handler is for hard deletes (e.g.
// merchant manually purges a customer).
const handler: WebhookHandler = async ({ shop, payload, context }) => {
  const env = (context.cloudflare?.env ?? {}) as Env;
  if (!env.D1) return new Response("OK (no D1)", { status: 200 });
  const p = payload as CustomerDeletePayload;
  if (!p.id) return new Response("Bad payload", { status: 400 });
  const remoteId = "gid://shopify/Customer/" + p.id;
  const db = getDb(env.D1);
  await db
    .delete(schema.customers)
    .where(and(eq(schema.customers.shop, shop), eq(schema.customers.remoteId, remoteId)));
  return new Response("OK", { status: 200 });
};

export default handler;
