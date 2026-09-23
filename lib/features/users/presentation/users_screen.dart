import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../core/auth/access_policy.dart';
import '../../../core/errors/error_mapper.dart';
import '../../../core/providers/core_providers.dart';
import '../../../core/theme/app_theme.dart';
import '../../../core/utils/date_time_utils.dart';
import '../../../core/utils/phone_number.dart';
import '../../../core/widgets/feedback.dart';
import '../../../models/app_user.dart';
import '../../../routes/app_routes.dart';
import '../application/user_filter.dart';
import '../application/user_management_providers.dart';
import 'user_widgets.dart';

/// User Management: every RamosMAX account, searchable and filterable.
class UsersScreen extends ConsumerStatefulWidget {
  const UsersScreen({super.key});

  @override
  ConsumerState<UsersScreen> createState() => _UsersScreenState();
}

class _UsersScreenState extends ConsumerState<UsersScreen> {
  final _search = TextEditingController();

  @override
  void initState() {
    super.initState();
    _search.text = ref.read(userListQueryProvider).text;
    ref.read(userAdminActionsProvider).logOpened();
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final actor = ref.watch(currentUserProvider);
    if (actor == null) return const SizedBox.shrink();
    final now = ref.watch(clockProvider).value ?? DateTime.now();
    final query = ref.watch(userListQueryProvider);
    final users = ref.watch(filteredUsersProvider);
    final total = ref.watch(allUsersProvider).value?.length;
    final canCreate = AccessPolicy.canCreateUsers(actor, now);

    return Scaffold(
      floatingActionButton: canCreate
          ? FloatingActionButton.extended(
              key: const Key('add-user-button'),
              onPressed: () => context.go(AppRoutes.newUser),
              icon: const Icon(Icons.person_add_alt_1),
              label: const Text('Add user'),
            )
          : null,
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.md, AppSpacing.md, AppSpacing.xs),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('User Management', style: Theme.of(context).textTheme.titleLarge),
            if (total != null)
              Text('$total account${total == 1 ? '' : 's'}', style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: AppSpacing.sm),
            TextField(
              key: const Key('users-search'),
              controller: _search,
              textInputAction: TextInputAction.search,
              decoration: InputDecoration(
                prefixIcon: const Icon(Icons.search),
                hintText: 'Search name, phone or staff ID',
                suffixIcon: query.text.isEmpty
                    ? null
                    : IconButton(
                        tooltip: 'Clear search',
                        icon: const Icon(Icons.close),
                        onPressed: () {
                          _search.clear();
                          ref.read(userListQueryProvider.notifier).setText('');
                        },
                      ),
              ),
              onChanged: ref.read(userListQueryProvider.notifier).setText,
            ),
          ]),
        ),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.xxs),
          child: Row(
            children: [
              for (final f in UserListFilter.values)
                Padding(
                  padding: const EdgeInsets.only(right: AppSpacing.xs),
                  child: FilterChip(
                    key: Key('user-filter-${f.name}'),
                    label: Text(f.label),
                    selected: query.filter == f,
                    showCheckmark: false,
                    onSelected: (_) => ref.read(userListQueryProvider.notifier).setFilter(f),
                  ),
                ),
            ],
          ),
        ),
        Expanded(
          child: switch (users) {
            AsyncData(:final value) when value.isEmpty => EmptyView(
                icon: Icons.person_search_outlined,
                title: query.text.isEmpty && query.filter == UserListFilter.all ? 'No users yet' : 'No matching users',
                message: query.text.isEmpty && query.filter == UserListFilter.all
                    ? 'Add the first staff account to get started.'
                    : 'Try a different search or filter.',
              ),
            AsyncData(:final value) => ListView.separated(
                key: const Key('users-list'),
                padding: const EdgeInsets.fromLTRB(AppSpacing.md, AppSpacing.xs, AppSpacing.md, 96),
                itemCount: value.length,
                separatorBuilder: (_, _) => const SizedBox(height: AppSpacing.xs),
                itemBuilder: (_, i) => UserCard(user: value[i], now: now, isSelf: value[i].uid == actor.uid),
              ),
            AsyncError(:final error) => ErrorView.failure(
                ErrorMapper.map(error),
                onRetry: () => ref.invalidate(allUsersProvider),
              ),
            _ => const LoadingView(message: 'Loading users…'),
          },
        ),
      ]),
    );
  }
}

/// One user in the list: photo, name, contact, job, role/status and access.
class UserCard extends StatelessWidget {
  const UserCard({super.key, required this.user, required this.now, this.isSelf = false});

  final AppUser user;
  final DateTime now;
  final bool isSelf;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final muted = theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant);
    final job = [user.staffId, user.position].whereType<String>().join(' · ');

    return Card(
      key: Key('user-card-${user.uid}'),
      child: InkWell(
        borderRadius: BorderRadius.circular(AppSpacing.radius),
        onTap: () => context.go(AppRoutes.userDetail(user.uid)),
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.sm),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            UserAvatar(user: user),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Expanded(
                    child: Text(
                      isSelf ? '${user.displayName} (you)' : user.displayName,
                      style: theme.textTheme.titleMedium,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if (!user.passwordSet)
                    const Tooltip(
                      message: 'No password yet — reset the password to give access',
                      child: Icon(Icons.key_off_outlined, size: 18, color: AppColors.danger),
                    )
                  else if (user.mustChangePassword)
                    const Tooltip(
                      message: 'Must change the temporary password at next sign-in',
                      child: Icon(Icons.lock_reset, size: 18, color: AppColors.warning),
                    ),
                ]),
                Text(PhoneNumbers.formatForDisplay(user.phoneNumber), style: muted),
                if (job.isNotEmpty) Text(job, style: muted),
                const SizedBox(height: AppSpacing.xxs),
                Wrap(spacing: AppSpacing.xxs, runSpacing: AppSpacing.xxs, children: [
                  RoleChip(user: user),
                  ActiveStatusChip(active: user.active),
                ]),
                const SizedBox(height: AppSpacing.xxs),
                Text(permissionSummary(user, now), style: muted),
                Text(
                  [
                    user.lastLoginAt == null
                        ? 'Never signed in'
                        : 'Last sign-in ${DateTimeFormatter.dateTime(user.lastLoginAt!)}',
                    if (user.createdAt != null) 'Added ${DateTimeFormatter.date(user.createdAt!)}',
                  ].join(' · '),
                  style: muted,
                ),
              ]),
            ),
            const Icon(Icons.chevron_right),
          ]),
        ),
      ),
    );
  }
}
