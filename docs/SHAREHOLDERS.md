# Shareholders (Phase 7)

Who owns RamosMAX Automotive Care (U) Ltd, how much each person has contributed, and how ownership has changed over
time. This is a software record of ownership. It is **not** legal or accounting advice, and it does not model voting
rights, the legal rights of a share class, the company's value or investment returns.

See also: [SHARES.md](SHARES.md) (classes, issues, transfers, adjustments, contributions, historical ownership) and
[DIVIDENDS.md](DIVIDENDS.md).

## Shareholder profile — `shareholders/{id}`

| Field | Notes |
|---|---|
| `shareholderNumber` | `RMX-SHR-000001`, from the server counter `counters/shareholders` |
| `fullName`, `phoneNumber` (E.164), `email`, `address` | A person or a company |
| `idType` / `idNumber` | Optional: national ID, passport, company registration or other (both or neither) |
| `joinDate`, `notes` | |
| `status` | `active` / `inactive` / `suspended` / `exited` (the brief's ACTIVE / INACTIVE / SUSPENDED / EXITED) |
| `statusReason` | The reason for the latest status change |
| `linkedUid`, `linkedUserName` | The RamosMAX sign-in of the person who **is** this shareholder (self-service) |
| `totalShares`, `ownershipPercent`, `committedUgx`, `paidUgx`, `outstandingUgx`, `dividendsPaidUgx` | **Server-maintained** totals. The app only displays them |
| `searchTokens` | Lower-case word prefixes of the name and number, for search |

Duplicates are refused. A phone number or an identification number belongs to at most one shareholder. This is
enforced by reservation documents in `unique_keys` (`shareholder_phone_…`, `shareholder_id_…`), and a sign-in can be
linked to only one shareholder (`shareholder_uid_…`). Creation is idempotent: the `requestId` is kept in
`unique_keys/request_…`.

### Status rules

- Only **active** shareholders can receive new shares, either by issue or as the destination of a transfer.
- A **suspended** or **exited** shareholder's shares cannot be transferred out.
- **Exited** requires no shares, no outstanding commitment and no pending share transactions.
- Every status change needs a reason and is audited. Nothing is ever deleted: exited shareholders keep their full
  history.

## Search

Screen: **Shareholders → All shareholders** (`shareholders.view`). Every query is bounded to at most 100 results:

- `RMX-SHR-000012`, `shr-12` → exact shareholder number;
- `0772 123 456` → exact phone (E.164);
- a name → `searchTokens array-contains` on the longest word, with the other words checked on the device;
- a status chip → `status == …`, ordered by number (index `status, shareholderNumber`).

The whole register is never downloaded to the device.

## The register — `share_register/current`

A summary maintained by the server after every posting:

- **Counts:** `shareholderCount`, `statusCounts.{active,…}` and `holderCount` (holders with shares).
- **Share totals:** `totalShares` and `byClass`.
- **Money totals:** `totalCommittedUgx`, `totalPaidUgx` and `outstandingUgx`.
- **Approvals:** `pendingApprovals`.
- **Ownership distribution:** `holders` (number, name, shares and % for each holder).

It contains no contact or identity data. That is why managers can see it through `shareholders.reports.view`.

## Screens

| Route | Screen | Needs |
|---|---|---|
| `/app/shareholders` → *Dashboard* | Totals, active shareholders, total shares, share capital received and outstanding, ownership distribution, pending approvals, dividend status, recent share transactions | `shareholders.reports.view`, `shares.view` or `shareholders.view` |
| `/app/shareholders` → *All shareholders* | Search, status filter, **Add shareholder** | `shareholders.view` (`shareholders.create` to add) |
| `/app/shareholders` → *Reports* | Share capital (committed / received / outstanding), classes, **ownership on a date** | as the dashboard |
| `/app/shareholders/new`, `/:id/edit` | Profile form | `shareholders.create` / `shareholders.update` |
| `/app/shareholders/:id` | Profile, ownership %, contributions, holdings by class, share history (issues, transfers, adjustments, reversals), dividend history, outstanding amounts; actions | `shareholders.view` (+ `shares.view` / `dividends.view` for the history cards) |
| `/app/my-shares` | **My Shareholding**: the signed-in shareholder's own record | `shareholders.view.own` |

## Self-service (`shareholders.view.own`)

The `shareholder` role already existed in the authentication model, so self-service is implemented without changing
authentication:

1. An Administrator (`shareholders.manage` + `users.view`) links the person's RamosMAX sign-in to their shareholder
   record: **Shareholder → Link sign-in** (`linkShareholderAccount`).
2. The person opens **My Shareholding**. The app calls `getMyShareholding`, which finds the record with
   `linkedUid == caller` **on the server**. It returns only that shareholder's profile, holdings, their own share
   history (their own line only, never the counterparty), contributions, and dividends that have been approved or
   paid.
3. The Firestore rules give the shareholder role **no** direct read access to any shareholder collection. A modified
   app therefore cannot query another shareholder's data (tested in `functions/test/rules.test.js`).

## Callable functions (`functions/src/shareholders.js`)

| Function | Permission | Notes |
|---|---|---|
| `createShareholder` | `shareholders.create` | `requestId`; duplicate phone / ID refused |
| `updateShareholder` | `shareholders.update` | Only the changed fields are written and audited (phone and ID masked in the audit log) |
| `setShareholderStatus` | `shareholders.manage` | Reason required; exit rules above |
| `linkShareholderAccount` | `shareholders.manage` | Link or unlink (`uid: null`) |
| `createShareClass`, `updateShareClass` | `shareholders.manage` | See SHARES.md |
| `updateShareholdingPolicy` | `settings.manage` | `settings/share_policy` or `settings/dividend_policy`, reason required |
| `getMyShareholding` | `shareholders.view.own` | Own records only |

## Audit actions (module `shareholders`)

- **Shareholders:** `shareholder.created`, `shareholder.updated`, `shareholder.status_changed`,
  `shareholder.account_linked`, `shareholder.account_unlinked`.
- **Classes and policy:** `share_class.created`, `share_class.updated`, `share_policy.updated`,
  `dividend_policy.updated`.

Share and dividend actions are listed in SHARES.md and DIVIDENDS.md.

## Limitations

- **Documents and photos:** not implemented in Phase 7. Evidence goes in `reference` / `notes` for now. A future
  upload prefix would need its own Storage rule.
- **Self-service delivery:** it is served by a function, so it needs a connection and is not cached offline.
