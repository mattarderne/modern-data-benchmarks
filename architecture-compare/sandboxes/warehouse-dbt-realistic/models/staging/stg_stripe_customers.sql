select
  id as customer_id,
  name,
  email,
  metadata.source as metadata_source,
  metadata.segment as metadata_segment,
  created_at as customer_created_at
from raw_stripe_customers
