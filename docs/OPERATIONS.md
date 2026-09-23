# Operations: jobs and worker orders (Phase 4)

A visit starts at reception (plate search, then **Start service**; see SERVICES.md). The service intake is the
**job**. It gets a job number, and each selected service becomes one **worker order**, which a manager assigns to a
worker. The server code is in `functions/src/jobs.js`. The app code is in `lib/features/jobs/` and
`lib/features/operations/presentation/intake_screens.dart`.

## Numbers

All numbers are allocated on the server, inside the transaction that creates the record, from `counters/{name}`.
They are gap-free, and concurrent requests never share a number (an emulator test checks this).

| Record | Format | Counter |
|---|---|---|
| Job | `RMX-JOB-000001` | `counters/jobs` |
| Worker order | `RMX-JOB-000001/1`, `/2`, … (one per service) | derived from the job number |
| Invoice | `RMX-INV-000001` | `counters/invoices` |
| Receipt | `RMX-RCP-000001` | `counters/receipts` |

## Worker-order status flow

```
pending ──assign──► assigned ──accept──► accepted ──start──► in_progress ──complete──► completed
                       ▲                                        │    ▲
                       └──────── reassign (reason) ─────────────┤ pause (reason) / resume
                                                                ▼    │
                                                              paused ┘
any unfinished order ──cancel (reason)──► cancelled
```

| Action | Who | Callable | Rules |
|---|---|---|---|
| Assign | `jobs.assign` (Manager, Admin) | `assignWorkerOrder` | Only a `pending` order. The worker must be active and hold `jobs.complete`. |
| Reassign | `jobs.assign` | `reassignWorkerOrder` | Needs a reason. Allowed from assigned, accepted, in progress or paused. Must go to a different worker. The previous history entry is closed (`endedAt`, `reason`), never removed. Progress timestamps reset. |
| Cancel a service | `jobs.manage` (Manager, Admin) | `cancelWorkerOrder` | Needs a reason. Not allowed once the order is completed. |
| Accept, start, pause, resume, complete | the **assigned worker** only (`jobs.complete`) | `updateWorkerOrderStatus` | Pausing needs a reason. Completing asks the worker to confirm (optional notes). Any other move is refused with `invalid_transition`. |

Every move writes an audit entry (`work_order.assigned`, `.reassigned`, `.accepted`, `.started`, `.paused`,
`.resumed`, `.completed`, `.cancelled`) in the same transaction. Nothing is deleted.

Worked time is start → completion, minus pauses (`totalPausedMs`, added up on each resume).

## Job status

The job (`service_intakes/{id}`) keeps a summary of its orders (`orders`: number, service, worker, status) and the
list `workerIds`. Both are updated in the same transaction as every order change. The job status is derived from
the orders:

- `completed` once every order that is not cancelled is completed, and at least one was completed;
- otherwise `open` (or `draft` / `cancelled`, which are set explicitly).

A multi-service job therefore finishes only when its required services are completed or cancelled. Only a
`completed` job can be invoiced, and once it has an invoice it is frozen: no more assignments, status changes or
service edits. To change it, cancel the invoice first.

Changing a job's services (`updateServiceIntake`):

- A removed service's order is cancelled, but only while it is pending, assigned or accepted. Otherwise the change
  is refused with `order_started`.
- An added service gets a new pending order.
- Cancelling the whole job needs a reason. It is refused with `work_started` once any work has started or finished.

## Screens

| Screen | Who | What |
|---|---|---|
| **My Jobs** (`/app/my-jobs`) | Worker | Only the worker's own orders (enforced by the rules). Shows counts of new, in-hand and completed orders; filters (To do / Done / All); a card per order with plate, service, notes, worked time and the next action. |
| **Jobs** (`/app/jobs`) | Manager, Cashier, Admin, Auditor | Status filters (Open / Completed / Cancelled / All) and search by plate, job number or worker name. The search runs over the latest 50 jobs in the chosen filter. |
| **Job detail** | same | Vehicle, services with price snapshots, the **Work** section (orders, workers, progress and history, with Assign / Reassign / Cancel for managers), and **Billing** (Create invoice / Open invoice). |

The worker picker lists active staff who hold `jobs.complete`, with workers first. It needs `users.view`, which
Managers and Admins hold.

## Notifications

Assigning or reassigning an order sends `job_assigned` to the worker, through the existing FCM and in-app
notification path (`functions/src/notify.js`). The payload is the type and order ID only.

## Reporting filters (basic)

- Jobs by status, plate, job number and worker.
- Payments by period (today, 7 days, 30 days, all) and method, with totals per method.
- Receivables by debt age and status.
- Dashboard figures per role: new and in-hand orders (worker); open jobs and jobs ready to invoice
  (manager, cashier); received today; outstanding credit.

Full reports are a later phase.
