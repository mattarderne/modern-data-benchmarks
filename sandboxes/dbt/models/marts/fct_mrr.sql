with paid_invoices as (
  select
    subscription_id,
    customer_id,
    amount_paid,
    date_trunc('month', created_at) as invoice_month
  from {{ ref('stg_stripe_invoices') }}
  where status = 'paid'
),
active_subscriptions as (
  select
    subscription_id,
    customer_id
  from {{ ref('stg_stripe_subscriptions') }}
  where status = 'active'
)
select
  paid_invoices.customer_id,
  paid_invoices.invoice_month,
  sum(paid_invoices.amount_paid) as mrr_amount
from paid_invoices
join active_subscriptions
  on paid_invoices.subscription_id = active_subscriptions.subscription_id
  and paid_invoices.customer_id = active_subscriptions.customer_id
group by 1, 2
