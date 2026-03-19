select
  date_trunc('month', invoice_created_at) as invoice_month,
  sum(amount_paid) as mrr
from stg_stripe_invoices
where status = 'paid'
group by 1
