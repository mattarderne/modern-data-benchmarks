select
  id as usage_id,
  user_id,
  model,
  tokens,
  latency_ms,
  CAST(created_at AS TIMESTAMP) as usage_created_at
from raw_app_api_usage
