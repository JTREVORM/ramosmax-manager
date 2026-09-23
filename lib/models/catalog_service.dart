import '../core/money/money.dart';
import 'firestore_converters.dart';

/// Service categories. Mirrors `serviceCategories` in
/// functions/src/access_catalog.json (checked by a unit test).
enum ServiceCategory {
  washing('washing', 'Washing'),
  interior('interior', 'Interior'),
  exterior('exterior', 'Exterior'),
  detailing('detailing', 'Detailing'),
  polishing('polishing', 'Polishing'),
  waxing('waxing', 'Waxing'),
  other('other', 'Other');

  const ServiceCategory(this.key, this.label);
  final String key;
  final String label;

  static ServiceCategory parse(Object? value) {
    for (final c in values) {
      if (c.key == value) return c;
    }
    return other;
  }
}

/// A service in the RamosMAX catalogue at `services/{serviceId}`. Prices are
/// whole Uganda shillings, stored as `priceUgx` and managed only by holders
/// of `services.manage` through the Cloud Functions — never hard-coded.
class CatalogService {
  const CatalogService({
    required this.serviceId,
    required this.name,
    required this.category,
    required this.price,
    this.description,
    this.estimatedDurationMinutes,
    this.qualifiesForLoyalty = false,
    this.isActive = true,
    this.updatedAt,
  });

  final String serviceId;
  final String name;
  final ServiceCategory category;
  final Money price;
  final String? description;
  final int? estimatedDurationMinutes;

  /// Configuration only — the loyalty programme itself is a later phase.
  final bool qualifiesForLoyalty;
  final bool isActive;
  final DateTime? updatedAt;

  /// `45 min`, `1 h 30 min`
  String? get durationLabel {
    final m = estimatedDurationMinutes;
    if (m == null) return null;
    if (m < 60) return '$m min';
    return m % 60 == 0 ? '${m ~/ 60} h' : '${m ~/ 60} h ${m % 60} min';
  }

  static CatalogService fromFirestore(String id, Map<String, dynamic> d) => CatalogService(
        serviceId: id,
        name: d['name'] as String? ?? '',
        category: ServiceCategory.parse(d['category']),
        price: Money((d['priceUgx'] as num?)?.toInt() ?? 0),
        description: d['description'] as String?,
        estimatedDurationMinutes: (d['estimatedDurationMinutes'] as num?)?.toInt(),
        qualifiesForLoyalty: d['qualifiesForLoyalty'] == true,
        isActive: d['isActive'] == true,
        updatedAt: FirestoreConverters.toDateTime(d['updatedAt']),
      );
}
