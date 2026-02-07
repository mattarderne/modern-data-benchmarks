select
  id,
  id as product_id,
  name,
  active,
  created_at
from raw_stripe.products
