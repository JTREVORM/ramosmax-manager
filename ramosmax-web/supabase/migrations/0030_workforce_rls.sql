-- ===========================================================================
-- RamosMAX Web — Phase F — 0030: who may read workforce records
-- ===========================================================================
-- Ports the Phase 6 section of `firebase/firestore.rules`. `authenticated`
-- holds SELECT only; every change goes through a SECURITY DEFINER function,
-- so these policies decide reading and nothing else.
--
-- The privacy rules that matter, stated once:
--   * A staff member reads their OWN records (staff_uid = auth.uid()) and only
--     with the matching `*.view.own` permission.
--   * A payslip is their own AND `visible_to_staff` — i.e. once the payroll has
--     been paid. Never anyone else's, at any time.
--   * A loss incident about them becomes readable once it has been DECIDED
--     (`visible_to_staff`), never while it is being investigated.
--   * `reports.payroll.view` gives payroll HEADERS (totals) and nothing else:
--     no item, no earning, no salary, no deduction. A manager with workforce
--     reports therefore never gains any individual's pay.
-- ===========================================================================

-- Attendance -----------------------------------------------------------------

create policy attendance_read on public.attendance
  for select to authenticated
  using (
    app.has_permission('attendance.view')
    or (staff_uid = auth.uid() and app.has_permission('attendance.view.own'))
  );

create policy attendance_corrections_read on public.attendance_corrections
  for select to authenticated
  using (
    app.has_permission('attendance.view')
    or (staff_uid = auth.uid() and app.has_permission('attendance.view.own'))
  );

-- Allowances -----------------------------------------------------------------

create policy allowances_read on public.worker_allowances
  for select to authenticated
  using (
    app.has_permission('allowances.view')
    or (staff_uid = auth.uid() and app.has_permission('allowances.view.own'))
  );

-- Salary ---------------------------------------------------------------------
-- `staff.salary.view` is the Phase 1 name for `salary.view`.

create policy salary_profiles_read on public.salary_profiles
  for select to authenticated
  using (
    app.has_either_permission('salary.view', 'staff.salary.view')
    or (staff_uid = auth.uid() and app.has_permission('payroll.view.own'))
  );

create policy salary_history_read on public.salary_history
  for select to authenticated
  using (
    app.has_permission('salary.history.view')
    or (staff_uid = auth.uid() and app.has_permission('payroll.view.own'))
  );

-- Payroll --------------------------------------------------------------------

-- Headers carry totals only.
create policy payroll_read on public.payroll
  for select to authenticated
  using (app.has_either_permission('payroll.view', 'reports.payroll.view'));

-- One employee's pay. The employee sees their own payslip once the payroll
-- has been paid. `reports.payroll.view` does NOT appear here.
create policy payroll_items_read on public.payroll_items
  for select to authenticated
  using (
    app.has_permission('payroll.view')
    or (staff_uid = auth.uid() and visible_to_staff and app.has_permission('payroll.view.own'))
  );

-- An earning belongs to a payslip and follows it.
create policy payroll_earnings_read on public.payroll_earnings
  for select to authenticated
  using (
    app.has_permission('payroll.view')
    or (staff_uid = auth.uid() and app.has_permission('payroll.view.own')
        and exists (select 1 from public.payroll_items i
                     where i.payroll_id = payroll_earnings.payroll_id
                       and i.staff_uid = payroll_earnings.staff_uid
                       and i.current and i.visible_to_staff))
  );

-- Deductions and losses ------------------------------------------------------

create policy deductions_read on public.salary_deductions
  for select to authenticated
  using (
    app.has_either_permission('payroll.view', 'losses.view')
    or app.has_permission('deductions.manage')
    or (staff_uid = auth.uid() and app.has_permission('payroll.view.own'))
  );

-- An application belongs to a deduction and follows it.
create policy deduction_applications_read on public.deduction_applications
  for select to authenticated
  using (
    app.has_either_permission('payroll.view', 'losses.view')
    or app.has_permission('deductions.manage')
    or (app.has_permission('payroll.view.own')
        and exists (select 1 from public.salary_deductions d
                     where d.id = deduction_applications.deduction_id
                       and d.staff_uid = auth.uid()))
  );

create policy losses_read on public.loss_incidents
  for select to authenticated
  using (
    app.has_permission('losses.view')
    or (staff_uid = auth.uid() and visible_to_staff and app.has_permission('payroll.view.own'))
  );

-- Notifications --------------------------------------------------------------
-- A workforce event carries identifiers only (a number, an id) — never an
-- amount, a salary or a deduction. It is read by the person it names, or by
-- whoever holds the permission it is addressed to.

create policy workforce_events_read on public.workforce_events
  for select to authenticated
  using (
    (recipient_uid is not null and recipient_uid = auth.uid())
    or (audience <> 'staff' and app.has_permission(audience))
  );

-- ---------------------------------------------------------------------------
-- Payroll reporting without individual pay
-- ---------------------------------------------------------------------------
-- What a manager holding `reports.payroll.view` (and not `payroll.view`) sees:
-- period, status and totals. The view reads the headers the policy above
-- already allows, so it grants nothing extra.

create or replace view public.payroll_report_totals
with (security_invoker = true)
as
  select p.id, p.payroll_number, p.frequency, p.period_key, p.period_label,
         p.period_start, p.period_end, p.status, p.employee_count, p.total_gross_ugx,
         p.total_allowances_ugx, p.total_deductions_ugx, p.total_net_ugx, p.paid_at, p.locked_at
    from public.payroll p
   where p.status <> 'cancelled';

comment on view public.payroll_report_totals is
  'Payroll totals for workforce reporting. Carries no individual pay.';

grant select on public.payroll_report_totals to authenticated;

-- ---------------------------------------------------------------------------
-- Read privileges
-- ---------------------------------------------------------------------------
-- SELECT only, and the policies above decide which rows. Every INSERT, UPDATE
-- and DELETE stays with the functions.

grant select on
  public.attendance, public.attendance_corrections, public.worker_allowances,
  public.salary_profiles, public.salary_history, public.payroll, public.payroll_items,
  public.payroll_earnings, public.salary_deductions, public.deduction_applications,
  public.loss_incidents, public.workforce_events
to authenticated;
