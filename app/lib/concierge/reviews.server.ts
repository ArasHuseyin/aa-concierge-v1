// Post-purchase review-request scheduler + submission storage. Requests
// are inserted with status="pending" + scheduledFor=order_paid_at+Ndays;
// a cron picks up overdue rows and dispatches the email via Resend.

import { and, eq, lte } from "drizzle-orm";
import type { D1Database } from "@cloudflare/workers-types";
import { getDb } from "../db/client.server";
import { reviewRequests, reviews } from "../db/app-tables.schema.server";

const DEFAULT_REQUEST_DELAY_DAYS = 7;

export interface ScheduleReviewInput {
  shop: string;
  orderRemoteId: string;
  productRemoteId: string;
  customerEmail: string;
  customerRemoteId?: string | null;
  delayDays?: number;
}

export interface ReviewRequestRow {
  id: string;
  shop: string;
  orderRemoteId: string;
  productRemoteId: string;
  customerEmail: string;
  customerRemoteId: string | null;
  status: "pending" | "sent" | "submitted" | "bounced";
  scheduledFor: Date;
  sentAt: Date | null;
  submittedAt: Date | null;
  token: string;
}

function newId(prefix: string): string {
  return prefix + "_" + crypto.randomUUID();
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function scheduleReviewRequest(
  d1: D1Database,
  input: ScheduleReviewInput,
): Promise<ReviewRequestRow | null> {
  const db = getDb(d1);
  // Idempotency — one request per (shop, order, product).
  const existing = await db
    .select({ id: reviewRequests.id })
    .from(reviewRequests)
    .where(
      and(
        eq(reviewRequests.shop, input.shop),
        eq(reviewRequests.orderRemoteId, input.orderRemoteId),
        eq(reviewRequests.productRemoteId, input.productRemoteId),
      ),
    )
    .limit(1);
  if (existing[0]) return null;
  const id = newId("rvw");
  const delay = input.delayDays ?? DEFAULT_REQUEST_DELAY_DAYS;
  const scheduledFor = new Date(Date.now() + delay * 86_400_000);
  const token = randomToken();
  await db.insert(reviewRequests).values({
    id,
    shop: input.shop,
    orderRemoteId: input.orderRemoteId,
    productRemoteId: input.productRemoteId,
    customerEmail: input.customerEmail,
    customerRemoteId: input.customerRemoteId ?? null,
    status: "pending",
    scheduledFor,
    token,
  });
  return {
    id,
    shop: input.shop,
    orderRemoteId: input.orderRemoteId,
    productRemoteId: input.productRemoteId,
    customerEmail: input.customerEmail,
    customerRemoteId: input.customerRemoteId ?? null,
    status: "pending",
    scheduledFor,
    sentAt: null,
    submittedAt: null,
    token,
  };
}

export async function findDueReviewRequests(
  d1: D1Database,
  now: Date,
  limit: number = 25,
): Promise<ReviewRequestRow[]> {
  const db = getDb(d1);
  const rows = await db
    .select()
    .from(reviewRequests)
    .where(
      and(
        eq(reviewRequests.status, "pending"),
        lte(reviewRequests.scheduledFor, now),
      ),
    )
    .limit(limit);
  return rows as ReviewRequestRow[];
}

export async function markRequestSent(d1: D1Database, id: string): Promise<void> {
  const db = getDb(d1);
  await db
    .update(reviewRequests)
    .set({ status: "sent", sentAt: new Date() })
    .where(eq(reviewRequests.id, id));
}

export async function markRequestBounced(d1: D1Database, id: string): Promise<void> {
  const db = getDb(d1);
  await db
    .update(reviewRequests)
    .set({ status: "bounced" })
    .where(eq(reviewRequests.id, id));
}

export async function findRequestByToken(
  d1: D1Database,
  token: string,
): Promise<ReviewRequestRow | null> {
  const db = getDb(d1);
  const rows = await db
    .select()
    .from(reviewRequests)
    .where(eq(reviewRequests.token, token))
    .limit(1);
  return rows[0] ? (rows[0] as ReviewRequestRow) : null;
}

export interface SubmitReviewInput {
  token: string;
  rating: number;
  title?: string;
  body?: string;
  photoUrls?: string[];
}

export async function submitReview(
  d1: D1Database,
  input: SubmitReviewInput,
): Promise<{ ok: true; reviewId: number } | { ok: false; reason: string }> {
  if (input.rating < 1 || input.rating > 5) {
    return { ok: false, reason: "rating must be 1..5" };
  }
  const req = await findRequestByToken(d1, input.token);
  if (!req) return { ok: false, reason: "invalid token" };
  if (req.submittedAt) return { ok: false, reason: "already submitted" };
  const db = getDb(d1);
  const inserted = await db
    .insert(reviews)
    .values({
      shop: req.shop,
      requestId: req.id,
      productRemoteId: req.productRemoteId,
      customerEmail: req.customerEmail,
      rating: input.rating,
      title: input.title ?? null,
      body: input.body ?? null,
      photoUrls: input.photoUrls ?? [],
      approved: false,
    })
    .returning({ id: reviews.id });
  await db
    .update(reviewRequests)
    .set({ status: "submitted", submittedAt: new Date() })
    .where(eq(reviewRequests.id, req.id));
  const reviewId = inserted[0]?.id;
  if (reviewId == null) return { ok: false, reason: "insert failed" };
  return { ok: true, reviewId };
}
