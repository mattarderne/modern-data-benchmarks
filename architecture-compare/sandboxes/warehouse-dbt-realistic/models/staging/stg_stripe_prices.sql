select
  id as price_id,
  product_id,
  nickname,
  unit_amount,
  currency,
  billing_interval,
  created_at as price_created_at
from raw_stripe_prices
