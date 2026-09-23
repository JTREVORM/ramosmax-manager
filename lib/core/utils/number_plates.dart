import 'validators.dart';

/// A parsed number plate: the canonical display form and the search key.
class NumberPlate {
  const NumberPlate(this.display, this.key);

  /// `UGB 123A` — canonical spacing, upper case. Shown and stored as
  /// `numberPlate`.
  final String display;

  /// `UGB123A` — letters and digits only. Stored as `normalizedNumberPlate`,
  /// used for search and for uniqueness (enforced on the server).
  final String key;

  @override
  bool operator ==(Object other) => other is NumberPlate && other.key == key;

  @override
  int get hashCode => key.hashCode;

  @override
  String toString() => display;
}

/// The single place that turns typed plates into their stored forms.
///
/// The number plate is RamosMAX's primary operational identifier. `UGB 123A`,
/// `UGB123A`, `ugb 123a` and `UGB-123A` are the same vehicle. Built on
/// [Validators.normalizePlate] / [Validators.numberPlate] (Ugandan formats);
/// mirrored on the server by `functions/src/plates.js`.
abstract final class NumberPlates {
  /// Canonical display form, even for incomplete input (for the search box).
  static String display(String input) => Validators.normalizePlate(input);

  /// Search/uniqueness key: upper-case letters and digits only.
  static String key(String input) => input.toUpperCase().replaceAll(RegExp('[^A-Z0-9]'), '');

  /// The plate, or null when [input] is not a valid Ugandan plate.
  static NumberPlate? parse(String input) {
    if (Validators.numberPlate(input) != null) return null;
    final display = Validators.normalizePlate(input);
    return NumberPlate(display, key(display));
  }
}
