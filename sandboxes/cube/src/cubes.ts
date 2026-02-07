/**
 * Drizzle Cube Definitions
 *
 * Cubes define the semantic layer - measures (aggregations) and dimensions (attributes).
 * Add your measures to the appropriate cube.
 *
 * See: https://www.drizzle-cube.dev/
 */

import { defineCube } from 'drizzle-cube/server';
import { invoices, subscriptions, customers } from './schema';
import { eq } from 'drizzle-orm';

/**
 * Invoices Cube - Revenue and payment metrics
 */
export const invoicesCube = defineCube('Invoices', {
  sql: () => ({
    from: invoices,
  }),

  measures: {
    // Total revenue from all invoices
    totalRevenue: {
      type: 'sum',
      sql: invoices.amount_paid,
    },

    // Count of invoices
    count: {
      type: 'count',
      sql: invoices.id,
    },

    // Count of unique customers
    uniqueCustomers: {
      type: 'countDistinct',
      sql: invoices.customer_id,
    },

    // Add your measures below:
  },

  dimensions: {
    status: {
      type: 'string',
      sql: invoices.status,
    },

    customerId: {
      type: 'string',
      sql: invoices.customer_id,
    },

    createdAt: {
      type: 'time',
      sql: invoices.created_at,
    },
  },
});

/**
 * Subscriptions Cube - Subscription lifecycle metrics
 */
export const subscriptionsCube = defineCube('Subscriptions', {
  sql: () => ({
    from: subscriptions,
  }),

  measures: {
    // Total subscriptions
    count: {
      type: 'count',
      sql: subscriptions.id,
    },

    // Active subscriptions
    activeCount: {
      type: 'count',
      sql: subscriptions.id,
      filter: eq(subscriptions.status, 'active'),
    },

    // Add your measures below:
  },

  dimensions: {
    status: {
      type: 'string',
      sql: subscriptions.status,
    },

    cancelAtPeriodEnd: {
      type: 'boolean',
      sql: subscriptions.cancel_at_period_end,
    },

    customerId: {
      type: 'string',
      sql: subscriptions.customer_id,
    },
  },
});

/**
 * Customers Cube - Customer segmentation metrics
 */
export const customersCube = defineCube('Customers', {
  sql: () => ({
    from: customers,
  }),

  measures: {
    count: {
      type: 'count',
      sql: customers.id,
    },
  },

  dimensions: {
    segment: {
      type: 'string',
      sql: customers.metadata_segment,
    },

    source: {
      type: 'string',
      sql: customers.metadata_source,
    },
  },
});
