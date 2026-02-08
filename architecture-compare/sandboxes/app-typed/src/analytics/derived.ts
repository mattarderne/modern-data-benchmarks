import type { ApiUsage, User } from '../types/internal';
import type { StripeInvoice } from '../types/stripe';

export function getActiveUserIds(apiUsage: ApiUsage[], sinceIso: string): Set<string> {
  const since = new Date(sinceIso).getTime();
  const active = new Set<string>();
  for (const usage of apiUsage) {
    if (new Date(usage.created_at).getTime() >= since) {
      active.add(usage.user_id);
    }
  }
  return active;
}

export function mapUsersToStripeCustomers(users: User[]): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const user of users) {
    if (user.stripe_customer_id) {
      mapping.set(user.id, user.stripe_customer_id);
    }
  }
  return mapping;
}

export function sumPaidInvoicesForCustomers(invoices: StripeInvoice[], customerIds: Set<string>): number {
  let total = 0;
  for (const invoice of invoices) {
    if (invoice.status === 'paid' && customerIds.has(invoice.customer_id)) {
      total += invoice.amount_paid;
    }
  }
  return total;
}
