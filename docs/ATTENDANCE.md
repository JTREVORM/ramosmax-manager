# Attendance (Phase 6)

The server code is in `functions/src/attendance.js` (the policy in `functions/src/workforce.js`). The app code is in
`lib/features/payroll/` (`attendance_screens.dart`) and `lib/models/attendance.dart`.

## The rule

**Attendance is recorded, then verified by a manager. Only verified attendance can earn an allowance.** Lateness is
worked out on the server from the configured reporting time and grace period. Being late never removes an allowance
by itself: the manager decides (ALLOWANCES.md).

```
recorded (pending_verification) ──approve──► present | late | absent | excused
                │
                └──reject (reason)──► rejected
any ──correct (attendance.correct, reason)──► pending_verification   (verified again)
```

| `status` | Brief | Meaning |
|---|---|---|
| `pending_verification` | PENDING_VERIFICATION | Recorded, waiting for a manager |
| `present` | PRESENT | Verified, on time (within the grace period) |
| `late` | LATE | Verified, arrived after the grace period |
| `absent` | ABSENT | Verified absence |
| `excused` | EXCUSED | Verified absence with a reason (e.g. sick note) |
| `rejected` | REJECTED | The manager did not accept the record (reason required) |

`arrivalStatus` (`on_time`, `late`, `absent`, `excused`) is what was recorded; `status` becomes the verified value on
approval.

## One record per person per day

The document ID is `attendance/{staffUid}_{yyyy-mm-dd}` (the EAT business day). A second record for the same person
and day is impossible (`already-exists`, `duplicate_attendance`), even from two phones at once.

## Recording

| Who | How | Permission |
|---|---|---|
| The staff member | **Clock in** on the phone. The server uses its own clock, never the phone's. Only for today, only "present" | `attendance.mark` |
| A manager | Enters present (with clock-in / clock-out times), absent, or excused (reason required) for someone else, up to 62 days back | `attendance.record` |
| Anyone who clocked in | **Clock out** on the phone (server time), once, before verification | `attendance.mark` |

Refused: future days and times, a clock-in outside the attendance day, a clock-out before the clock-in, times on an
absence, recording for someone whose account is inactive.

## Lateness (`settings/payroll_policy`)

```
minutesLate = whole minutes between the reporting time and the clock-in (0 if earlier)
late        = minutesLate > gracePeriodMinutes
severe      = late and minutesLate > lateThresholdMinutes
```

With the defaults (08:00, 15-minute grace): 08:05 and 08:14 are on time, 08:15 is the last on-time minute, 08:16 and
08:20 are late. Beyond the late threshold (120 minutes) the allowance suggestion becomes "reject".

The reporting time, grace period and late threshold in force are **copied onto each record**, so changing the
policy later never changes history. A day that is not a working day (Sunday by default) is recorded with
`workingDay: false`; by default it earns no allowance.

| Setting | Default | Meaning |
|---|---|---|
| `reportingTime` | `08:00` | EAT wall-clock time |
| `gracePeriodMinutes` | 15 | Up to this many minutes after the reporting time is on time |
| `lateThresholdMinutes` | 120 | Beyond this, "severely late" |
| `workingDays` | Mon–Sat (`[1..6]`) | ISO weekdays |
| `requireClockOut` | false | When true, a present day needs a clock-out before approval and before an allowance |

The policy is changed only by `updatePayrollPolicy` (`settings.manage`, Admin), with a reason; every change is
audited with the previous and new values. Workers can read it (it holds no one's pay).

## Verification (`verifyAttendance`)

`approve` needs `attendance.approve`; `reject` needs `attendance.review` or `attendance.approve` and a reason. Up to 50
records at once (the app's "Approve N on-time records" and the verification queue). **Nobody verifies their own
attendance** (`self_action`) — a manager's own record is verified by another manager or an Admin.

## Corrections (`correctAttendance`, `attendance.correct`)

A wrong record is never edited silently. A correction:

1. writes `attendance_corrections/{id}` with the **original** values, the **corrected** values, the changed fields,
   the reason, who corrected it and when;
2. updates the record, recomputes lateness with the record's own policy, and sends it back to
   `pending_verification`;
3. if the day already has an allowance that is not paid and not in a payroll, cancels it (it can be recalculated);
   a **paid** allowance blocks the correction (`allowance_paid`) until its payment is reversed; one included in a
   payroll blocks it too (`allowance_in_payroll`);
4. writes an `attendance.corrected` audit entry with the before/after values.

Nobody corrects their own attendance.

## Biometric attendance (prepared, not integrated)

`source` is `manual` for everything recorded today. The data model also has `biometric` and `imported`, plus
`deviceId` and `externalRef`. A future device integration will call `ingestAttendance()` in
`functions/src/attendance.js` from trusted server code (a scheduled import or an HTTPS endpoint authenticated as the
device), passing its source. Records from a device still go through verification. No client can claim a
biometric source: the app's callable always records `manual`. No biometric SDK is used and no biometric records are
created by Phase 6.

## Who sees what

| Role (default) | Attendance |
|---|---|
| Admin, Manager | Everyone's (`attendance.view`): day view, verification queue, per-person history |
| Auditor | Everyone's, read-only |
| Cashier, Worker | Their own only (`attendance.view.own`); list queries must filter `staffUid == their uid` |
| Shareholder | None |

## Screens and routes

| Route | Screen |
|---|---|
| `/app/attendance` | Managers: Day · To verify · By staff · Mine. Everyone else: today (clock in / out) and their history |
| `/app/attendance/{attendanceId}` | The record, verification, corrections history; approve / reject / correct buttons by permission |

## Audit actions

`attendance.recorded`, `attendance.clocked_out`, `attendance.approved`, `attendance.rejected`,
`attendance.corrected`, `payroll_policy.updated` (and `allowance.cancelled` when a correction cancels one).
