-- Finance MVP views

-- Driver balance definition (explicit):
-- driver_balance_ariary = total credits - total debits
-- balance > 0: platform owes driver
-- balance < 0: driver owes platform

create or replace view public.driver_balances as
select
  dle.driver_id,
  coalesce(sum(case when dle.direction = 'credit' then dle.amount_ariary else 0 end), 0)::bigint as total_credits_ariary,
  coalesce(sum(case when dle.direction = 'debit' then dle.amount_ariary else 0 end), 0)::bigint as total_debits_ariary,
  (
    coalesce(sum(case when dle.direction = 'credit' then dle.amount_ariary else 0 end), 0)
    - coalesce(sum(case when dle.direction = 'debit' then dle.amount_ariary else 0 end), 0)
  )::bigint as driver_balance_ariary
from public.driver_ledger_entries dle
group by dle.driver_id;

comment on view public.driver_balances is
  'Driver balances derived from ledger. driver_balance_ariary = total credits - total debits. Positive: platform owes driver. Negative: driver owes platform.';

revoke all on table public.driver_balances from PUBLIC;
revoke all on table public.driver_balances from anon;
revoke all on table public.driver_balances from authenticated;

