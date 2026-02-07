select
  id as user_id,
  organization_id,
  stripe_customer_id,
  email,
  role,
  created_at,
  last_login_at
from raw_internal.users
