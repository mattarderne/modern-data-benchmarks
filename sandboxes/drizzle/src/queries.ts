/**
 * Analytics queries using Drizzle ORM
 *
 * Add your query functions here. Each function should:
 * - Use the Drizzle query builder (db.select(), etc.)
 * - Return a Promise<number>
 */

import { db } from './db.ts';
import { invoices, subscriptions, customers, prices, products } from './schema.ts';
import { eq, sum, count, countDistinct, and, avg } from 'drizzle-orm';

// Example: Calculate total revenue from paid invoices
export async function calculateTotalRevenue(): Promise<number> {
  const result = await db
    .select({ total: sum(invoices.amount_paid) })
    .from(invoices)
    .where(eq(invoices.status, 'paid'));

  return Number(result[0]?.total ?? 0);
}

// Add your analytics functions below:
