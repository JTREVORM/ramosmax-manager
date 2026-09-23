import 'firestore_converters.dart';

/// Push preference categories (mirrors NOTIFICATION_CATEGORIES in
/// functions/src/notify.js). [mutable] categories can have their PUSH turned
/// off by the person; the in-app record is always kept.
enum NotificationCategory {
  access('access', 'Account and access', 'Sign-in, role and permission changes', mutable: false),
  pay('pay', 'My pay', 'Pay processed, deductions and recoveries', mutable: false),
  jobs('jobs', 'Jobs', 'Assigned, moved, cancelled and ready-to-invoice jobs'),
  sales('sales', 'Sales and loyalty', 'Loyalty rewards unlocked'),
  finance('finance', 'Finance and stock', 'Expenses, bills due, low stock and reconciliation differences'),
  workforce('workforce', 'Attendance and payroll', 'Attendance, allowances, payroll and loss reviews'),
  shareholding('shareholding', 'Shares and dividends', 'Share approvals and dividends'),
  afterHours('after_hours', 'After-hours and cash handovers', 'Authorisations, handovers and discrepancies'),
  other('other', 'Other', '');

  const NotificationCategory(this.key, this.label, this.description, {this.mutable = true});
  final String key;
  final String label;
  final String description;
  final bool mutable;

  static NotificationCategory parse(Object? v) => values.firstWhere((c) => c.key == v, orElse: () => other);
}

/// `notifications/{id}`: one in-app notice for the signed-in person, written
/// by the Cloud Functions. The app may only mark it read (security rules).
class AppNotification {
  const AppNotification({
    required this.id,
    required this.type,
    required this.title,
    required this.body,
    required this.read,
    this.recordId,
    this.category = NotificationCategory.other,
    this.critical = false,
    this.createdAt,
  });

  final String id;
  final String type;
  final String title;
  final String body;
  final bool read;
  final String? recordId;
  final NotificationCategory category;
  final bool critical;
  final DateTime? createdAt;

  static AppNotification fromFirestore(String id, Map<String, dynamic> d) => AppNotification(
        id: id,
        type: d['type'] as String? ?? '',
        title: d['title'] as String? ?? 'RamosMAX',
        body: d['body'] as String? ?? '',
        read: d['read'] == true,
        recordId: d['recordId'] is String ? d['recordId'] as String : d['recordId']?.toString(),
        category: NotificationCategory.parse(d['category']),
        critical: d['critical'] == true,
        createdAt: FirestoreConverters.toDateTime(d['createdAt']),
      );
}
