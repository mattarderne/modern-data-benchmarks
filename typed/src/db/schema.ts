import type {
  StripeCustomer,
  StripeInvoice,
  StripePaymentIntent,
  StripePrice,
  StripeProduct,
  StripeSubscription,
} from '../types/stripe';
import type { ApiUsage, ChatSession, FeatureFlag, Organization, User } from '../types/internal';

export type TypedSchema = {
  customers: StripeCustomer;
  subscriptions: StripeSubscription;
  invoices: StripeInvoice;
  payment_intents: StripePaymentIntent;
  products: StripeProduct;
  prices: StripePrice;
  organizations: Organization;
  users: User;
  api_usage: ApiUsage;
  chat_sessions: ChatSession;
  features: FeatureFlag;
};

export const foreignKeys = {
  subscriptions: {
    customer_id: 'customers.id',
    price_id: 'prices.id',
  },
  invoices: {
    customer_id: 'customers.id',
    subscription_id: 'subscriptions.id',
  },
  payment_intents: {
    customer_id: 'customers.id',
  },
  prices: {
    product_id: 'products.id',
  },
  users: {
    organization_id: 'organizations.id',
    stripe_customer_id: 'customers.id',
  },
  api_usage: {
    user_id: 'users.id',
  },
  chat_sessions: {
    user_id: 'users.id',
  },
};

export type ForeignKeyMap = typeof foreignKeys;
