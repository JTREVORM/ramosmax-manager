-- ===========================================================================
-- RamosMAX Web — Final phase — 0045: business reports
-- ===========================================================================
-- Ports Phase 9 `getBusinessReport`. ONE read-only function, and the client
-- sends nothing but a report name and a period.
--
--   * Money totals come from `finance_daily_summaries`, which the ledger
--     writes in the SAME transaction as every entry — so a report can never
--     disagree with the ledger.
--   * Balances come from `financial_accounts`, also ledger-maintained.
--   * Everything else comes from the records themselves. Nothing is stored
--     twice and nothing is recomputed from a second copy.
--
-- Accounting separation, unchanged from the earlier phases:
--
--   operating revenue  = customer payments − their reversals
--   NOT revenue        = share capital, transfers, bank deposits, opening
--                        balances, adjustments, after-hours handovers
--   operating expenses = expense payments − their reversals
--   shown separately   = inventory purchases, staff pay, dividends
--
-- Permission is checked TWICE: once for the report, and again for each
-- section inside it. A report therefore never shows anybody anything the
-- screens would not.
--
-- Bounded: a period is at most 400 days, and every list is capped at 5,000
-- rows. A report that capped a list says `truncated`.
--
-- ONE DELIBERATE IMPROVEMENT over the reference: there, hitting the cap made
-- the totals themselves wrong, because they were summed from the truncated
-- list. Here totals are aggregated over the WHOLE period in the database and
-- only the list tables are capped — so a truncated report still adds up, and
-- still says it was truncated.
-- ===========================================================================

create or replace function app.report_max_days()  returns integer language sql immutable as $$ select 400 $$;
create or replace function app.report_max_rows()  returns integer language sql immutable as $$ select 5000 $$;

/* Report → the permissions that open it (any one of them). */
create or replace function app.report_catalogue()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'executive',       jsonb_build_array('reports.operational.view', 'reports.financial.view'),
    'financial',       jsonb_build_array('reports.financial.view', 'finance.view'),
    'revenue',         jsonb_build_array('reports.financial.view', 'finance.view'),
    'payment_methods', jsonb_build_array('reports.financial.view', 'finance.view'),
    'outstanding',     jsonb_build_array('credit.view'),
    'expenses',        jsonb_build_array('expenses.view'),
    'inventory',       jsonb_build_array('inventory.reports.view', 'inventory.view'),
    'workforce',       jsonb_build_array('attendance.view', 'payroll.view', 'reports.payroll.view'),
    'shareholders',    jsonb_build_array('shareholders.reports.view', 'shares.view',
                                         'shareholders.view'),
    'after_hours',     jsonb_build_array('after_hours.view'));
$$;

/* The reports this caller may open, for the screen's own menu. */
create or replace function app.my_reports()
returns text[]
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select coalesce(array_agg(r.key order by r.key), '{}')
    from jsonb_each(app.report_catalogue()) r(key, perms)
   where exists (select 1 from jsonb_array_elements_text(r.perms) p
                  where app.has_permission(p));
$$;

-- ---------------------------------------------------------------------------
-- The period
-- ---------------------------------------------------------------------------

/*
 * East Africa Time business days, inclusive. The dates are validated here and
 * nowhere else: order, the 400-day limit, and a start that is not in the
 * future.
 */
create or replace function app.report_period(p_from date, p_to date)
returns table (from_day date, to_day date, days integer)
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
begin
  if p_from is null or p_to is null then
    raise exception 'Choose the period (from and to dates).'
      using errcode = 'invalid_parameter_value', detail = 'period';
  end if;
  if p_to < p_from then
    raise exception 'The period must end on or after its start.'
      using errcode = 'invalid_parameter_value', detail = 'period';
  end if;
  if p_from > app.eat_day() then
    raise exception 'The period cannot start in the future.'
      using errcode = 'invalid_parameter_value', detail = 'period';
  end if;
  if (p_to - p_from) + 1 > app.report_max_days() then
    raise exception 'A report can cover at most % days.', app.report_max_days()
      using errcode = 'invalid_parameter_value', detail = 'period';
  end if;
  return query select p_from, p_to, ((p_to - p_from) + 1)::integer;
end;
$$;

-- ---------------------------------------------------------------------------
-- Shapes
-- ---------------------------------------------------------------------------

create or replace function app.rf(p_key text, p_label text, p_value numeric,
                                  p_kind text default 'money')
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('key', p_key, 'label', p_label,
                            'value', coalesce(p_value, 0), 'kind', p_kind);
$$;

create or replace function app.rc(p_key text, p_label text, p_kind text default 'text')
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('key', p_key, 'label', p_label, 'kind', p_kind);
$$;

create or replace function app.rt(p_key text, p_title text, p_columns jsonb, p_rows jsonb)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('key', p_key, 'title', p_title, 'columns', p_columns,
                            'rows', coalesce(p_rows, '[]'::jsonb));
$$;

create or replace function app.rs(p_key text, p_title text, p_figures jsonb,
                                  p_tables jsonb default '[]'::jsonb, p_note text default null)
returns jsonb
language sql
immutable
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'key', p_key, 'title', p_title, 'note', p_note,
    'figures', coalesce(p_figures, '[]'::jsonb), 'tables', coalesce(p_tables, '[]'::jsonb)));
$$;

-- ---------------------------------------------------------------------------
-- The daily ledger summaries, summed over the period
-- ---------------------------------------------------------------------------

/*
 * Every money total in every report comes from here. The `reversals` map is
 * keyed by the entry type that was reversed, so a reversal is subtracted from
 * the kind of money it undid and never from anything else.
 */
