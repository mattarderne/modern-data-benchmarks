select
  id as invoice_id,
  customer_id,
  subscription_id,
  amount_due,
  amount_paid,
  status,
  created_at as invoice_created_at
from raw_stripe_invoices
