select
  id as product_id,
  name,
  active,
  created_at as product_created_at
from raw_stripe_products
