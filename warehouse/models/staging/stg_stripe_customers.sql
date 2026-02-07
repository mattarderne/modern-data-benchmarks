select
  id as customer_id,
  name,
  email,
  metadata,
  created_at
from raw_stripe.customers