create or replace function app.report_money(p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  with days as (
    select * from public.finance_daily_summaries
     where business_day between p_from and p_to
  ), rev as (
    select coalesce(sum((r.value)::bigint) filter (where r.key = 'customer_payment'), 0)::bigint as customer,
           coalesce(sum((r.value)::bigint) filter (where r.key = 'expense_payment'), 0)::bigint as expense,
           coalesce(sum((r.value)::bigint) filter (where r.key = 'inventory_purchase_payment'), 0)::bigint as purchase,
           coalesce(sum((r.value)::bigint) filter (where r.key = 'allowance_payment'), 0)::bigint as allowance,
           coalesce(sum((r.value)::bigint) filter (where r.key = 'payroll_payment'), 0)::bigint as payroll,
           coalesce(sum((r.value)::bigint) filter (where r.key = 'share_capital_contribution'), 0)::bigint as capital,
           coalesce(sum((r.value)::bigint) filter (where r.key = 'dividend_payment'), 0)::bigint as dividend
      from days d, jsonb_each_text(d.reversals) r
  ), t as (
    select coalesce(sum(payments_in_ugx), 0)::bigint      as payments,
           coalesce(sum(expenses_paid_ugx), 0)::bigint    as expenses,
           coalesce(sum(purchases_paid_ugx), 0)::bigint   as purchases,
           coalesce(sum(transfers_ugx), 0)::bigint        as transfers,
           coalesce(sum(deposits_ugx), 0)::bigint         as deposits,
           coalesce(sum(opening_balances_ugx), 0)::bigint as opening,
           coalesce(sum(adjustments_in_ugx), 0)::bigint   as adjustments_in,
           coalesce(sum(adjustments_out_ugx), 0)::bigint  as adjustments_out,
           coalesce(sum(allowances_paid_ugx), 0)::bigint  as allowances,
           coalesce(sum(payroll_paid_ugx), 0)::bigint     as payroll,
           coalesce(sum(share_capital_ugx), 0)::bigint    as capital,
           coalesce(sum(dividends_paid_ugx), 0)::bigint   as dividends,
           coalesce(sum(transaction_count), 0)::bigint    as entries
      from days
  )
  select jsonb_build_object(
    'paymentsGrossUgx', t.payments,
    'paymentReversalsUgx', coalesce(rev.customer, 0),
    'netPaymentsUgx', t.payments - coalesce(rev.customer, 0),
    'netExpensesUgx', t.expenses - coalesce(rev.expense, 0),
    'netPurchasesUgx', t.purchases - coalesce(rev.purchase, 0),
    'netStaffPayUgx', t.allowances + t.payroll - coalesce(rev.allowance, 0) - coalesce(rev.payroll, 0),
    'netShareCapitalUgx', t.capital - coalesce(rev.capital, 0),
    'netDividendsUgx', t.dividends - coalesce(rev.dividend, 0),
    'transfersUgx', t.transfers,
    'depositsUgx', t.deposits,
    'openingBalancesUgx', t.opening,
    'adjustmentsInUgx', t.adjustments_in,
    'adjustmentsOutUgx', t.adjustments_out,
    'entries', t.entries)
  from t left join rev on true;
$$;

-- ---------------------------------------------------------------------------
-- Payments by method
-- ---------------------------------------------------------------------------

create or replace function app.report_payment_methods(p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  with paid as (
    select p.method, p.status, p.amount_ugx, p.is_after_hours
      from public.payments p
     where p.created_at >= app.eat_day_start(p_from)
       and p.created_at <  app.eat_day_start(p_to) + interval '1 day'
  ), by_method as (
    select m.method,
           coalesce(count(paid.method), 0)::bigint as n,
           coalesce(sum(paid.amount_ugx), 0)::bigint as gross,
           coalesce(count(*) filter (where paid.status = 'reversed'), 0)::bigint as reversed_count,
           coalesce(sum(paid.amount_ugx) filter (where paid.status = 'reversed'), 0)::bigint as reversed,
           coalesce(sum(paid.amount_ugx) filter (where paid.status <> 'reversed'), 0)::bigint as net
      from (values ('cash', 'Cash'), ('mtn_merchant', 'MTN Merchant'),
                   ('airtel_merchant', 'Airtel Merchant'), ('bank', 'Bank'))
             as m(method, label)
      left join paid on paid.method = m.method
     group by m.method
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
       'method', case b.method when 'cash' then 'Cash' when 'mtn_merchant' then 'MTN Merchant'
                               when 'airtel_merchant' then 'Airtel Merchant' else 'Bank' end,
       'count', b.n, 'grossUgx', b.gross, 'reversedCount', b.reversed_count,
       'reversedUgx', b.reversed, 'netUgx', b.net) order by b.method) from by_method b), '[]'::jsonb),
    'totals', (select jsonb_build_object('count', sum(n), 'grossUgx', sum(gross),
                        'reversedCount', sum(reversed_count), 'reversedUgx', sum(reversed),
                        'netUgx', sum(net)) from by_method),
    'afterHoursNetUgx', coalesce((select sum(amount_ugx) from paid
                                   where is_after_hours and status <> 'reversed'), 0));
$$;

-- ---------------------------------------------------------------------------
-- Sections
-- ---------------------------------------------------------------------------

