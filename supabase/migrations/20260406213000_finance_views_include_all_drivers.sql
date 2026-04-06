-- Hotfix: make driver_balances return rows for all drivers (even with zero ledger entries).
-- Balance definition:
-- driver_balance_ariary = total credits - total debits
-- balance > 0: platform owes driver
-- balance < 0: driver owes platform

create or replace view public.driver_balances as
select
  p.id as driver_id,
  coalesce(sum(case when dle.direction = 'credit' then dle.amount_ariary else 0 end), 0)::bigint as total_credits_ariary,
  coalesce(sum(case when dle.direction = 'debit' then dle.amount_ariary else 0 end), 0)::bigint as total_debits_ariary,
  (
    coalesce(sum(case when dle.direction = 'credit' then dle.amount_ariary else 0 end), 0)
    - coalesce(sum(case when dle.direction = 'debit' then dle.amount_ariary else 0 end), 0)
  )::bigint as driver_balance_ariary
from public.profiles p
left join public.driver_ledger_entries dle
  on dle.driver_id = p.id
where p.role = 'driver'
group by p.id;

comment on view public.driver_balances is
  'Driver balances derived from ledger. driver_balance_ariary = total credits - total debits. Positive: platform owes driver. Negative: driver owes platform. Includes drivers with zero ledger entries.';

revoke all on table public.driver_balances from PUBLIC;
revoke all on table public.driver_balances from anon;
revoke all on table public.driver_balances from authenticated;

