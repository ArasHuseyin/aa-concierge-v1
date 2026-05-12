// orders/paid — accrues loyalty points + schedules a post-purchase review
// request for every line-item product. The orders/upsert handler syncs the
// row; this handler runs the feature side-effects.

import type { WebhookHandler } from "~/lib/appapprove-config";
import type { Env } from "../../load-context";
import { accruePointsForOrder } from "~/lib/concierge/loyalty.server";
import { scheduleReviewRequest } from "~/lib/concierge/reviews.server";
import { getAppSettings } from "~/lib/db/app-tables.server";
import { captureWebhookError } from "~/lib/merchant-qa.server";

interface ShopifyLineItem {
  product_id?: number | string;
  admin_graphql_api_id?: string;
}

interface ShopifyCustomer {
  id?: number | string;
  admin_graphql_api_id?: string;
  email?: string;
}

interface ShopifyOrderPayload {
  admin_graphql_api_id: string;
  email: string | null;
  total_price: string | null;
  customer?: ShopifyCustomer | null;
  line_items?: ShopifyLineItem[];
  financial_status?: string | null;
}

interface ConciergeSettings extends Record<string, unknown> {
  loyaltyEnabled?: boolean;
  reviewsEnabled?: boolean;
  reviewRequestDelayDays?: number;
}

function totalToCents(total: string | null | undefined): number {
  if (!total) return 0;
  const n = Number(total);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

const handler: WebhookHandler = async ({ shop, payload, context, topic }) => {
  const env = (context.cloudflare?.env ?? {}) as Env;
  if (!env.D1) return new Response("OK (no D1)", { status: 200 });
  const p = payload as ShopifyOrderPayload;
  if (!p.admin_graphql_api_id) return new Response("Bad payload", { status: 400 });

  try {
    const settings = await getAppSettings<ConciergeSettings>(env.D1, shop);
    const customerRemoteId =
      p.customer?.admin_graphql_api_id ?? (p.customer?.id ? "gid://shopify/Customer/" + p.customer.id : null);
    const customerEmail = p.customer?.email ?? p.email ?? null;

    // Loyalty accrual — only if the customer is identifiable + feature on.
    if ((settings.loyaltyEnabled ?? true) && customerRemoteId) {
      await accruePointsForOrder(env.D1, {
        shop,
        customerRemoteId,
        customerEmail,
        orderRemoteId: p.admin_graphql_api_id,
        orderTotalCents: totalToCents(p.total_price),
      });
    }

    // Review-request scheduling — one per (order, product). Requires an
    // email address; skip when the customer placed the order as a guest
    // without consenting to marketing.
    if ((settings.reviewsEnabled ?? true) && customerEmail) {
      const delay = settings.reviewRequestDelayDays ?? 7;
      const seen = new Set<string>();
      for (const line of p.line_items ?? []) {
        const productGid =
          line.admin_graphql_api_id ?? (line.product_id ? "gid://shopify/Product/" + line.product_id : null);
        if (!productGid || seen.has(productGid)) continue;
        seen.add(productGid);
        await scheduleReviewRequest(env.D1, {
          shop,
          orderRemoteId: p.admin_graphql_api_id,
          productRemoteId: productGid,
          customerEmail,
          customerRemoteId,
          delayDays: delay,
        });
      }
    }
  } catch (err) {
    await captureWebhookError(env, topic, err);
    throw err;
  }
  return new Response("OK", { status: 200 });
};

export default handler;