create or replace function app.report_operations(p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  with intakes as (
    select i.* from public.service_intakes i
     where i.created_at >= app.eat_day_start(p_from)
       and i.created_at <  app.eat_day_start(p_to) + interval '1 day'
  ), orders as (
    select o.status, o.service_id from public.worker_orders o
     join intakes i on i.id = o.service_intake_id
  ), by_category as (
    select coalesce(s.category, 'other') as category, count(*)::bigint as n
      from intakes i
      join public.worker_orders o on o.service_intake_id = i.id
      join public.services s on s.id = o.service_id
     where i.status <> 'cancelled'
     group by 1
  )
  select app.rs('operations', 'Operations',
    jsonb_build_array(
      app.rf('jobs', 'Jobs started', (select count(*) from intakes), 'count'),
      app.rf('jobs_completed', 'Jobs completed',
             (select count(*) from intakes where status = 'completed'), 'count'),
      app.rf('jobs_open', 'Jobs still open',
             (select count(*) from intakes where status = 'open'), 'count'),
      app.rf('jobs_cancelled', 'Jobs cancelled',
             (select count(*) from intakes where status = 'cancelled'), 'count'),
      app.rf('vehicles_serviced', 'Vehicles serviced',
             (select count(distinct vehicle_id) from intakes where status = 'completed'), 'count'),
      app.rf('orders_in_progress', 'Work in progress',
             (select count(*) from orders where status in ('accepted', 'in_progress', 'paused')),
             'count'),
      app.rf('orders_pending', 'Work not yet started',
             (select count(*) from orders where status in ('pending', 'assigned')), 'count')),
    jsonb_build_array(app.rt('services_by_category', 'Services by category',
      jsonb_build_array(app.rc('category', 'Category'), app.rc('count', 'Services', 'count')),
      (select jsonb_agg(jsonb_build_object('category', category, 'count', n) order by n desc)
         from by_category))));
$$;

create or replace function app.report_revenue_section(p_from date, p_to date, p_with_credit boolean)
returns jsonb
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  with m as (select app.report_money(p_from, p_to) as v),
       pm as (select app.report_payment_methods(p_from, p_to) as v),
       owed as (
         select coalesce(sum(outstanding_ugx), 0)::bigint as v from public.invoices
          where payment_status in ('unpaid', 'partially_paid', 'credit')
       )
  select app.rs('revenue', 'Revenue',
    jsonb_build_array(
      app.rf('operating_revenue', 'Operating revenue (payments received, net of reversals)',
             (m.v ->> 'netPaymentsUgx')::bigint),
      app.rf('payments_gross', 'Customer payments before reversals',
             (m.v ->> 'paymentsGrossUgx')::bigint),
      app.rf('payment_reversals', 'Customer payments reversed',
             (m.v ->> 'paymentReversalsUgx')::bigint))
    || coalesce((select jsonb_agg(app.rf('method_' || (r ->> 'method'),
                          (r ->> 'method') || ' (net)', (r ->> 'netUgx')::bigint))
                   from jsonb_array_elements(pm.v -> 'rows') r), '[]'::jsonb)
    || jsonb_build_array(app.rf('after_hours_payments', 'Of which collected after hours',
             (pm.v ->> 'afterHoursNetUgx')::bigint))
    || case when p_with_credit
            then jsonb_build_array(app.rf('credit_outstanding',
                   'Owed by customers now (credit / unpaid)', owed.v))
            else '[]'::jsonb end,
    '[]'::jsonb,
    'Revenue counts customer payments only. Share capital, transfers, deposits, adjustments and after-hours handovers are not revenue.')
  from m, pm, owed;
$$;

create or replace function app.report_finance(p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  with m as (select app.report_money(p_from, p_to) as v),
       recs as (
         select * from public.reconciliations
          where reconciliation_date between p_from and p_to
       )
  select app.rs('finance', 'Finance',
    coalesce((select jsonb_agg(app.rf('balance_' || a.code, a.name || ' balance now', a.balance_ugx)
                       order by a.name)
                from public.financial_accounts a where a.is_active), '[]'::jsonb)
    || jsonb_build_array(
      app.rf('expenses_paid', 'Operating expenses paid', (m.v ->> 'netExpensesUgx')::bigint),
      app.rf('purchases_paid', 'Inventory purchases paid', (m.v ->> 'netPurchasesUgx')::bigint),
      app.rf('staff_pay', 'Staff pay (allowances and payroll)', (m.v ->> 'netStaffPayUgx')::bigint),
      app.rf('transfers', 'Transfers between accounts', (m.v ->> 'transfersUgx')::bigint),
      app.rf('deposits', 'Bank deposits', (m.v ->> 'depositsUgx')::bigint),
      app.rf('adjustments_in', 'Adjustments in', (m.v ->> 'adjustmentsInUgx')::bigint),
      app.rf('adjustments_out', 'Adjustments out', (m.v ->> 'adjustmentsOutUgx')::bigint),
      app.rf('reconciliations', 'Reconciliations', (select count(*) from recs), 'count'),
      app.rf('reconciliation_differences', 'Reconciliations with a difference',
             (select count(*) from recs where difference_ugx <> 0), 'count')))
  from m;
$$;

create or replace function app.report_workforce(p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  with att as (
    select a.* from public.attendance a
     where a.business_day between p_from and p_to and a.status <> 'rejected'
       and app.has_permission('attendance.view')
  ), per_staff as (
    select staff_name,
           count(*) filter (where arrival_status in ('on_time', 'late'))::bigint as present,
           count(*) filter (where arrival_status = 'late')::bigint as late,
           coalesce(sum(minutes_late) filter (where arrival_status = 'late'), 0)::bigint as minutes_late,
           count(*) filter (where arrival_status = 'absent')::bigint as absent,
           count(*) filter (where arrival_status = 'excused')::bigint as excused
      from att group by staff_name
  ), allowances as (
    -- What an allowance will actually pay: the decision, once somebody made one.
    select status,
           coalesce(sum(coalesce(approved_amount_ugx,
                                 calculated_amount_ugx - deduction_ugx)), 0)::bigint as amount
      from public.worker_allowances
     where business_day between p_from and p_to and app.has_permission('allowances.view')
     group by status
  ), runs as (
    select * from public.payroll
     where period_start between p_from and p_to and status <> 'cancelled'
       and app.has_either_permission('payroll.view', 'reports.payroll.view')
  ), losses as (
    select * from public.loss_incidents
     where incident_date between p_from and p_to and app.has_permission('losses.view')
  ), outstanding as (
    select coalesce(sum(outstanding_ugx), 0)::bigint as v from public.loss_incidents
     where outstanding_ugx > 0 and app.has_permission('losses.view')
  )
  select app.rs('workforce', 'Workforce',
    jsonb_build_array(app.rf('staff', 'Active staff accounts',
      (select count(*) from public.users where active and role <> 'shareholder'), 'count'))
    || case when app.has_permission('attendance.view') then jsonb_build_array(
         app.rf('attendance_on_time', 'On-time days',
                (select count(*) from att where arrival_status = 'on_time'), 'count'),
         app.rf('attendance_late', 'Late arrivals',
                (select count(*) from att where arrival_status = 'late'), 'count'),
         app.rf('attendance_absent', 'Absences',
                (select count(*) from att where arrival_status = 'absent'), 'count'),
         app.rf('attendance_excused', 'Excused',
                (select count(*) from att where arrival_status = 'excused'), 'count'))
       else '[]'::jsonb end
    || case when app.has_permission('allowances.view') then jsonb_build_array(
         app.rf('allowances_approved', 'Allowances approved, not yet paid',
                (select amount from allowances where status = 'approved')),
         app.rf('allowances_paid', 'Allowances paid',
                (select amount from allowances where status = 'paid')),
         app.rf('allowances_pending', 'Allowances awaiting a decision',
                (select coalesce(sum(amount), 0) from allowances
                  where status in ('calculated', 'pending_approval'))))
       else '[]'::jsonb end
    || case when app.has_either_permission('payroll.view', 'reports.payroll.view')
         then jsonb_build_array(
           app.rf('payroll_net_paid', 'Payroll net paid',
                  (select coalesce(sum(total_net_ugx), 0) from runs
                    where status in ('paid', 'locked'))),
           app.rf('payroll_deductions', 'Payroll deductions',
                  (select coalesce(sum(total_deductions_ugx), 0) from runs
                    where status in ('paid', 'locked'))))
       else '[]'::jsonb end
    || case when app.has_permission('losses.view') then jsonb_build_array(
         app.rf('losses_reported', 'Loss incidents reported', (select count(*) from losses), 'count'),
         app.rf('losses_amount', 'Losses reported (amount)',
                (select coalesce(sum(amount_ugx), 0) from losses)),
         app.rf('losses_recovered', 'Recovered so far (these incidents)',
                (select coalesce(sum(recovered_ugx), 0) from losses)),
         app.rf('losses_outstanding', 'All recoveries still outstanding',
                (select v from outstanding)))
       else '[]'::jsonb end,
    case when app.has_permission('attendance.view') then jsonb_build_array(
        app.rt('attendance_by_staff', 'Attendance by staff member',
          jsonb_build_array(app.rc('staff', 'Staff'), app.rc('present', 'Present', 'count'),
            app.rc('late', 'Late', 'count'), app.rc('minutesLate', 'Minutes late', 'count'),
            app.rc('absent', 'Absent', 'count'), app.rc('excused', 'Excused', 'count')),
          (select jsonb_agg(jsonb_build_object('staff', staff_name, 'present', present,
                    'late', late, 'minutesLate', minutes_late, 'absent', absent,
                    'excused', excused) order by staff_name) from per_staff)))
      else '[]'::jsonb end
    || case when app.has_either_permission('payroll.view', 'reports.payroll.view')
         then jsonb_build_array(app.rt('payroll', 'Payroll runs',
           jsonb_build_array(app.rc('payroll', 'Payroll'), app.rc('period', 'Period'),
             app.rc('status', 'Status'), app.rc('employees', 'Staff', 'count'),
             app.rc('grossUgx', 'Gross', 'money'), app.rc('deductionsUgx', 'Deductions', 'money'),
             app.rc('netUgx', 'Net', 'money')),
           (select jsonb_agg(jsonb_build_object('payroll', payroll_number, 'period', period_label,
                     'status', status, 'employees', employee_count, 'grossUgx', total_gross_ugx,
                     'deductionsUgx', total_deductions_ugx, 'netUgx', total_net_ugx)
                   order by period_start desc) from runs)))
       else '[]'::jsonb end);
$$;

create or replace function app.report_inventory(p_from date, p_to date, p_detail boolean)
returns jsonb
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  with items as (select * from public.inventory_items where active),
       moves as (
         select * from public.stock_movements
          where created_at >= app.eat_day_start(p_from)
            and created_at <  app.eat_day_start(p_to) + interval '1 day'
       ),
       by_type as (
         select case when type = 'stock_out' and reason_code is not null
                     then 'stock_out: ' || reason_code else type end as kind,
                count(*)::bigint as movements,
                coalesce(sum(quantity), 0)::numeric as quantity
           from moves group by 1
       ),
       purchases as (
         select * from public.inventory_purchases
          where created_at >= app.eat_day_start(p_from)
            and created_at <  app.eat_day_start(p_to) + interval '1 day'
       ),
       m as (select app.report_money(p_from, p_to) as v)
  select app.rs('inventory', 'Inventory',
    jsonb_build_array(
      app.rf('items', 'Active items', (select count(*) from items), 'count'),
      app.rf('low_stock', 'Low or out of stock',
             (select count(*) from items where stock_status in ('low', 'out_of_stock')), 'count'),
      app.rf('stock_value', 'Indicative stock value',
             (select coalesce(sum(quantity * last_unit_cost_ugx), 0) from items)),
      app.rf('movements', 'Stock movements', (select count(*) from moves), 'count'),
      app.rf('purchases', 'Purchases raised', (select count(*) from purchases), 'count'),
      app.rf('purchases_paid', 'Purchases paid', (m.v ->> 'netPurchasesUgx')::bigint),
      app.rf('suppliers', 'Suppliers', (select count(*) from public.suppliers), 'count')),
    case when p_detail then jsonb_build_array(app.rt('stock', 'Current stock',
        jsonb_build_array(app.rc('item', 'Item'), app.rc('sku', 'SKU'),
          app.rc('quantity', 'Quantity', 'count'), app.rc('unit', 'Unit'),
          app.rc('unitCostUgx', 'Last unit cost', 'money'),
          app.rc('valueUgx', 'Indicative value', 'money')),
        (select jsonb_agg(jsonb_build_object('item', name, 'sku', sku, 'quantity', quantity,
                  'unit', unit, 'unitCostUgx', last_unit_cost_ugx,
                  'valueUgx', quantity * last_unit_cost_ugx) order by name)
           from (select * from items order by name limit app.report_max_rows()) i)))
      else '[]'::jsonb end
    || jsonb_build_array(
      app.rt('low_stock', 'Low or out of stock',
        jsonb_build_array(app.rc('item', 'Item'), app.rc('sku', 'SKU'),
          app.rc('quantity', 'Quantity', 'count'), app.rc('reorderLevel', 'Reorder level', 'count'),
          app.rc('status', 'Status')),
        (select jsonb_agg(jsonb_build_object('item', name, 'sku', sku, 'quantity', quantity,
                  'reorderLevel', reorder_level, 'status', stock_status) order by name)
           from items where stock_status in ('low', 'out_of_stock'))),
      app.rt('movements', 'Stock movements in the period',
        jsonb_build_array(app.rc('type', 'Type'), app.rc('movements', 'Movements', 'count'),
          app.rc('quantity', 'Quantity', 'count')),
        (select jsonb_agg(jsonb_build_object('type', kind, 'movements', movements,
                  'quantity', quantity) order by kind) from by_type))),
    'Stock value is indicative: quantity × last purchase cost. It is not an audited valuation.')
  from m;
$$;

create or replace function app.report_ownership(p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  with reg as (select * from public.share_register_totals),
       m as (select app.report_money(p_from, p_to) as v),
       divs as (
         select * from public.dividends
          where declaration_date between p_from and p_to
       ),
       txns as (
         select type, count(*)::bigint as n from public.share_transactions
          where applied and app.has_permission('shares.view')
            and created_at >= app.eat_day_start(p_from)
            and created_at <  app.eat_day_start(p_to) + interval '1 day'
          group by type
       )
  select app.rs('ownership', 'Ownership',
    jsonb_build_array(
      app.rf('shareholders', 'Shareholders', reg.shareholder_count, 'count'),
      app.rf('holders', 'Holding shares', reg.holder_count, 'count'),
      app.rf('total_shares', 'Total shares', reg.total_shares, 'count'),
      app.rf('capital_paid', 'Share capital received (all time)', reg.total_paid_ugx),
      app.rf('capital_outstanding', 'Share capital outstanding', reg.outstanding_ugx),
      app.rf('capital_in_period', 'Share capital received in the period',
             (m.v ->> 'netShareCapitalUgx')::bigint),
      app.rf('dividends_paid', 'Dividends paid in the period',
             (m.v ->> 'netDividendsUgx')::bigint),
      app.rf('dividends_declared', 'Dividends declared in the period',
             (select count(*) from divs where status not in ('draft', 'cancelled')), 'count'),
      app.rf('pending_approvals', 'Share transactions awaiting approval',
             reg.pending_approvals, 'count'))
    || case when app.has_permission('shares.view') then jsonb_build_array(
         app.rf('issues', 'Share issues posted',
                coalesce((select n from txns where type = 'shares_issued'), 0), 'count'),
         app.rf('transfers', 'Share transfers posted',
                coalesce((select n from txns where type = 'shares_transferred'), 0), 'count'),
         app.rf('adjustments', 'Share adjustments posted',
                coalesce((select n from txns where type = 'shares_adjusted'), 0), 'count'))
       else '[]'::jsonb end,
    jsonb_build_array(
      app.rt('distribution', 'Ownership distribution',
        jsonb_build_array(app.rc('number', 'Shareholder no.'), app.rc('name', 'Name'),
          app.rc('shares', 'Shares', 'count'), app.rc('percent', 'Ownership %', 'percent')),
        (select jsonb_agg(jsonb_build_object('number', shareholder_number,
                  'name', shareholder_name, 'shares', total_shares,
                  'percent', ownership_percent) order by total_shares desc)
           from public.share_register where total_shares > 0)),
      app.rt('by_class', 'Shares by class',
        jsonb_build_array(app.rc('classCode', 'Class'), app.rc('shares', 'Shares', 'count'),
          app.rc('paidUgx', 'Capital paid', 'money')),
        (select jsonb_agg(jsonb_build_object('classCode', code, 'shares', issued_shares,
                  'paidUgx', paid_ugx) order by code) from public.share_classes)),
      app.rt('dividends', 'Dividends declared in the period',
        jsonb_build_array(app.rc('dividend', 'Dividend'), app.rc('period', 'Financial period'),
          app.rc('status', 'Status'), app.rc('allocatedUgx', 'Allocated', 'money'),
          app.rc('paidUgx', 'Paid', 'money'), app.rc('outstandingUgx', 'Outstanding', 'money')),
        (select jsonb_agg(jsonb_build_object('dividend', dividend_number,
                  'period', financial_period, 'status', status, 'allocatedUgx', allocated_ugx,
                  'paidUgx', paid_ugx, 'outstandingUgx', outstanding_ugx)
                order by record_date desc) from divs)))
    || case when app.has_permission('shares.view') then jsonb_build_array(
         app.rt('contributions', 'Contributions recorded in the period',
           jsonb_build_array(app.rc('contribution', 'Contribution'),
             app.rc('shareholder', 'Shareholder'), app.rc('source', 'Source'),
             app.rc('status', 'Status'), app.rc('amountUgx', 'Amount', 'money')),
           (select jsonb_agg(jsonb_build_object('contribution', contribution_number,
                     'shareholder', shareholder_name, 'source', source, 'status', status,
                     'amountUgx', amount_ugx) order by created_at)
              from (select * from public.share_contributions
                     where created_at >= app.eat_day_start(p_from)
                       and created_at <  app.eat_day_start(p_to) + interval '1 day'
                     order by created_at limit app.report_max_rows()) c)))
       else '[]'::jsonb end,
    'Share capital and dividends are owners'' money: never revenue, never operating expenses.')
  from reg, m;
$$;

create or replace function app.report_after_hours(p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  with sessions as (
    select * from public.after_hours_sessions
     where opened_at >= app.eat_day_start(p_from)
       and opened_at <  app.eat_day_start(p_to) + interval '1 day'
  ), handovers as (
    select * from public.cash_handovers
     where created_at >= app.eat_day_start(p_from)
       and created_at <  app.eat_day_start(p_to) + interval '1 day'
  ), discrepancies as (
    select * from public.cash_discrepancies
     where reported_at >= app.eat_day_start(p_from)
       and reported_at <  app.eat_day_start(p_to) + interval '1 day'
  ), workers as (
    select staff_name,
           count(*)::bigint as n,
           coalesce(sum(intakes_created), 0)::bigint as jobs,
           coalesce(sum(payment_count), 0)::bigint as payments,
           coalesce(sum(expected_cash_ugx) filter (where status <> 'cancelled'), 0)::bigint as expected
      from sessions group by staff_name
  )
  select app.rs('after_hours', 'After-hours',
    jsonb_build_array(
      app.rf('sessions', 'Sessions opened', (select count(*) from sessions), 'count'),
      app.rf('sessions_open', 'Still open',
             (select count(*) from sessions where status = 'open'), 'count'),
      app.rf('expected', 'Expected cash (handovers)',
             (select coalesce(sum(expected_cash_ugx), 0) from handovers)),
      app.rf('received', 'Cash received (counted)',
             (select coalesce(sum(actual_amount_ugx), 0) from handovers)),
      app.rf('handovers_waiting', 'Handovers waiting',
             (select count(*) from handovers where status in ('pending', 'submitted')), 'count'),
      app.rf('discrepancies', 'Discrepancies', (select count(*) from discrepancies), 'count'),
      app.rf('discrepancies_open', 'Discrepancies unresolved',
             (select count(*) from discrepancies where status in ('open', 'under_review')), 'count'),
      app.rf('shortages', 'Shortages',
             (select coalesce(sum(-difference_ugx), 0) from discrepancies where difference_ugx < 0)),
      app.rf('excesses', 'Excesses',
             (select coalesce(sum(difference_ugx), 0) from discrepancies where difference_ugx > 0))),
    jsonb_build_array(
      app.rt('workers', 'By worker',
        jsonb_build_array(app.rc('worker', 'Worker'), app.rc('sessions', 'Sessions', 'count'),
          app.rc('jobs', 'Jobs', 'count'), app.rc('payments', 'Payments', 'count'),
          app.rc('expectedUgx', 'Expected cash', 'money')),
        (select jsonb_agg(jsonb_build_object('worker', staff_name, 'sessions', n, 'jobs', jobs,
                  'payments', payments, 'expectedUgx', expected) order by staff_name)
           from workers)),
      app.rt('discrepancy_list', 'Discrepancies',
        jsonb_build_array(app.rc('discrepancy', 'Discrepancy'), app.rc('worker', 'Worker'),
          app.rc('status', 'Status'), app.rc('expectedUgx', 'Expected', 'money'),
          app.rc('actualUgx', 'Counted', 'money'), app.rc('differenceUgx', 'Difference', 'money')),
        (select jsonb_agg(jsonb_build_object('discrepancy', discrepancy_number,
                  'worker', staff_name, 'status', status, 'expectedUgx', expected_cash_ugx,
                  'actualUgx', actual_amount_ugx, 'differenceUgx', difference_ugx)
                order by reported_at desc) from discrepancies))),
    'Payments collected after hours are already in revenue. Handovers move custody only; they are never counted again.');
$$;

-- ---------------------------------------------------------------------------
-- Reports that are not just one section
-- ---------------------------------------------------------------------------

create or replace function app.report_daily_money(p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  with m as (select app.report_money(p_from, p_to) as v),
       days as (
         select d.business_day,
                d.payments_in_ugx,
                coalesce((d.reversals ->> 'customer_payment')::bigint, 0) as rev_payment,
                d.expenses_paid_ugx
                  - coalesce((d.reversals ->> 'expense_payment')::bigint, 0) as expenses,
                d.purchases_paid_ugx
                  - coalesce((d.reversals ->> 'inventory_purchase_payment')::bigint, 0) as purchases,
                d.allowances_paid_ugx + d.payroll_paid_ugx
                  - coalesce((d.reversals ->> 'allowance_payment')::bigint, 0)
                  - coalesce((d.reversals ->> 'payroll_payment')::bigint, 0) as staff_pay,
                d.transfers_ugx, d.deposits_ugx,
                d.adjustments_in_ugx - d.adjustments_out_ugx as adjustments,
                d.share_capital_ugx
                  - coalesce((d.reversals ->> 'share_capital_contribution')::bigint, 0) as capital,
                d.dividends_paid_ugx
                  - coalesce((d.reversals ->> 'dividend_payment')::bigint, 0) as dividends
           from public.finance_daily_summaries d
          where d.business_day between p_from and p_to
          order by d.business_day
       )
  select jsonb_build_array(app.rs('financial', 'Money in and out',
    jsonb_build_array(
      app.rf('sales', 'Customer payments (net)', (m.v ->> 'netPaymentsUgx')::bigint),
      app.rf('payment_reversals', 'Customer payments reversed',
             (m.v ->> 'paymentReversalsUgx')::bigint),
      app.rf('expenses', 'Operating expenses paid (net)', (m.v ->> 'netExpensesUgx')::bigint),
      app.rf('purchases', 'Inventory purchases paid (net)', (m.v ->> 'netPurchasesUgx')::bigint),
      app.rf('staff_pay', 'Staff pay (net)', (m.v ->> 'netStaffPayUgx')::bigint),
      app.rf('transfers', 'Transfers', (m.v ->> 'transfersUgx')::bigint),
      app.rf('deposits', 'Bank deposits', (m.v ->> 'depositsUgx')::bigint),
      app.rf('adjustments_in', 'Adjustments in', (m.v ->> 'adjustmentsInUgx')::bigint),
      app.rf('adjustments_out', 'Adjustments out', (m.v ->> 'adjustmentsOutUgx')::bigint),
      app.rf('capital', 'Share capital received (net)', (m.v ->> 'netShareCapitalUgx')::bigint),
      app.rf('dividends', 'Dividends paid (net)', (m.v ->> 'netDividendsUgx')::bigint),
      app.rf('transactions', 'Ledger entries', (m.v ->> 'entries')::bigint, 'count')),
    jsonb_build_array(app.rt('daily', 'By day',
      jsonb_build_array(app.rc('day', 'Day', 'date'), app.rc('salesUgx', 'Payments', 'money'),
        app.rc('reversedUgx', 'Reversed', 'money'), app.rc('expensesUgx', 'Expenses', 'money'),
        app.rc('purchasesUgx', 'Purchases', 'money'), app.rc('staffPayUgx', 'Staff pay', 'money'),
        app.rc('transfersUgx', 'Transfers', 'money'), app.rc('depositsUgx', 'Deposits', 'money'),
        app.rc('adjustmentsUgx', 'Adjustments (in − out)', 'money'),
        app.rc('capitalUgx', 'Share capital', 'money'),
        app.rc('dividendsUgx', 'Dividends', 'money')),
      (select jsonb_agg(jsonb_build_object('day', business_day, 'salesUgx', payments_in_ugx,
                'reversedUgx', rev_payment, 'expensesUgx', expenses, 'purchasesUgx', purchases,
                'staffPayUgx', staff_pay, 'transfersUgx', transfers_ugx,
                'depositsUgx', deposits_ugx, 'adjustmentsUgx', adjustments,
                'capitalUgx', capital, 'dividendsUgx', dividends) order by business_day)
         from days))),
    'From the daily ledger summaries (East Africa Time business days). Reversals are counted on the day they are made.'))
  from m;
$$;

create or replace function app.report_revenue(p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  with m as (select app.report_money(p_from, p_to) as v),
       billed as (
         select coalesce(sum(total_ugx), 0)::bigint as total,
                coalesce(sum(discount_ugx), 0)::bigint as discount
           from public.invoices
          where status <> 'cancelled'
            and created_at >= app.eat_day_start(p_from)
            and created_at <  app.eat_day_start(p_to) + interval '1 day'
       ),
       owed as (
         select coalesce(sum(outstanding_ugx), 0)::bigint as v from public.invoices
          where payment_status in ('unpaid', 'partially_paid', 'credit')
       )
  select jsonb_build_array(app.rs('revenue', 'Revenue',
    jsonb_build_array(
      app.rf('invoiced', 'Invoiced in the period', billed.total),
      app.rf('discounts', 'Discounts given', billed.discount),
      app.rf('payments_gross', 'Customer payments received', (m.v ->> 'paymentsGrossUgx')::bigint),
      app.rf('payment_reversals', 'Less: payments reversed',
             (m.v ->> 'paymentReversalsUgx')::bigint),
      app.rf('operating_revenue', 'Operating revenue', (m.v ->> 'netPaymentsUgx')::bigint))
    || case when app.has_either_permission('credit.view', 'reports.financial.view')
            then jsonb_build_array(app.rf('credit_outstanding',
                   'Owed by customers now (not revenue until paid)', owed.v))
            else '[]'::jsonb end,
    jsonb_build_array(app.rt('not_revenue', 'Money that is NOT operating revenue',
      jsonb_build_array(app.rc('item', 'Item'), app.rc('amountUgx', 'Amount', 'money')),
      jsonb_build_array(
        jsonb_build_object('item', 'Share capital received (owners)',
                           'amountUgx', (m.v ->> 'netShareCapitalUgx')::bigint),
        jsonb_build_object('item', 'Dividends paid (owners, not an operating expense)',
                           'amountUgx', (m.v ->> 'netDividendsUgx')::bigint),
        jsonb_build_object('item', 'Transfers between accounts',
                           'amountUgx', (m.v ->> 'transfersUgx')::bigint),
        jsonb_build_object('item', 'Bank deposits', 'amountUgx', (m.v ->> 'depositsUgx')::bigint),
        jsonb_build_object('item', 'Opening balances',
                           'amountUgx', (m.v ->> 'openingBalancesUgx')::bigint),
        jsonb_build_object('item', 'Adjustments in',
                           'amountUgx', (m.v ->> 'adjustmentsInUgx')::bigint),
        jsonb_build_object('item', 'Adjustments out',
                           'amountUgx', (m.v ->> 'adjustmentsOutUgx')::bigint)))),
    'Only customer payments are operating revenue. The items below are shown so they are never mistaken for it.'))
  from m, billed, owed;
$$;

create or replace function app.report_methods(p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  with r as (select app.report_payment_methods(p_from, p_to) as v)
  select jsonb_build_array(app.rs('payment_methods', 'Payments by method',
    jsonb_build_array(
      app.rf('count', 'Payments', (r.v -> 'totals' ->> 'count')::bigint, 'count'),
      app.rf('gross', 'Gross', (r.v -> 'totals' ->> 'grossUgx')::bigint),
      app.rf('reversed', 'Reversed', (r.v -> 'totals' ->> 'reversedUgx')::bigint),
      app.rf('net', 'Net', (r.v -> 'totals' ->> 'netUgx')::bigint)),
    jsonb_build_array(app.rt('by_method', 'By method',
      jsonb_build_array(app.rc('method', 'Method'), app.rc('count', 'Payments', 'count'),
        app.rc('grossUgx', 'Gross', 'money'), app.rc('reversedCount', 'Reversed', 'count'),
        app.rc('reversedUgx', 'Reversed amount', 'money'), app.rc('netUgx', 'Net', 'money')),
      r.v -> 'rows')),
    'Payments received in the period. "Reversed" are those among them reversed since; they are counted once and excluded from net.'))
  from r;
$$;

create or replace function app.report_outstanding(p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  with open as (
    select i.*,
           greatest(0, app.eat_day() - app.eat_day(i.created_at))::integer as age_days,
           (select count(*) from public.payments p
             where p.invoice_id = i.id and p.status <> 'reversed')::bigint as payment_count,
           (select max(app.eat_day(p.created_at)) from public.payments p
             where p.invoice_id = i.id and p.status <> 'reversed') as last_payment
      from public.invoices i
     where i.payment_status in ('unpaid', 'partially_paid', 'credit')
     order by i.created_at desc
     limit app.report_max_rows()
  ), buckets as (
    select case when age_days <= 7 then '0-7' when age_days <= 30 then '8-30'
                when age_days <= 60 then '31-60' else '61+' end as bucket,
           sum(outstanding_ugx)::bigint as amount
      from open group by 1
  ), names as (select app.has_permission('customers.view') as ok)
  select jsonb_build_array(app.rs('outstanding', 'Outstanding and credit',
    jsonb_build_array(
      app.rf('invoices', 'Open invoices', (select count(*) from open), 'count'),
      app.rf('outstanding', 'Total owed', (select coalesce(sum(outstanding_ugx), 0) from open)),
      app.rf('age_0-7', 'Owed 0-7 days',
             coalesce((select amount from buckets where bucket = '0-7'), 0)),
      app.rf('age_8-30', 'Owed 8-30 days',
             coalesce((select amount from buckets where bucket = '8-30'), 0)),
      app.rf('age_31-60', 'Owed 31-60 days',
             coalesce((select amount from buckets where bucket = '31-60'), 0)),
      app.rf('age_61+', 'Owed 61+ days',
             coalesce((select amount from buckets where bucket = '61+'), 0))),
    jsonb_build_array(app.rt('invoices', 'Open invoices',
      jsonb_build_array(app.rc('invoice', 'Invoice'), app.rc('plate', 'Plate'))
        || case when names.ok then jsonb_build_array(app.rc('customer', 'Customer'))
                else '[]'::jsonb end
        || jsonb_build_array(app.rc('status', 'Status'), app.rc('issued', 'Issued', 'date'),
             app.rc('totalUgx', 'Original', 'money'), app.rc('paidUgx', 'Paid', 'money'),
             app.rc('outstandingUgx', 'Remaining', 'money'),
             app.rc('ageDays', 'Age (days)', 'count'), app.rc('payments', 'Payments', 'count'),
             app.rc('lastPayment', 'Last payment', 'date')),
      (select jsonb_agg(jsonb_build_object('invoice', invoice_number, 'plate', number_plate)
                || case when names.ok
                        then jsonb_build_object('customer', coalesce(customer_name, ''))
                        else '{}'::jsonb end
                || jsonb_build_object('status', payment_status,
                     'issued', app.eat_day(created_at), 'totalUgx', total_ugx,
                     'paidUgx', paid_ugx, 'outstandingUgx', outstanding_ugx,
                     'ageDays', age_days, 'payments', payment_count,
                     'lastPayment', coalesce(last_payment::text, ''))
              order by outstanding_ugx desc) from open))),
    'Current balances owed (all dates). Not revenue until paid.'))
  from names;
$$;

create or replace function app.report_expenses(p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  with list as (
    select * from public.expenses where expense_date between p_from and p_to
  ), by_status as (
    select status, count(*)::bigint as n, coalesce(sum(amount_ugx), 0)::bigint as amount
      from list group by status
  ), by_category as (
    select coalesce(category_name, category_id) as category, count(*)::bigint as n,
           coalesce(sum(amount_ugx), 0)::bigint as amount
      from list where status not in ('cancelled', 'rejected')
     group by 1
  ), m as (select app.report_money(p_from, p_to) as v),
     st(code) as (values ('draft'), ('pending_review'), ('approved'), ('paid'), ('rejected'),
                         ('cancelled'))
  select jsonb_build_array(app.rs('expenses', 'Expenses (by expense date)',
    (select jsonb_agg(app.rf('status_' || st.code,
              replace(st.code, '_', ' ') || ' (' || coalesce(b.n, 0) || ')',
              coalesce(b.amount, 0)) order by st.code)
       from st left join by_status b on b.status = st.code),
    jsonb_build_array(
      app.rt('by_category', 'By category (excluding rejected and cancelled)',
        jsonb_build_array(app.rc('category', 'Category'), app.rc('count', 'Expenses', 'count'),
          app.rc('amountUgx', 'Amount', 'money')),
        (select jsonb_agg(jsonb_build_object('category', category, 'count', n,
                  'amountUgx', amount) order by amount desc) from by_category)),
      app.rt('list', 'Expenses',
        jsonb_build_array(app.rc('expense', 'Expense'), app.rc('date', 'Date', 'date'),
          app.rc('category', 'Category'), app.rc('payee', 'Payee'), app.rc('status', 'Status'),
          app.rc('amountUgx', 'Amount', 'money')),
        (select jsonb_agg(jsonb_build_object('expense', expense_number, 'date', expense_date,
                  'category', coalesce(category_name, category_id), 'payee', coalesce(payee, ''),
                  'status', status, 'amountUgx', amount_ugx) order by expense_date desc)
           from (select * from list order by expense_date desc
                  limit app.report_max_rows()) e)))))
    || case when app.has_either_permission('reports.financial.view', 'finance.view')
         then jsonb_build_array(app.rs('money_out', 'Money paid out (by payment date)',
           jsonb_build_array(
             app.rf('operating', 'Operating expenses', (m.v ->> 'netExpensesUgx')::bigint),
             app.rf('purchases', 'Inventory purchases', (m.v ->> 'netPurchasesUgx')::bigint),
             app.rf('staff_pay', 'Staff pay (allowances and payroll)',
                    (m.v ->> 'netStaffPayUgx')::bigint),
             app.rf('dividends', 'Dividends (owners)', (m.v ->> 'netDividendsUgx')::bigint)),
           '[]'::jsonb,
           'Kept apart as in the ledger: purchases, staff pay and dividends are not operating expenses.'))
         else '[]'::jsonb end
  from m;
$$;

-- ---------------------------------------------------------------------------
-- Was anything capped?
-- ---------------------------------------------------------------------------

/*
 * `truncated` means a LIST was cut at the limit — never that a total is
 * wrong, because the totals are aggregated over the whole period.
 */
create or replace function app.report_truncated(p_report text, p_from date, p_to date)
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select case p_report
    when 'outstanding' then
      (select count(*) from public.invoices
        where payment_status in ('unpaid', 'partially_paid', 'credit')) > app.report_max_rows()
    when 'expenses' then
      (select count(*) from public.expenses where expense_date between p_from and p_to)
        > app.report_max_rows()
    when 'inventory' then
      (select count(*) from public.inventory_items where active) > app.report_max_rows()
    when 'shareholders' then
      (select count(*) from public.share_contributions
        where created_at >= app.eat_day_start(p_from)
          and created_at <  app.eat_day_start(p_to) + interval '1 day') > app.report_max_rows()
    else false end;
$$;

-- ---------------------------------------------------------------------------
-- The one entry point
-- ---------------------------------------------------------------------------

/*
 * getBusinessReport. Read-only: it writes nothing, anywhere.
 *
 * The client sends a report name and a period. Everything else — which
 * sections exist, which figures they carry, what the caller may see — is
 * decided here.
 */
create or replace function app.business_report(p_report text, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_period   record;
  v_sections jsonb := '[]'::jsonb;
  v_perms    jsonb;
begin
  v_perms := app.report_catalogue() -> p_report;
  if v_perms is null then
    raise exception 'Choose a report.'
      using errcode = 'invalid_parameter_value', detail = 'report';
  end if;
  if not exists (select 1 from jsonb_array_elements_text(v_perms) p
                  where app.has_permission(p)) then
    raise exception 'You do not have permission to view this report.'
      using errcode = 'insufficient_privilege', detail = 'report_forbidden';
  end if;
  select * into v_period from app.report_period(p_from, p_to);

  if p_report = 'executive' then
    -- Each section appears only if the caller may read that data, so an
    -- executive summary never becomes a way around a screen's permission.
    if app.has_either_permission('reports.operational.view', 'jobs.view') then
      v_sections := v_sections || jsonb_build_array(
        app.report_operations(v_period.from_day, v_period.to_day));
    end if;
    if app.has_either_permission('reports.financial.view', 'finance.view') then
      v_sections := v_sections || jsonb_build_array(
        app.report_revenue_section(v_period.from_day, v_period.to_day,
          app.has_either_permission('credit.view', 'reports.financial.view')));
    end if;
    if app.has_permission('finance.view') then
      v_sections := v_sections || jsonb_build_array(
        app.report_finance(v_period.from_day, v_period.to_day));
    end if;
    if app.has_permission('attendance.view')
       or app.has_either_permission('payroll.view', 'reports.payroll.view') then
      v_sections := v_sections || jsonb_build_array(
        app.report_workforce(v_period.from_day, v_period.to_day));
    end if;
    if app.has_either_permission('inventory.view', 'inventory.reports.view') then
      v_sections := v_sections || jsonb_build_array(
        app.report_inventory(v_period.from_day, v_period.to_day, false));
    end if;
    if app.has_permission('shareholders.reports.view') then
      v_sections := v_sections || jsonb_build_array(
        app.report_ownership(v_period.from_day, v_period.to_day));
    end if;
    if app.has_permission('after_hours.view') then
      v_sections := v_sections || jsonb_build_array(
        app.report_after_hours(v_period.from_day, v_period.to_day));
    end if;
  elsif p_report = 'financial' then
    v_sections := app.report_daily_money(v_period.from_day, v_period.to_day);
  elsif p_report = 'revenue' then
    v_sections := app.report_revenue(v_period.from_day, v_period.to_day);
  elsif p_report = 'payment_methods' then
    v_sections := app.report_methods(v_period.from_day, v_period.to_day);
  elsif p_report = 'outstanding' then
    v_sections := app.report_outstanding(v_period.from_day, v_period.to_day);
  elsif p_report = 'expenses' then
    v_sections := app.report_expenses(v_period.from_day, v_period.to_day);
  elsif p_report = 'inventory' then
    v_sections := jsonb_build_array(
      app.report_inventory(v_period.from_day, v_period.to_day, true));
  elsif p_report = 'workforce' then
    v_sections := jsonb_build_array(
      app.report_workforce(v_period.from_day, v_period.to_day));
  elsif p_report = 'shareholders' then
    v_sections := jsonb_build_array(
      app.report_ownership(v_period.from_day, v_period.to_day));
  elsif p_report = 'after_hours' then
    v_sections := jsonb_build_array(
      app.report_after_hours(v_period.from_day, v_period.to_day));
  end if;

  return jsonb_build_object(
    'report', p_report,
    'from', v_period.from_day,
    'to', v_period.to_day,
    'days', v_period.days,
    'generatedAt', now(),
    'truncated', app.report_truncated(p_report, v_period.from_day, v_period.to_day),
    'sections', v_sections);
end;
$$;

comment on function app.business_report(text, date, date) is
  'Ports Phase 9 getBusinessReport. Read-only, permission-checked per report AND per section, bounded to 400 days and 5,000 rows a list.';
