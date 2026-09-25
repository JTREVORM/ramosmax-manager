-- ===========================================================================
-- RamosMAX Web — Final phase — 0037: who may read the ownership record
-- ===========================================================================
-- Ports the Phase 7 section of `firebase/firestore.rules`.
--
-- THE TWO RULES THAT MATTER:
--
--   * A SHAREHOLDER READS NOTHING HERE. Not the register, not the ledger, not
--     the allocations — not even their own rows. Their own record is served by
--     `app.my_shareholding()`, which looks up the shareholder linked to their
--     sign-in ON THE SERVER. A modified app cannot ask for somebody else's
--     data, because there is no query it is allowed to make.
--
--   * A MANAGER WITH `shareholders.reports.view` SEES TOTALS, not people.
--     The register view carries the ownership distribution — number, name,
--     shares, percentage — and no phone number, email, address or
--     identification. Aggregate access is not identity access.
-- ===========================================================================

create policy shareholders_read on public.shareholders
  for select to authenticated
  using (app.has_permission('shareholders.view'));

create policy share_classes_read on public.share_classes
  for select to authenticated
  using (app.has_either_permission('shares.view', 'shareholders.reports.view')
         or app.has_permission('shareholders.view'));

create policy shareholdings_read on public.shareholdings
  for select to authenticated
  using (app.has_permission('shares.view'));

create policy share_transactions_read on public.share_transactions
  for select to authenticated
  using (app.has_permission('shares.view'));

create policy share_contributions_read on public.share_contributions
  for select to authenticated
  using (app.has_permission('shares.view'));

create policy dividends_read on public.dividends
  for select to authenticated
  using (app.has_either_permission('dividends.view', 'shareholders.reports.view'));

create policy dividend_allocations_read on public.dividend_allocations
  for select to authenticated
  using (app.has_permission('dividends.view'));

create policy ownership_events_read on public.ownership_events
  for select to authenticated
  using (
    (recipient_uid is not null and recipient_uid = auth.uid())
    or (audience not in ('staff', 'shareholder') and app.has_permission(audience))
  );

grant select on
  public.shareholders, public.share_classes, public.shareholdings, public.share_transactions,
  public.share_contributions, public.dividends, public.dividend_allocations,
  public.ownership_events
to authenticated;

-- ---------------------------------------------------------------------------
-- The register: totals and the ownership distribution, no identity
-- ---------------------------------------------------------------------------

-- The register runs as its OWNER and carries its own access check, exactly as
-- the Phase E payment picker does. A row policy cannot hide a column, so
-- giving a reporting manager a policy on `shareholders` would hand them every
-- phone number and identification on the table. It does not; this does.

drop view if exists public.share_register;
create view public.share_register as
  select s.id as shareholder_id,
         s.shareholder_number,
         s.full_name as shareholder_name,
         s.status,
         s.total_shares,
         s.ownership_percent,
         s.committed_ugx,
         s.paid_ugx,
         s.outstanding_ugx
    from public.shareholders s
   where (s.total_shares > 0 or s.committed_ugx > 0)
     and (app.has_either_permission('shareholders.reports.view', 'shares.view')
          or app.has_permission('shareholders.view'));

comment on view public.share_register is
  'The ownership distribution: number, name, shares and percentage. No phone number, email, address or identification, which is why shareholder reporting can read it.';

drop view if exists public.share_register_totals;
create view public.share_register_totals as
  select count(*)::integer                                 as shareholder_count,
         count(*) filter (where s.status = 'active')::integer as active_count,
         count(*) filter (where s.total_shares > 0)::integer  as holder_count,
         coalesce(sum(s.total_shares), 0)::bigint          as total_shares,
         coalesce(sum(s.committed_ugx), 0)::bigint         as total_committed_ugx,
         coalesce(sum(s.paid_ugx), 0)::bigint              as total_paid_ugx,
         coalesce(sum(s.outstanding_ugx), 0)::bigint       as outstanding_ugx,
         (select count(*) from public.share_transactions
           where status = 'pending_approval')::integer     as pending_approvals
    from public.shareholders s
   where app.has_either_permission('shareholders.reports.view', 'shares.view')
      or app.has_permission('shareholders.view');

