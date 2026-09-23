import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../branding/brand.dart';
import '../providers/core_providers.dart';
import '../theme/app_theme.dart';

/// The official RamosMAX logo. Always rendered on the brand purple, which is
/// the artwork's own background, so the mark appears exactly as supplied.
class AppLogo extends StatelessWidget {
  const AppLogo({super.key, this.size = 160, this.rounded = true});

  final double size;
  final bool rounded;

  @override
  Widget build(BuildContext context) {
    final image = Image.asset(
      Brand.logo,
      width: size,
      height: size,
      fit: BoxFit.contain,
      semanticLabel: '${Brand.companyName} logo',
      filterQuality: FilterQuality.high,
    );
    if (!rounded) return image;
    return ClipRRect(borderRadius: BorderRadius.circular(size * 0.12), child: image);
  }
}

/// Compact logo for app bars — the purple-free variant on a purple bar.
class AppBarLogo extends StatelessWidget {
  const AppBarLogo({super.key, this.height = 28});
  final double height;

  @override
  Widget build(BuildContext context) => Image.asset(
        Brand.logoOnDark,
        height: height,
        fit: BoxFit.contain,
        semanticLabel: Brand.companyName,
      );
}

/// Purple brand panel used at the top of authentication screens.
class BrandHeader extends StatelessWidget {
  const BrandHeader({super.key, this.logoSize = 132, this.subtitle});

  final double logoSize;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Container(
      width: double.infinity,
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [Brand.purple, Brand.purpleDeep],
        ),
        borderRadius: BorderRadius.vertical(bottom: Radius.circular(32)),
      ),
      padding: EdgeInsets.fromLTRB(
        AppSpacing.lg,
        MediaQuery.paddingOf(context).top + AppSpacing.lg,
        AppSpacing.lg,
        AppSpacing.lg,
      ),
      child: Column(
        children: [
          AppLogo(size: logoSize, rounded: false),
          if (subtitle != null) ...[
            const SizedBox(height: AppSpacing.xs),
            Text(
              subtitle!,
              textAlign: TextAlign.center,
              style: text.bodyMedium?.copyWith(color: Colors.white.withValues(alpha: 0.85)),
            ),
          ],
          const SizedBox(height: AppSpacing.xs),
          const EnvironmentBadge(),
        ],
      ),
    );
  }
}

/// Visible marker on every non-production build so test data is never
/// mistaken for real business data. Renders nothing in production.
class EnvironmentBadge extends ConsumerWidget {
  const EnvironmentBadge({super.key, this.compact = false});

  /// Short label for crowded app bars on small phones (Phase 9).
  final bool compact;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final env = ref.watch(appEnvironmentProvider);
    if (env.isProduction) return const SizedBox.shrink();
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
      decoration: BoxDecoration(
        color: Brand.gold,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Text(
        compact ? 'DEV · TEST' : 'DEVELOPMENT · TEST DATA',
        style: const TextStyle(
          color: Brand.purpleDeep,
          fontSize: 11,
          fontWeight: FontWeight.w800,
          letterSpacing: 0.8,
        ),
      ),
    );
  }
}

/// Constrains form content on tablets and centres it.
class ContentWidth extends StatelessWidget {
  const ContentWidth({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: AppSpacing.maxContentWidth),
          child: child,
        ),
      );
}
