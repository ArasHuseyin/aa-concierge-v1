// Bundle CRUD — admin defines bundles in the dashboard; storefront +
// checkout flows look up bundles by handle to apply the bundle-only price.

import { and, eq } from "drizzle-orm";
import type { D1Database } from "@cloudflare/workers-types";
import { getDb } from "../db/client.server";
import { bundles } from "../db/app-tables.schema.server";

export interface BundleItem {
  productRemoteId: string;
  variantRemoteId: string;
  quantity: number;
}

export interface BundleRow {
  id: string;
  shop: string;
  title: string;
  handle: string;
  priceCents: number;
  currencyCode: string;
  items: BundleItem[];
  active: boolean;
}

export interface UpsertBundleInput {
  id?: string;
  shop: string;
  title: string;
  handle: string;
  priceCents: number;
  currencyCode?: string;
  items: BundleItem[];
  active?: boolean;
}

function newId(): string {
  return "bdl_" + crypto.randomUUID();
}

export async function upsertBundle(d1: D1Database, input: UpsertBundleInput): Promise<BundleRow> {
  const db = getDb(d1);
  if (input.items.length < 2) {
    throw new Error("Bundles require at least 2 items");
  }
  const id = input.id ?? newId();
  const values = {
    id,
    shop: input.shop,
    title: input.title,
    handle: input.handle,
    priceCents: input.priceCents,
    currencyCode: input.currencyCode ?? "USD",
    items: input.items,
    active: input.active ?? true,
    updatedAt: new Date(),
  };
  await db
    .insert(bundles)
    .values(values)
    .onConflictDoUpdate({ target: bundles.id, set: values });
  return {
    id,
    shop: values.shop,
    title: values.title,
    handle: values.handle,
    priceCents: values.priceCents,
    currencyCode: values.currencyCode,
    items: values.items,
    active: values.active,
  };
}

export async function listBundles(d1: D1Database, shop: string): Promise<BundleRow[]> {
  const db = getDb(d1);
  const rows = await db.select().from(bundles).where(eq(bundles.shop, shop));
  return rows as BundleRow[];
}

export async function getBundle(d1: D1Database, shop: string, id: string): Promise<BundleRow | null> {
  const db = getDb(d1);
  const rows = await db
    .select()
    .from(bundles)
    .where(and(eq(bundles.shop, shop), eq(bundles.id, id)))
    .limit(1);
  return rows[0] ? (rows[0] as BundleRow) : null;
}

export async function getBundleByHandle(
  d1: D1Database,
  shop: string,
  handle: string,
): Promise<BundleRow | null> {
  const db = getDb(d1);
  const rows = await db
    .select()
    .from(bundles)
    .where(and(eq(bundles.shop, shop), eq(bundles.handle, handle)))
    .limit(1);
  return rows[0] ? (rows[0] as BundleRow) : null;
}

export async function deleteBundle(d1: D1Database, shop: string, id: string): Promise<void> {
  const db = getDb(d1);
  await db.delete(bundles).where(and(eq(bundles.shop, shop), eq(bundles.id, id)));
}
