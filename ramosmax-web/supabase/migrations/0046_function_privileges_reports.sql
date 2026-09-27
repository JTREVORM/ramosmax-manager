-- ===========================================================================
-- RamosMAX Web — Final phase — 0046: execute privileges for the reports
-- ===========================================================================
-- The report functions are created in 0045, AFTER the allow-list in 0044, so
-- PostgreSQL's automatic grant to PUBLIC on each of them is still in place.
--
-- This revoke names PUBLIC only. The explicit grants 0044 made to
-- `authenticated` are held by that role directly and are untouched; what goes
-- is the blanket grant every new function receives. Then the handful of
-- report functions a browser may call are named.
--
-- Everything else in 0045 — report_money, report_period and every section
-- builder — stays unreachable. They are pieces of one report, not an API.
-- ===========================================================================

revoke execute on all functions in schema app from public;
revoke execute on all functions in schema app from anon;
alter default privileges in schema app revoke execute on functions from public;

grant execute on function
  app.report_catalogue(),
  app.report_max_days(),
  app.report_max_rows(),
  app.my_reports(),
  app.business_report(text, date, date)
to authenticated;
