select
  u.organization_id,
  sum(i.amount_paid) as total_paid
from stg_app_users u
join stg_stripe_invoices i
  on i.customer_id = u.stripe_customer_id
where i.status = 'paid'
group by 1
