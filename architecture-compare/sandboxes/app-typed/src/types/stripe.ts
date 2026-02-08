export type StripeCustomer = {
  id: string;
  name: string;
  email: string;
  metadata: {
    source: 'self-serve' | 'sales-led' | 'partner';
    segment: 'startup' | 'mid-market' | 'enterprise';
  };
  created_at: string;
};

export type StripeProduct = {
  id: string;
  name: string;
  active: boolean;
  created_at: string;
};

export type StripePrice = {
  id: string;
  product_id: string;
  nickname: 'starter' | 'growth' | 'team' | 'enterprise';
  unit_amount: number;
  currency: 'usd';
  billing_interval: 'month' | 'year';
  created_at: string;
};

export type StripeSubscription = {
  id: string;
  customer_id: string;
  price_id: string;
  status: 'active' | 'trialing' | 'canceled' | 'past_due';
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
  created_at: string;
};

export type StripeInvoice = {
  id: string;
  customer_id: string;
  subscription_id: string;
  amount_due: number;
  amount_paid: number;
  status: 'paid' | 'open' | 'void' | 'uncollectible';
  created_at: string;
};

export type StripePaymentIntent = {
  id: string;
  customer_id: string;
  amount: number;
  currency: 'usd';
  status: 'succeeded' | 'requires_payment_method' | 'processing' | 'canceled';
  created_at: string;
};
