// Subscription lifecycle helpers — pause/skip/resume/cancel, dunning
// state-machine tick, "due now" selector for the billing cron. Persists
// through Drizzle on the D1 app-tables.

import { and, eq, lte, inArray } from "drizzle-orm";
import type { D1Database } from "@cloudflare/workers-types";
import { getDb } from "../db/client.server";
import { subscriptions } from "../db/app-tables.schema.server";

export type SubscriptionStatus =
  | "active"
  | "paused"
  | "skipped"
  | "cancelled"
  | "past_due";

export interface SubscriptionRow {
  id: string;
  shop: string;
  customerRemoteId: string;
  customerEmail: string | null;
  productRemoteId: string;
  variantRemoteId: string | null;
  quantity: number;
  intervalDays: number;
  status: SubscriptionStatus;
  nextChargeAt: Date | null;
  pausedUntil: Date | null;
  dunningAttempts: number;
  lastDunningAt: Date | null;
}

const DUNNING_MAX_ATTEMPTS = 4;

export interface CreateSubscriptionInput {
  shop: string;
  customerRemoteId: string;
  customerEmail?: string | null;
  productRemoteId: string;
  variantRemoteId?: string | null;
  quantity?: number;
  intervalDays?: number;
}

function newId(prefix: string): string {
  return prefix + "_" + crypto.randomUUID();
}

export async function createSubscription(
  d1: D1Database,
  input: CreateSubscriptionInput,
): Promise<SubscriptionRow> {
  const db = getDb(d1);
  const id = newId("sub");
  const intervalDays = input.intervalDays ?? 30;
  const nextChargeAt = new Date(Date.now() + intervalDays * 86_400_000);
  await db.insert(subscriptions).values({
    id,
    shop: input.shop,
    customerRemoteId: input.customerRemoteId,
    customerEmail: input.customerEmail ?? null,
    productRemoteId: input.productRemoteId,
    variantRemoteId: input.variantRemoteId ?? null,
    quantity: input.quantity ?? 1,
    intervalDays,
    status: "active",
    nextChargeAt,
  });
  const created = await getSubscription(d1, input.shop, id);
  if (!created) throw new Error("Subscription create failed: " + id);
  return created;
}

export async function getSubscription(
  d1: D1Database,
  shop: string,
  id: string,
): Promise<SubscriptionRow | null> {
  const db = getDb(d1);
  const rows = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.shop, shop), eq(subscriptions.id, id)))
    .limit(1);
  return rows[0] ? (rows[0] as SubscriptionRow) : null;
}

export async function listCustomerSubscriptions(
  d1: D1Database,
  shop: string,
  customerRemoteId: string,
): Promise<SubscriptionRow[]> {
  const db = getDb(d1);
  const rows = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.shop, shop),
        eq(subscriptions.customerRemoteId, customerRemoteId),
      ),
    );
  return rows as SubscriptionRow[];
}

export async function pauseSubscription(
  d1: D1Database,
  shop: string,
  id: string,
  pausedUntil: Date,
): Promise<void> {
  const db = getDb(d1);
  await db
    .update(subscriptions)
    .set({ status: "paused", pausedUntil, updatedAt: new Date() })
    .where(and(eq(subscriptions.shop, shop), eq(subscriptions.id, id)));
}

export async function resumeSubscription(d1: D1Database, shop: string, id: string): Promise<void> {
  const db = getDb(d1);
  const sub = await getSubscription(d1, shop, id);
  if (!sub) return;
  const next = new Date(Date.now() + sub.intervalDays * 86_400_000);
  await db
    .update(subscriptions)
    .set({ status: "active", pausedUntil: null, nextChargeAt: next, updatedAt: new Date() })
    .where(and(eq(subscriptions.shop, shop), eq(subscriptions.id, id)));
}

export async function skipNextCharge(d1: D1Database, shop: string, id: string): Promise<void> {
  const db = getDb(d1);
  const sub = await getSubscription(d1, shop, id);
  if (!sub) return;
  const base = sub.nextChargeAt?.getTime() ?? Date.now();
  const next = new Date(base + sub.intervalDays * 86_400_000);
  await db
    .update(subscriptions)
    .set({ status: "active", nextChargeAt: next, updatedAt: new Date() })
    .where(and(eq(subscriptions.shop, shop), eq(subscriptions.id, id)));
}

export async function cancelSubscription(d1: D1Database, shop: string, id: string): Promise<void> {
  const db = getDb(d1);
  await db
    .update(subscriptions)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(and(eq(subscriptions.shop, shop), eq(subscriptions.id, id)));
}

export async function dueForCharge(
  d1: D1Database,
  now: Date,
  limit: number = 50,
): Promise<SubscriptionRow[]> {
  const db = getDb(d1);
  const rows = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        inArray(subscriptions.status, ["active", "past_due"]),
        lte(subscriptions.nextChargeAt, now),
      ),
    )
    .limit(limit);
  return rows as SubscriptionRow[];
}

// Record a failed charge and advance the dunning state-machine. Returns
// the next action the caller should take: send a dunning email, or
// cancel the subscription after MAX attempts.
export type DunningAction = "send_dunning" | "cancel";

export async function recordChargeFailure(
  d1: D1Database,
  shop: string,
  id: string,
): Promise<DunningAction> {
  const db = getDb(d1);
  const sub = await getSubscription(d1, shop, id);
  if (!sub) return "cancel";
  const attempts = sub.dunningAttempts + 1;
  if (attempts >= DUNNING_MAX_ATTEMPTS) {
    await db
      .update(subscriptions)
      .set({
        status: "cancelled",
        dunningAttempts: attempts,
        lastDunningAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(subscriptions.shop, shop), eq(subscriptions.id, id)));
    return "cancel";
  }
  // Push the next retry out by 2^attempts days (1, 2, 4, …) bounded
  // by the interval so we never end up retrying past the next period.
  const retryDays = Math.min(Math.pow(2, attempts), sub.intervalDays);
  await db
    .update(subscriptions)
    .set({
      status: "past_due",
      dunningAttempts: attempts,
      lastDunningAt: new Date(),
      nextChargeAt: new Date(Date.now() + retryDays * 86_400_000),
      updatedAt: new Date(),
    })
    .where(and(eq(subscriptions.shop, shop), eq(subscriptions.id, id)));
  return "send_dunning";
}

export async function recordChargeSuccess(
  d1: D1Database,
  shop: string,
  id: string,
): Promise<void> {
  const db = getDb(d1);
  const sub = await getSubscription(d1, shop, id);
  if (!sub) return;
  const next = new Date(Date.now() + sub.intervalDays * 86_400_000);
  await db
    .update(subscriptions)
    .set({
      status: "active",
      dunningAttempts: 0,
      lastDunningAt: null,
      nextChargeAt: next,
      updatedAt: new Date(),
    })
    .where(and(eq(subscriptions.shop, shop), eq(subscriptions.id, id)));
}
