// Loyalty point ledger — accrual on paid orders, redemption with
// tier-aware multipliers. Tier is derived from lifetime points so the
// account row is always in sync with the ledger.

import { and, eq } from "drizzle-orm";
import type { D1Database } from "@cloudflare/workers-types";
import { getDb } from "../db/client.server";
import { loyaltyAccounts, loyaltyLedger } from "../db/app-tables.schema.server";

export type LoyaltyTier = "bronze" | "silver" | "gold" | "platinum";

export interface LoyaltyTierConfig {
  tier: LoyaltyTier;
  minLifetimePoints: number;
  // Points earned per $1 spent. Higher tier = more points.
  earnMultiplier: number;
  // Points required to redeem $1 off. Lower = better redemption rate.
  redemptionRate: number;
}

export const TIER_CONFIG: LoyaltyTierConfig[] = [
  { tier: "bronze", minLifetimePoints: 0, earnMultiplier: 1, redemptionRate: 100 },
  { tier: "silver", minLifetimePoints: 500, earnMultiplier: 1.25, redemptionRate: 90 },
  { tier: "gold", minLifetimePoints: 2000, earnMultiplier: 1.5, redemptionRate: 80 },
  { tier: "platinum", minLifetimePoints: 10000, earnMultiplier: 2, redemptionRate: 70 },
];

export function deriveTier(lifetimePoints: number): LoyaltyTier {
  let current: LoyaltyTier = "bronze";
  for (const cfg of TIER_CONFIG) {
    if (lifetimePoints >= cfg.minLifetimePoints) current = cfg.tier;
  }
  return current;
}

export function tierConfig(tier: LoyaltyTier): LoyaltyTierConfig {
  return TIER_CONFIG.find((t) => t.tier === tier) ?? TIER_CONFIG[0]!;
}

export interface LoyaltyAccountRow {
  shop: string;
  customerRemoteId: string;
  customerEmail: string | null;
  pointsBalance: number;
  lifetimePoints: number;
  tier: LoyaltyTier;
}

export async function getAccount(
  d1: D1Database,
  shop: string,
  customerRemoteId: string,
): Promise<LoyaltyAccountRow | null> {
  const db = getDb(d1);
  const rows = await db
    .select()
    .from(loyaltyAccounts)
    .where(
      and(
        eq(loyaltyAccounts.shop, shop),
        eq(loyaltyAccounts.customerRemoteId, customerRemoteId),
      ),
    )
    .limit(1);
  return rows[0] ? (rows[0] as LoyaltyAccountRow) : null;
}

async function ensureAccount(
  d1: D1Database,
  shop: string,
  customerRemoteId: string,
  customerEmail: string | null,
): Promise<LoyaltyAccountRow> {
  const existing = await getAccount(d1, shop, customerRemoteId);
  if (existing) return existing;
  const db = getDb(d1);
  await db.insert(loyaltyAccounts).values({
    shop,
    customerRemoteId,
    customerEmail,
    pointsBalance: 0,
    lifetimePoints: 0,
    tier: "bronze",
  });
  return {
    shop,
    customerRemoteId,
    customerEmail,
    pointsBalance: 0,
    lifetimePoints: 0,
    tier: "bronze",
  };
}

export interface AccrualInput {
  shop: string;
  customerRemoteId: string;
  customerEmail?: string | null;
  orderRemoteId: string;
  orderTotalCents: number;
}

export interface AccrualResult {
  pointsEarned: number;
  newBalance: number;
  newTier: LoyaltyTier;
  tierChanged: boolean;
}

// Accrue points for a paid order. Idempotent on (shop, orderRemoteId) —
// repeated webhooks don't double-credit.
export async function accruePointsForOrder(
  d1: D1Database,
  input: AccrualInput,
): Promise<AccrualResult> {
  const db = getDb(d1);
  // Idempotency: skip if the ledger already has an order_earned row for
  // this (shop, customer, order).
  const existing = await db
    .select({ id: loyaltyLedger.id })
    .from(loyaltyLedger)
    .where(
      and(
        eq(loyaltyLedger.shop, input.shop),
        eq(loyaltyLedger.customerRemoteId, input.customerRemoteId),
        eq(loyaltyLedger.orderRemoteId, input.orderRemoteId),
        eq(loyaltyLedger.reason, "order_earned"),
      ),
    )
    .limit(1);
  if (existing[0]) {
    const acc = await ensureAccount(d1, input.shop, input.customerRemoteId, input.customerEmail ?? null);
    return { pointsEarned: 0, newBalance: acc.pointsBalance, newTier: acc.tier, tierChanged: false };
  }
  const acc = await ensureAccount(d1, input.shop, input.customerRemoteId, input.customerEmail ?? null);
  const cfg = tierConfig(acc.tier);
  // 1 point per dollar at bronze; cents → dollars rounded down.
  const earned = Math.max(0, Math.floor((input.orderTotalCents / 100) * cfg.earnMultiplier));
  if (earned === 0) {
    return { pointsEarned: 0, newBalance: acc.pointsBalance, newTier: acc.tier, tierChanged: false };
  }
  const newLifetime = acc.lifetimePoints + earned;
  const newBalance = acc.pointsBalance + earned;
  const newTier = deriveTier(newLifetime);
  const tierChanged = newTier !== acc.tier;
  await db.insert(loyaltyLedger).values({
    shop: input.shop,
    customerRemoteId: input.customerRemoteId,
    delta: earned,
    reason: "order_earned",
    orderRemoteId: input.orderRemoteId,
  });
  await db
    .update(loyaltyAccounts)
    .set({
      pointsBalance: newBalance,
      lifetimePoints: newLifetime,
      tier: newTier,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(loyaltyAccounts.shop, input.shop),
        eq(loyaltyAccounts.customerRemoteId, input.customerRemoteId),
      ),
    );
  return { pointsEarned: earned, newBalance, newTier, tierChanged };
}

export interface RedemptionInput {
  shop: string;
  customerRemoteId: string;
  pointsToSpend: number;
  note?: string;
}

export interface RedemptionResult {
  discountCents: number;
  newBalance: number;
}

export async function redeemPoints(d1: D1Database, input: RedemptionInput): Promise<RedemptionResult> {
  const acc = await getAccount(d1, input.shop, input.customerRemoteId);
  if (!acc) throw new Error("No loyalty account for customer " + input.customerRemoteId);
  if (input.pointsToSpend <= 0) throw new Error("Redemption must be positive");
  if (input.pointsToSpend > acc.pointsBalance) {
    throw new Error("Insufficient points: have " + acc.pointsBalance + ", asked " + input.pointsToSpend);
  }
  const cfg = tierConfig(acc.tier);
  const discountCents = Math.floor((input.pointsToSpend / cfg.redemptionRate) * 100);
  const db = getDb(d1);
  await db.insert(loyaltyLedger).values({
    shop: input.shop,
    customerRemoteId: input.customerRemoteId,
    delta: -input.pointsToSpend,
    reason: "redemption",
    note: input.note ?? null,
  });
  const newBalance = acc.pointsBalance - input.pointsToSpend;
  await db
    .update(loyaltyAccounts)
    .set({ pointsBalance: newBalance, updatedAt: new Date() })
    .where(
      and(
        eq(loyaltyAccounts.shop, input.shop),
        eq(loyaltyAccounts.customerRemoteId, input.customerRemoteId),
      ),
    );
  return { discountCents, newBalance };
}
