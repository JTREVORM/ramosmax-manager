# Customers and vehicles

Phase 3. The number plate is RamosMAX's **primary operational identifier**. A returning vehicle is found by its plate;
the customer's name and phone are optional at the counter.

## The reception workflow

```
Customer arrives → New Service → type the plate
        ├── found  → "Vehicle found" (plate, make/model/colour, owner) → Start service
        └── not found → Register vehicle (plate pre-filled; customer: none / existing / new)
                                    → Start service → select services → service intake created
```

| Step | Screen | Route |
|---|---|---|
| Dashboard shortcut "New service — enter number plate" | `DashboardHomeScreen` | `/app` |
| Plate search (debounced 350 ms, results as you type) | `VehicleSearchScreen(intakeMode: true)` | `/app/new-service` |
| Register vehicle | `VehicleFormScreen` | `/app/vehicles/new?plate=UGB%20123A&next=start` |
| Select services, create intake | `StartServiceScreen` | `/app/vehicles/{id}/start` |
| Intake details | `IntakeDetailScreen` | `/app/jobs/{intakeId}` |

The same search without intake mode is the **Vehicles** module (`/app/vehicles`). It lists recently registered
vehicles when the box is empty.

## Number plates

`NumberPlates` (`lib/core/utils/number_plates.dart`) is the single place that turns typed plates into their stored
forms. It builds on the Phase 1 `Validators.normalizePlate` / `numberPlate`, and the server mirror is
`functions/src/plates.js`. Tests check that both implementations handle the same cases and patterns.

| Typed | `numberPlate` (display) | `normalizedNumberPlate` (key) |
|---|---|---|
| `UGB 123A`, `UGB123A`, `ugb 123a`, `UGB-123A` | `UGB 123A` | `UGB123A` |
| `ug 1234` | `UG 1234` | `UG1234` |
| `cd 123 45` | `CD 123 45` | `CD12345` |

Accepted formats are the Ugandan ones: private/commercial and motorcycles (`UBA 123A`, legacy `UAA 123`),
government, police and army (`UG 1234`, `UP 1234`, `UPDF 1234`), and diplomatic (`CD 123 45`, `UN 123 45`).

**Uniqueness:** a key can belong to only one vehicle. The server reserves `unique_keys/plate_{KEY}` in the same
transaction that creates the vehicle, which is race-safe. `UGB 123A` and `ugb-123a` are therefore the same vehicle
and the second registration is refused with *"UGB 123A is already registered."*. The app then offers **Open the
existing vehicle**.

**Plate changes** (edit vehicle) need `vehicles.manage` and a **reason**. The server validates and normalises the new
plate, refuses duplicates, moves the reservation, appends the old plate to `previousPlates`, and audits
`vehicle.plate_changed`. Past service intakes keep the plate they were recorded with. The vehicle's document ID
never changes, so history stays attached.

## Customer model — `customers/{customerId}`

| Field | Notes |
|---|---|
| `customerId` | Document ID |
| `customerNumber` | `RMX-CUS-000001`, allocated from `counters/customers` |
| `fullName` | **Required** |
| `phoneNumber`, `alternativePhone` | Optional. E.164 (`+256772123456`), normalised by the server. The primary phone is unique across customers (`unique_keys/customer_phone_{E164}`). |
| `email`, `address`, `notes` | Optional |
| `status` | `active` / `inactive` (never deleted) |
| `vehicleCount` | Maintained by the server |
| `searchTokens` | Lower-case word prefixes of the name, for search |
| `createdAt/By`, `updatedAt/By` | Metadata |

Phone input uses the central `PhoneNumbers.normalize`: `0772 123 456`, `772123456` and `+256772123456` are the same
number (Uganda default), and other countries must be typed in full (`+254…`). A second customer with the same main
phone is refused with *"A customer with this phone number already exists"* and a link to that customer.

## Customer search

`CustomerQuery.parse` decides how a typed search runs. Each case is one bounded, index-backed query:

| Typed | Query |
|---|---|
| empty | newest 30 (`status` + `createdAt` index when filtered) |
| a phone in any format | `phoneNumber == E164` and `alternativePhone == E164` |
| `RMX-CUS-000012` / `cus-12` | `customerNumber == …` |
| a name (`joh`, `okello`, `jo okello`) | `searchTokens array-contains <longest word>`, then every word must prefix a word of the name |

Filters: All, Active, Inactive. Incomplete phone numbers show nothing, and the app says the full number is needed.

## Vehicle model — `vehicles/{vehicleId}`

| Field | Notes |
|---|---|
| `vehicleId` | Document ID (not the plate, so corrections don't orphan history) |
| `numberPlate`, `normalizedNumberPlate` | **Required.** See above. |
| `model`, `colour` | **Required** |
| `make`, `year` (1950 to next year), `vehicleType` (`car`, `suv`, `pickup`, `van`, `bus`, `truck`, `motorcycle`, `other`), `notes` | Optional |
| `customerId` | The **one** primary customer, or `null` (e.g. a walk-in whose details weren't given) |
| `customerName`, `customerNumber` | Display copies kept in sync by the server. Never the phone number, so plate look-up by workers does not expose phone numbers. |
| `previousPlates` | Earlier plates after authorised changes |
| `status` | `active` / `inactive`. An inactive vehicle cannot start a new service. |
| `lastIntakeAt`, `createdAt/By`, `updatedAt/By` | Metadata |

### Customer ↔ vehicle relationship

One customer has any number of vehicles. Each vehicle has at most one primary customer (`vehicles.customerId`).
A vehicle can be linked to an **existing** customer or to a **new** customer created in the **same transaction**, so
a duplicate plate never leaves an orphan customer behind. Linking requires an existing, **active** customer.
Relinking (e.g. the vehicle was sold) needs a reason and is audited as `vehicle.customer_changed`.

The relationship is a single field today. Should RamosMAX later need co-owners, drivers or fleet accounts, a
`vehicle_customers` link collection can be added without changing how vehicles or customers are identified.

## Status

Customers and vehicles are **never deleted** in normal work. Mark them *inactive* (reason required) and reactivate
them later. History stays available for reporting.

## Editing

| Who | Customers | Vehicles |
|---|---|---|
| Admin, Manager, Cashier | Create and edit (`customers.manage`) | Register and edit (`vehicles.manage`) |
| Worker | — | Look up plates (`vehicles.view`) |
| Auditor | Read | Read |
| Shareholder | — | — |

The details screens show: **Customer information / Vehicles / History** (customers) and **Vehicle / Customer /
Service activity** (vehicles). History lists service intakes now; invoices, payments and loyalty arrive in later phases.

## Offline

Customers, vehicles, services and intakes already on the device stay readable offline (Firestore cache), including
plate search over cached vehicles. **Every change is online-only.** Registration, edits, plate and customer changes
and intakes all need the server to guarantee uniqueness and valid references. The app says so ("This needs an
internet connection…") instead of queueing anything.

See also [SERVICES.md](SERVICES.md) and [DATA_MODEL.md](DATA_MODEL.md).
