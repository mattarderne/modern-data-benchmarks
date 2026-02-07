select
  id,
  id as price_id,
  product_id,
  nickname,
  unit_amount,
  currency,
  billing_interval,
  created_at
from raw_stripe.prices
