// AA Concierge V1 — periodic dispatcher. Two jobs per tick:
//   1. Pick up review-request rows whose scheduledFor <= now and email
//      the customer the review-submission link. Marks rows as "sent".
//   2. Pick up subscriptions whose nextChargeAt <= now and enqueue a
//      billing job for each (or process inline when CONCIERGE_QUEUE is
//      not bound). Dunning state-machine lives in the queue consumer.
//
// Per-tick budget is bounded by the CF Workers scheduled-event time
// limit; LIMIT clauses cap work-per-tick so leftover rows roll into the
// next firing.

import type { CronHandler } from "~/lib/appapprove-config";
import type { Env } from "../../load-context";
import { findDueReviewRequests, markRequestSent } from "~/lib/concierge/reviews.server";
import { dueForCharge } from "~/lib/concierge/subscriptions.server";
import { sendEmail } from "~/lib/email.server";
import { captureSetupStep } from "~/lib/merchant-qa.server";

interface JobMessage {
  type: "charge_subscription";
  shop: string;
  subscriptionId: string;
}

const REVIEW_BATCH_PER_TICK = 25;
const SUBSCRIPTION_BATCH_PER_TICK = 50;

const handler: CronHandler = async ({ context, scheduledAt }) => {
  const env = (context.cloudflare?.env ?? {}) as Env;
  if (!env.D1) {
    console.warn("[concierge-dispatch] D1 not bound — skipping");
    return;
  }
  const now = new Date(scheduledAt);

  // ─── Review-request dispatch ───────────────────────────────────────
  const due = await findDueReviewRequests(env.D1, now, REVIEW_BATCH_PER_TICK);
  let sent = 0;
  for (const row of due) {
    try {
      const submitUrl = buildSubmitUrl(env, row.token);
      const res = await sendEmail(env, {
        shop: row.shop,
        to: row.customerEmail,
        subject: "How was your recent order?",
        text:
          "Thanks for your recent purchase! Tell us what you think — submit your review here:\n" +
          submitUrl,
        html:
          '<p>Thanks for your recent purchase!</p><p>Tell us what you think — ' +
          '<a href="' + submitUrl + '">submit your review</a>.</p>',
      });
      if (res.delivered || res.skippedReason === "no_api_key") {
        await markRequestSent(env.D1, row.id);
        if (res.delivered) sent++;
      }
    } catch (err) {
      console.error("[concierge-dispatch] review send failed for " + row.id, err);
    }
  }
  if (sent > 0) {
    await captureSetupStep(env, "review_requests_sent", { count: String(sent) });
  }

  // ─── Subscription billing dispatch ─────────────────────────────────
  const dueSubs = await dueForCharge(env.D1, now, SUBSCRIPTION_BATCH_PER_TICK);
  for (const sub of dueSubs) {
    const message: JobMessage = {
      type: "charge_subscription",
      shop: sub.shop,
      subscriptionId: sub.id,
    };
    if (env.CONCIERGE_QUEUE) {
      await env.CONCIERGE_QUEUE.send(message);
    } else {
      // Inline fallback — runs the queue consumer's effect synchronously
      // so the scaffold works before the CF queue is provisioned.
      const { handleChargeSubscription } = await import("../queues/concierge-jobs");
      await handleChargeSubscription(env, message);
    }
  }
  console.log(
    "[concierge-dispatch] tick complete — review_sent=" + sent + " sub_jobs=" + dueSubs.length,
  );
};

function buildSubmitUrl(env: Env, token: string): string {
  const base = (env.SHOPIFY_APP_URL ?? "").replace(/\/+$/, "");
  return base + "/customer/review?token=" + encodeURIComponent(token);
}

export default handler;
