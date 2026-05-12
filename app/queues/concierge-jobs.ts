// CF Queues consumer for AA Concierge background jobs. Today the only
// job is "charge_subscription" — drives the dunning state-machine when
// a recurring charge attempt fails. Wire from wrangler.toml's
// [[queues.consumers]] block:
//
//   [[queues.consumers]]
//   queue = "aa-concierge-v1-jobs"
//   max_batch_size = 10
//
// The Worker `queue()` export forwards to consume() below. Until the
// scaffold ships a top-level queue wrapper, the cron dispatcher calls
// handleChargeSubscription() inline as a fallback.

import type { Env } from "../../load-context";
import {
  getSubscription,
  recordChargeFailure,
  recordChargeSuccess,
} from "~/lib/concierge/subscriptions.server";
import { sendEmail } from "~/lib/email.server";
import { captureWebhookError } from "~/lib/merchant-qa.server";

export interface ChargeSubscriptionMessage {
  type: "charge_subscription";
  shop: string;
  subscriptionId: string;
}

export type ConciergeJobMessage = ChargeSubscriptionMessage;

interface CfQueueMessage<T> {
  body: T;
  id: string;
  timestamp: Date;
  ack: () => void;
  retry: (opts?: { delaySeconds?: number }) => void;
}

interface CfQueueBatch<T> {
  queue: string;
  messages: CfQueueMessage<T>[];
}

export async function consume(batch: CfQueueBatch<ConciergeJobMessage>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      switch (msg.body.type) {
        case "charge_subscription":
          await handleChargeSubscription(env, msg.body);
          break;
        default: {
          const _exhaustive: never = msg.body.type;
          throw new Error("Unknown job type: " + (_exhaustive as string));
        }
      }
      msg.ack();
    } catch (err) {
      await captureWebhookError(env, "queue " + msg.body.type, err);
      // CF queues will redeliver up to max_retries; back off 60s so a
      // transient Shopify outage doesn't churn the queue.
      msg.retry({ delaySeconds: 60 });
    }
  }
}

// Charge a subscription against Shopify. In V1 we don't call the
// Shopify Subscription API directly (that lives behind merchant approval
// + Shopify-managed flows) — instead we simulate the charge using the
// dunning state-machine + email notifications. Wire to a real charge
// gateway by replacing the body of attemptCharge() below.
export async function handleChargeSubscription(
  env: Env,
  msg: ChargeSubscriptionMessage,
): Promise<void> {
  if (!env.D1) {
    console.warn("[queue] charge_subscription skipped — D1 not bound");
    return;
  }
  const sub = await getSubscription(env.D1, msg.shop, msg.subscriptionId);
  if (!sub) return;
  if (sub.status === "cancelled" || sub.status === "paused" || sub.status === "skipped") return;

  const ok = await attemptCharge(sub);
  if (ok) {
    await recordChargeSuccess(env.D1, msg.shop, msg.subscriptionId);
    return;
  }
  const action = await recordChargeFailure(env.D1, msg.shop, msg.subscriptionId);
  if (sub.customerEmail) {
    if (action === "send_dunning") {
      await sendEmail(env, {
        shop: msg.shop,
        to: sub.customerEmail,
        subject: "We couldn't process your subscription charge",
        text:
          "We had trouble charging your card for your latest subscription order. " +
          "Please update your payment method to keep your subscription active.",
        html:
          '<p>We had trouble charging your card for your latest subscription order.</p>' +
          '<p>Please update your payment method to keep your subscription active.</p>',
      });
    } else {
      await sendEmail(env, {
        shop: msg.shop,
        to: sub.customerEmail,
        subject: "Your subscription has been cancelled",
        text:
          "After multiple unsuccessful charge attempts, we've had to cancel your subscription. " +
          "You can re-subscribe any time from your account page.",
      });
    }
  }
}

// Placeholder for the actual Shopify charge call. Returns true on
// success. Replace with a Shopify Admin API call (e.g.
// subscriptionContractCharge) once V2 wires merchant-managed billing.
async function attemptCharge(_sub: { id: string; shop: string }): Promise<boolean> {
  return true;
}
