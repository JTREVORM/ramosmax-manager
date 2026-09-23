// Number plates - the primary operational identifier of a vehicle.
//
// Server copy of lib/core/utils/number_plates.dart (which builds on
// Validators.normalizePlate / Validators.numberPlate). Two forms:
//   display  "UGB 123A"  (canonical spacing, upper case) - shown and stored
//   key      "UGB123A"   (letters and digits only)      - searched and unique
// test/unit/customers_vehicles_test.dart checks both implementations
// against the same cases.

const PATTERNS = [
  /^U[A-Z]{2} \d{3}[A-Z]?$/, // private / commercial / motorcycles: UBA 123A, UAA 123
  /^(UG|UP|UPDF|UPF|UA) \d{3,4}[A-Z]?$/, // government / police / army
  /^(CD|UN|DC) \d{2,3} \d{2,3}$/, // diplomatic
];

/** Canonical display form, e.g. `ugb-123a` -> `UGB 123A`. */
export function displayPlate(input) {
  const upper = String(input ?? '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ');
  const spaced = upper.trim().replace(/\s+/g, ' ');
  if (PATTERNS.some((p) => p.test(spaced))) return spaced;
  const compact = upper.replace(/\s+/g, '');
  const m = /^([A-Z]+)(\d+)([A-Z]?)$/.exec(compact);
  if (m) return `${m[1]} ${m[2]}${m[3]}`;
  return spaced;
}

/** Search and uniqueness key: letters and digits only, e.g. `UGB123A`. */
export function plateKey(input) {
  return String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** {display, key} for a valid Ugandan plate, or null. */
export function parsePlate(input) {
  const display = displayPlate(input);
  if (!PATTERNS.some((p) => p.test(display))) return null;
  return { display, key: plateKey(display) };
}
