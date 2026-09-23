import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/auth/permissions.dart';
import '../../../core/errors/error_mapper.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/widgets/feedback.dart';
import '../../../models/app_user.dart';
import '../../../models/audit_log_entry.dart';
import '../../operations/presentation/operations_widgets.dart' show FilterChips, canDo;
import '../../users/application/user_management_providers.dart' show allUsersProvider;

/// Module keys written by the Cloud Functions (`audit(tx, db, actor, <module>, ...)`).
const auditModules = <String?>[
  null, 'users', 'sales', 'jobs', 'customers', 'vehicles', 'services', 'loyalty', 'finance', 'expenses', 'inventory',
  'attendance', 'payroll', 'losses', 'shareholders', 'after_hours', 'cash_handover', 'auth',
];

String auditModuleLabel(String? m) => m == null ? 'All' : m.replaceAll('_', ' ');

final auditLogsProvider = StreamProvider.autoDispose.family<List<AuditRecord>, ({String? module, int limit})>(
    (ref, q) => ref.watch(auditLogRepositoryProvider).watchLogs(module: q.module, limit: q.limit));

/// Phase 9: the append-only audit trail (audit.view). Read-only: nobody can
/// change or delete an entry (security rules).
class AuditLogScreen extends ConsumerStatefulWidget {
  const AuditLogScreen({super.key});

  @override
  ConsumerState<AuditLogScreen> createState() => _AuditLogScreenState();
}

class _AuditLogScreenState extends ConsumerState<AuditLogScreen> {
  String? _module;
  int _limit = 100;

  @override
  Widget build(BuildContext context) {
    final names = canDo(ref, Permission.usersView)
        ? {for (final u in ref.watch(allUsersProvider).value ?? const <AppUser>[]) u.uid: u.displayName}
        : const <String, String>{};
    final logs = ref.watch(auditLogsProvider((module: _module, limit: _limit)));
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.sm, AppSpacing.md, 0),
        child: Align(alignment: Alignment.centerLeft, child: Text('Audit logs', style: Theme.of(context).textTheme.titleLarge)),
      ),
      FilterChips<String?>(
        values: auditModules,
        selected: _module,
        label: auditModuleLabel,
        keyPrefix: 'audit-module',
        onSelected: (m) => setState(() {
          _module = m;
          _limit = 100;
        }),
      ),
      Expanded(
        child: switch (logs) {
          AsyncData(:final value) when value.isEmpty => const EmptyView(icon: Icons.policy_outlined, title: 'No entries'),
          AsyncData(:final value) => ListView.builder(
              padding: const EdgeInsets.fromLTRB(AppSpacing.md, 0, AppSpacing.md, 96),
              itemCount: value.length + (value.length >= _limit ? 1 : 0),
              itemBuilder: (context, i) {
                if (i == value.length) {
                  return TextButton(
                    key: const Key('audit-load-more'),
                    onPressed: () => setState(() => _limit += 100),
                    child: const Text('Load older entries'),
                  );
                }
                final r = value[i];
                return Card(
                  key: Key('audit-${r.id}'),
                  child: ListTile(
                    dense: true,
                    title: Text(r.action),
                    subtitle: Text([
                      '${names[r.userId] ?? r.userId}${r.userRole == null ? '' : ' (${r.userRole!.label})'}',
                      if (r.module != null) auditModuleLabel(r.module),
                      if (r.recordId != null) 'record ${r.recordId}',
                      if (r.reason != null && r.reason!.isNotEmpty) 'reason: ${r.reason}',
                      if (r.timestamp != null) DateTimeFormatter.dateTime(r.timestamp!),
                    ].join(' · ')),
                  ),
                );
              },
            ),
          AsyncError(:final error) => ErrorView.failure(ErrorMapper.map(error)),
          _ => const LoadingView(),
        },
      ),
    ]);
  }
}
