select
  id as subscription_id,
  customer_id,
  price_id,
  status,
  current_period_start,
  current_period_end,
  cancel_at_period_end,
  created_at
from raw_stripe.subscriptions
