import 'package:flutter/material.dart';

import '../branding/brand.dart';

/// Spacing scale. Use these instead of literal padding values so layouts stay
/// consistent across modules.
abstract final class AppSpacing {
  static const double xxs = 4;
  static const double xs = 8;
  static const double sm = 12;
  static const double md = 16;
  static const double lg = 24;
  static const double xl = 32;
  static const double xxl = 48;

  static const double radius = 14;
  static const double radiusLg = 20;

  /// Max content width on tablets so forms don't stretch edge to edge.
  static const double maxContentWidth = 560;
}

/// Semantic colours beyond the Material scheme, used for money and status.
abstract final class AppColors {
  static const Color success = Color(0xFF1E8E5A);
  static const Color warning = Color(0xFFC77700);
  static const Color danger = Color(0xFFC62828);
  static const Color info = Color(0xFF2F6FB5);
}

/// Material 3 theme built from the RamosMAX brand palette.
abstract final class AppTheme {
  static ThemeData light() => _build(Brightness.light);
  static ThemeData dark() => _build(Brightness.dark);

  static ThemeData _build(Brightness brightness) {
    final isDark = brightness == Brightness.dark;
    final base = ColorScheme.fromSeed(
      seedColor: Brand.purple,
      brightness: brightness,
    );
    final scheme = base.copyWith(
      primary: isDark ? const Color(0xFFCDB8F5) : Brand.purple,
      onPrimary: isDark ? Brand.purpleDeep : Colors.white,
      secondary: Brand.gold,
      onSecondary: Brand.purpleDeep,
      tertiary: Brand.goldDeep,
      error: AppColors.danger,
    );

    final textTheme = Typography.material2021(platform: TargetPlatform.android)
        .englishLike
        .merge(isDark ? Typography.whiteMountainView : Typography.blackMountainView)
        .apply(
          bodyColor: scheme.onSurface,
          displayColor: scheme.onSurface,
        )
        .copyWith(
          headlineSmall: const TextStyle(fontWeight: FontWeight.w700, letterSpacing: -0.2),
          titleLarge: const TextStyle(fontWeight: FontWeight.w700),
          titleMedium: const TextStyle(fontWeight: FontWeight.w600),
          labelLarge: const TextStyle(fontWeight: FontWeight.w600, letterSpacing: 0.2),
        );

    final rounded = RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(AppSpacing.radius),
    );

    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      textTheme: textTheme,
      scaffoldBackgroundColor: isDark ? const Color(0xFF14101C) : const Color(0xFFF7F5FA),
      appBarTheme: AppBarTheme(
        backgroundColor: Brand.purple,
        foregroundColor: Colors.white,
        elevation: 0,
        centerTitle: false,
        titleTextStyle: textTheme.titleLarge?.copyWith(color: Colors.white),
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppSpacing.radius),
          side: BorderSide(color: scheme.outlineVariant),
        ),
        color: scheme.surfaceContainerLowest,
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size.fromHeight(52),
          shape: rounded,
          textStyle: textTheme.labelLarge?.copyWith(fontSize: 16),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size.fromHeight(52),
          shape: rounded,
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: scheme.surfaceContainerLowest,
        contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
        border: OutlineInputBorder(borderRadius: BorderRadius.circular(AppSpacing.radius)),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppSpacing.radius),
          borderSide: BorderSide(color: scheme.outlineVariant),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppSpacing.radius),
          borderSide: BorderSide(color: scheme.primary, width: 2),
        ),
      ),
      navigationBarTheme: NavigationBarThemeData(
        indicatorColor: Brand.gold.withValues(alpha: 0.35),
        labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        shape: rounded,
      ),
      dialogTheme: DialogThemeData(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppSpacing.radiusLg)),
      ),
    );
  }
}
