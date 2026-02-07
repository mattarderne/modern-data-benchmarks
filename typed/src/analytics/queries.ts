import type { StripeInvoice, StripeSubscription } from '../types/stripe';

export type MrrByPlan = {
  plan: string;
  mrr: number;
};

export function calculateMrr(subscriptions: StripeSubscription[], invoices: StripeInvoice[]): number {
  const activeSubscriptions = new Set(
    subscriptions.filter((subscription) => subscription.status === 'active').map((subscription) => subscription.id)
  );

  return invoices
    .filter((invoice) => invoice.status === 'paid' && activeSubscriptions.has(invoice.subscription_id))
    .reduce((total, invoice) => total + invoice.amount_paid, 0);
}

export function calculateMrrByPlan(
  subscriptions: StripeSubscription[],
  invoices: StripeInvoice[],
  priceLookup: Record<string, { nickname: string; unit_amount: number }>
): MrrByPlan[] {
  const mrrByPlan = new Map<string, number>();
  const activeSubscriptions = subscriptions.filter((subscription) => subscription.status === 'active');

  activeSubscriptions.forEach((subscription) => {
    const plan = priceLookup[subscription.price_id]?.nickname ?? 'unknown';
    const paidInvoices = invoices.filter(
      (invoice) => invoice.subscription_id === subscription.id && invoice.status === 'paid'
    );
    const total = paidInvoices.reduce((sum, invoice) => sum + invoice.amount_paid, 0);
    mrrByPlan.set(plan, (mrrByPlan.get(plan) ?? 0) + total);
  });

  return Array.from(mrrByPlan.entries()).map(([plan, mrr]) => ({ plan, mrr }));
}