comment on view public.share_register_totals is
  'Register-level totals only. No individual appears here at all.';

grant select on public.share_register, public.share_register_totals to authenticated;

-- ---------------------------------------------------------------------------
-- Self-service — the ONLY way a shareholder sees their own record
-- ---------------------------------------------------------------------------

/*
 * The caller's OWN shareholding: the profile linked to their sign-in, their
 * holdings, their own share history (never the counterparty's identity), their
 * contributions and their approved dividends.
 *
 * Read on the server, so a shareholder never queries the register and cannot
 * ask for anybody else's data.
 */
create or replace function app.my_shareholding()
returns jsonb
language plpgsql
stable
security definer
set search_path = app, public, pg_temp
as $$
declare
  v_sh  public.shareholders%rowtype;
  v_out jsonb;
begin
  perform app.require_permission('shareholders.view.own', 'shareholders.view');
  select * into v_sh from public.shareholders where linked_uid = auth.uid() limit 1;
  if v_sh.id is null then
    return jsonb_build_object('linked', false);
  end if;

  v_out := jsonb_build_object(
    'linked', true,
    'shareholder', jsonb_build_object(
      'shareholderId', v_sh.id, 'shareholderNumber', v_sh.shareholder_number,
      'fullName', v_sh.full_name, 'status', v_sh.status, 'joinDate', v_sh.join_date,
      'totalShares', v_sh.total_shares, 'ownershipPercent', v_sh.ownership_percent,
      'committedUgx', v_sh.committed_ugx, 'paidUgx', v_sh.paid_ugx,
      'outstandingUgx', v_sh.outstanding_ugx, 'dividendsPaidUgx', v_sh.dividends_paid_ugx),
    'holdings', coalesce((
      select jsonb_agg(jsonb_build_object(
               'classId', h.class_id, 'classCode', h.class_code, 'shares', h.shares,
               'committedUgx', h.committed_ugx, 'paidUgx', h.paid_ugx,
               'outstandingUgx', h.outstanding_ugx) order by h.class_code)
        from public.shareholdings h
       where h.shareholder_id = v_sh.id and (h.shares > 0 or h.committed_ugx > 0)), '[]'::jsonb),
    -- Their own line only. The other party to a transfer is never named.
    'transactions', coalesce((
      select jsonb_agg(x order by x ->> 'effectiveDate' desc) from (
        select jsonb_build_object(
                 'transactionNumber', t.transaction_number, 'type', t.type,
                 'reversalOfType', t.reversal_of_type, 'status', t.status,
                 'classCode', t.class_code, 'effectiveDate', t.effective_date,
                 'deltaShares', (select sum((l ->> 'deltaShares')::bigint)
                                   from jsonb_array_elements(t.lines) l
                                  where (l ->> 'shareholderId')::uuid = v_sh.id)) as x
          from public.share_transactions t
         where t.applied and v_sh.id = any (t.shareholder_ids)
         order by t.effective_date desc, t.created_at desc
         limit 100) q), '[]'::jsonb),
    'contributions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'contributionNumber', c.contribution_number, 'amountUgx', c.amount_ugx,
               'status', c.status, 'paymentDate', c.payment_date, 'source', c.source,
               'classCode', c.class_code) order by c.created_at desc)
        from public.share_contributions c where c.shareholder_id = v_sh.id), '[]'::jsonb),
    -- Only dividends that have been approved or paid, and only their own.
    'dividends', coalesce((
      select jsonb_agg(jsonb_build_object(
               'allocationNumber', a.allocation_number, 'dividendNumber', a.dividend_number,
               'financialPeriod', a.financial_period, 'recordDate', a.record_date,
               'sharesAtRecordDate', a.shares_at_record_date,
               'dividendPerShareUgx', a.dividend_per_share_ugx, 'grossUgx', a.gross_ugx,
               'deductionsUgx', a.deductions_ugx, 'netUgx', a.net_ugx,
               'paymentStatus', a.payment_status, 'paidAt', a.paid_at) order by a.record_date desc)
        from public.dividend_allocations a
       where a.shareholder_id = v_sh.id and a.current
         and a.dividend_status in ('approved', 'partially_paid', 'paid')), '[]'::jsonb));

  return v_out;
end;
$$;
