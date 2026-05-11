// Typed Drizzle helpers for the synced "customers" table. Generated
// by AppApprove (Phase 3.7 D). Edit freely — adding new helpers here is
// usually the right call before reaching for raw SQL.

import { and, asc, count, desc, eq, like, or } from "drizzle-orm";
import type { D1Database } from "@cloudflare/workers-types";
import { getDb, schema } from "../../db/client.server";

export type CustomersRow = typeof schema.customers.$inferSelect;

export interface ListCustomersOpts {
  shop: string;
  limit?: number;
  offset?: number;
  search?: string;
  // "newest" sorts by remoteUpdatedAt DESC (the common case); "oldest"
  // for backfill verification.
  order?: "newest" | "oldest";
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 250;

export async function listCustomers(
  d1: D1Database,
  opts: ListCustomersOpts,
): Promise<{ rows: CustomersRow[]; total: number }> {
  const db = getDb(d1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, opts.limit ?? DEFAULT_LIMIT));
  const offset = Math.max(0, opts.offset ?? 0);

  const conditions = [eq(schema.customers.shop, opts.shop)];
  if (opts.search && opts.search.length > 0) {
    conditions.push(
      or(
      like(schema.customers.email, "%" + opts.search + "%"),
      like(schema.customers.firstName, "%" + opts.search + "%"),
      like(schema.customers.lastName, "%" + opts.search + "%")
      )!,
    );
  }

  const where = conditions.length === 1 ? conditions[0] : and(...conditions);

  const orderClause = opts.order === "oldest"
    ? asc(schema.customers.remoteUpdatedAt)
    : desc(schema.customers.remoteUpdatedAt);

  const [rows, totalRow] = await Promise.all([
    db
      .select()
      .from(schema.customers)
      .where(where)
      .orderBy(orderClause)
      .limit(limit)
      .offset(offset),
    db.select({ value: count() }).from(schema.customers).where(where),
  ]);

  return { rows: rows as CustomersRow[], total: totalRow[0]?.value ?? 0 };
}

export async function getCustomers(
  d1: D1Database,
  shop: string,
  remoteId: string,
): Promise<CustomersRow | null> {
  const db = getDb(d1);
  const rows = await db
    .select()
    .from(schema.customers)
    .where(and(eq(schema.customers.shop, shop), eq(schema.customers.remoteId, remoteId)))
    .limit(1);
  return (rows[0] ?? null) as CustomersRow | null;
}

export async function countCustomers(d1: D1Database, shop: string): Promise<number> {
  const db = getDb(d1);
  const result = await db
    .select({ value: count() })
    .from(schema.customers)
    .where(eq(schema.customers.shop, shop));
  return result[0]?.value ?? 0;
}
