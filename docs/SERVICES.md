# Service catalogue and service intake

## The catalogue — `services/{serviceId}`

| Field | Notes |
|---|---|
| `serviceId` | Document ID (unique by construction) |
| `name` | **Required**, unique case-insensitively (`unique_keys/service_name_{lowercase}`) |
| `description` | Optional |
| `category` | `washing`, `interior`, `exterior`, `detailing`, `polishing`, `waxing`, `other` |
| `priceUgx` | **Required.** Whole Uganda shillings, 0 to 100,000,000. |
| `estimatedDurationMinutes` | Optional, 1 to 1440 |
| `qualifiesForLoyalty` | Configuration only. The loyalty programme is a later phase. |
| `isActive` | Inactive services are hidden from new intakes; history keeps them |
| `createdAt/By`, `updatedAt/By` | Metadata |

Categories are a fixed list shared by the app (`ServiceCategory`) and the server (`serviceCategories` in
`functions/src/access_catalog.json`, checked by a test). Adding one means adding it in both, with no data migration.

### Prices

- Stored as an **integer** `priceUgx`, following the Phase 1 money convention (`Money`). No floating point anywhere.
- The app accepts `15000`, `15,000` or `UGX 15,000` and rejects decimals (`10,000.50`) and negatives. The server
  re-checks that the value is an integer between 0 and 100,000,000.
- **Nothing is hard-coded**: RamosMAX's prices exist only in Firestore and are set in the app.
- Changing a price asks for confirmation (*"UGX 15,000 → UGX 18,000"*) and an optional reason, and is audited as
  `service.price_changed` with the old and new price.
- Intakes store a **price snapshot**, so later price changes never rewrite a visit that has started.

### Who can do what

| Role | Catalogue |
|---|---|
| Admin, Manager | Add, edit, change prices, activate/deactivate (`services.manage`) |
| Cashier, Worker, Auditor | View active services and prices (`services.view`); read-only detail screen |
| Shareholder | No access |

A Worker, Cashier or Auditor **cannot change prices**. The app shows no edit controls, and more importantly the
`services` collection is not client-writable and `createService`/`updateService` require `services.manage`. This is
tested per role against the emulator.

### Screen

**Services** (`/app/services`): search, category chips, an Active/Inactive/All filter (managers), cards with name,
category, duration, loyalty flag and price, and **Add service**. Tapping opens the edit form for managers or a
read-only view for everyone else. Services are deactivated, not deleted.

## Service intake — `service_intakes/{intakeId}`

The start of a visit. Since Phase 4 the intake **is the job** (`jobNumber` `RMX-JOB-000001`, worker orders, invoice
link); see OPERATIONS.md.

| Field | Notes |
|---|---|
| `intakeId` | Document ID |
| `vehicleId`, `numberPlate`, `normalizedNumberPlate`, `vehicleSummary` | The vehicle and its plate at intake time |
| `customerId`, `customerName` | From the vehicle (may be null) |
| `jobNumber` | `RMX-JOB-000001` (Phase 4, server-allocated) |
| `status` | `draft`, `open` (default), `completed` (all live orders done, Phase 4) or `cancelled` |
| `orders`, `workerIds` | Summary of the worker orders (Phase 4) |
| `invoiceId`, `invoiceNumber`, `completedAt` | Set when completed / invoiced (Phase 4) |
| `selectedServices` | `[{serviceId, name, category, priceUgx, qualifiesForLoyalty}]`, a snapshot |
| `serviceIds`, `serviceCount` | For queries and lists |
| `notes` | Optional |
| `cancelledAt/By`, `cancelReason` | When cancelled (reason required) |
| `createdAt/By/ByName`, `updatedAt/By` | Metadata |

Rules enforced by `createServiceIntake` / `updateServiceIntake`:

- the caller holds `jobs.create` (Admin, Manager, Cashier by default);
- the vehicle exists and is **active**;
- 1 to 20 services, each **existing and active**. Unknown IDs, inactive services and duplicates are rejected or
  collapsed;
- a vehicle has at most **one open intake**. A second attempt returns *"… already has a service in progress"* with
  a link to it;
- services can be changed while open; cancelling needs a reason; a cancelled intake is final;
- every change is audited (`service_intake.created`, `.updated`, `.cancelled`, module `jobs`).

The invoice (Phase 4) prices its lines from these snapshots, so a later catalogue price change never alters a
visit already started. Loyalty uses `selectedServices[].qualifiesForLoyalty`.

**Jobs** (`/app/jobs`) lists jobs (Open / Completed / Cancelled / All, with search). It is visible to `jobs.view`
holders (Admin, Manager, Cashier, Auditor). Worker assignment, the status flow and invoicing are described in
OPERATIONS.md and BILLING_AND_PAYMENTS.md.
