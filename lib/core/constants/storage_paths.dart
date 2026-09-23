/// Controlled Firebase Storage paths. Mirrors `firebase/storage.rules`; any
/// path not built here is denied by the rules.
abstract final class StoragePaths {
  static String staffProfilePhoto(String staffId, String fileName) =>
      'staff/$staffId/profile/$fileName';

  /// [category] is one of [StaffDocumentCategory] values.
  static String staffDocument(String staffId, String category, String fileName) =>
      'staff/$staffId/documents/$category/$fileName';

  static String expenseReceipt(String expenseId, String fileName) =>
      'expenses/$expenseId/receipts/$fileName';

  static String inventoryDocument(String itemId, String fileName) =>
      'inventory/$itemId/documents/$fileName';

  static String businessDocument(String category, String fileName) =>
      'business/$category/$fileName';

  /// Phase 5 evidence, uploaded before the Cloud Function call that records
  /// it. [kind] is one of [FinanceUploadKind]; the server accepts only paths
  /// under this prefix.
  static String financeUpload(String kind, String uploadId, String fileName) =>
      'finance_uploads/$kind/$uploadId/$fileName';

  /// Phase 6 employee evidence (sensitive: admins, managers and auditors
  /// only). [kind] is one of [PayrollUploadKind].
  static String payrollUpload(String kind, String uploadId, String fileName) =>
      'payroll_uploads/$kind/$uploadId/$fileName';
}

abstract final class StaffDocumentCategory {
  static const String nationalId = 'national_id';
  static const String contract = 'contract';
  static const String certificate = 'certificate';
  static const String other = 'other';
}

abstract final class FinanceUploadKind {
  static const String deposits = 'deposits';
  static const String reconciliations = 'reconciliations';
  static const String expenses = 'expenses';
  static const String purchases = 'purchases';
}

abstract final class PayrollUploadKind {
  static const String attendance = 'attendance';
  static const String losses = 'losses';
  static const String payroll = 'payroll';
}
