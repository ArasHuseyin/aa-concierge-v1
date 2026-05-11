import type { WebhookHandler } from "~/lib/appapprove-config";
import type { Env } from "../../load-context";
import { upsertResource, recordDeadLetter } from "~/lib/sync.server";

interface ShopifyCustomerPayload {
  admin_graphql_api_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  tags: string;
  updated_at: string;
}

const handler: WebhookHandler = async ({ shop, payload, context }) => {
  const env = (context.cloudflare?.env ?? {}) as Env;
  if (!env.D1) return new Response("OK (no D1)", { status: 200 });
  const p = payload as ShopifyCustomerPayload;
  if (!p.admin_graphql_api_id) return new Response("Bad payload", { status: 400 });
  try {
    await upsertResource(env.D1, {
      shop,
      resource: "customers",
      remoteId: p.admin_graphql_api_id,
      remoteUpdatedAt: p.updated_at,
      row: {
        remoteId: p.admin_graphql_api_id,
        shop,
        email: p.email,
        firstName: p.first_name,
        lastName: p.last_name,
        tags: p.tags,
        payload: p as unknown as Record<string, unknown>,
        remoteUpdatedAt: p.updated_at,
      },
    });
  } catch (err) {
    await recordDeadLetter(env.D1, {
      shop,
      resource: "customers",
      remoteId: p.admin_graphql_api_id,
      payload: p as unknown as Record<string, unknown>,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  return new Response("OK", { status: 200 });
};

export default handler;
