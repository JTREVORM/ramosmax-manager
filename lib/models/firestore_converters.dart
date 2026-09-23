import 'package:cloud_firestore/cloud_firestore.dart';

/// Conversions between Firestore values and Dart types. Dates are always
/// stored as Firestore [Timestamp] (UTC instants) — never as strings or epoch
/// numbers — and converted to local presentation only in DateTimeFormatter.
abstract final class FirestoreConverters {
  static DateTime? toDateTime(Object? value) {
    if (value is Timestamp) return value.toDate();
    if (value is DateTime) return value;
    return null;
  }

  static Timestamp? fromDateTime(DateTime? value) =>
      value == null ? null : Timestamp.fromDate(value);
}
