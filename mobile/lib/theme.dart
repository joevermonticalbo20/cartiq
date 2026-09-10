import 'package:flutter/material.dart';

/// CartIQ design tokens - mirrors web theme.css (60-30-20 system).
/// 20% brand red | 30% charcoal | 60% neutral base
/// Status hexes match web `--success/--warn/--danger/--info` exactly.
class AppColors {
  static const primary = Color(0xFFE73631);
  static const primaryStrong = Color(0xFFC72824);
  static const primarySoft = Color(0xFFFBE3E2);
  static const primaryTint = Color(0xFFFCEFEE);

  static const accent = Color(0xFF0A0908);
  static const accentSoft = Color(0xFF1E1E1E);

  static const highlight = Color(0xFFECC242);
  static const highlightSoft = Color(0xFFFEF6D7);

  static const ok = Color(0xFF166534);
  static const okBg = Color(0xFFDCFCE7);
  static const warn = Color(0xFF92400E);
  static const warnBg = Color(0xFFFEF3C7);
  static const danger = Color(0xFF991B1B);
  static const dangerBg = Color(0xFFFEE2E2);
  static const info = Color(0xFF1E3A8A);
  static const infoBg = Color(0xFFDBEAFE);
}

class AppRadius {
  static const xs = 4.0;
  static const s = 10.0;
  static const m = 12.0;
  static const l = 16.0;
  static const xl = 20.0;
}

/// 4px-base spacing scale - mirrors web `--space-1..8`.
class AppSpacing {
  static const space1 = 4.0;
  static const space2 = 8.0;
  static const space3 = 12.0;
  static const space4 = 16.0;
  static const space5 = 20.0;
  static const space6 = 24.0;
  static const space7 = 32.0;
  static const space8 = 40.0;
}

class AppShadow {
  static List<BoxShadow> sm({Color color = Colors.black}) => [
        BoxShadow(
          color: color.withValues(alpha: 0.06),
          blurRadius: 8,
          offset: const Offset(0, 2),
        ),
      ];
  static List<BoxShadow> md({Color color = Colors.black}) => [
        BoxShadow(
          color: color.withValues(alpha: 0.08),
          blurRadius: 16,
          offset: const Offset(0, 6),
        ),
      ];
}

class AppTheme {
  static ThemeData light() => _build(Brightness.light);
  static ThemeData dark() => _build(Brightness.dark);

  static ThemeData _build(Brightness brightness) {
    final isDark = brightness == Brightness.dark;

    // ---- palette (60-30-20 system) ---------------------------------
    final bg       = isDark ? const Color(0xFF121212)  : const Color(0xFFF8F9FA);
    final surface  = isDark ? const Color(0xFF1E1E1E)  : Colors.white;
    final surfaceAlt = isDark ? const Color(0xFF262626) : const Color(0xFFF1F3F5);
    final border   = isDark ? const Color(0xFF2A2A2A)  : const Color(0xFFE5E7EB);
    final text     = isDark ? const Color(0xFFF8F9FA)  : const Color(0xFF0A0908);
    final muted    = isDark ? const Color(0xFFA1A1AA)  : const Color(0xFF6B7280);
    final primarySoft = isDark ? const Color(0xFF3B1513) : AppColors.primarySoft;

    final scheme = ColorScheme.fromSeed(
      seedColor: AppColors.primary,
      brightness: brightness,
      surface: surface,
    );

    // ---- text theme (Standard+: readable at arm's length) --------------
    // Web mapping (sizes stay touch-sized, roles match):
    // displaySmall~3xl, headlineMedium~2xl, headlineSmall~xl, titleLarge~lg,
    // titleMedium/titleSmall~md, bodyLarge/bodyMedium~md, bodySmall~sm,
    // labelLarge~sm, labelSmall~xs.
    TextTheme textTheme = TextTheme(
      displaySmall: TextStyle(
          fontSize: 30, fontWeight: FontWeight.w800, letterSpacing: -0.5, color: text),
      headlineMedium:
          TextStyle(fontSize: 24, fontWeight: FontWeight.w800, color: text),
      headlineSmall:
          TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: text),
      titleLarge: TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: text),
      titleMedium: TextStyle(fontSize: 15.5, fontWeight: FontWeight.w600, color: text),
      titleSmall: TextStyle(fontSize: 13.5, fontWeight: FontWeight.w600, color: text),
      bodyLarge: TextStyle(fontSize: 16, color: text),
      bodyMedium: TextStyle(fontSize: 15, height: 1.25, color: text),
      bodySmall: TextStyle(fontSize: 13, color: muted),
      labelLarge: TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: text),
      labelSmall:
          TextStyle(fontSize: 11.5, fontWeight: FontWeight.w600, letterSpacing: 0.3,
              color: muted),
    );

    // ---- input decoration ---------------------------------------------
    OutlineInputBorder outline(Color c, [double w = 1]) =>
        OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadius.m),
          borderSide: BorderSide(color: c, width: w),
        );

    final inputTheme = InputDecorationTheme(
      filled: true,
      fillColor: surfaceAlt,
      hintStyle: TextStyle(color: muted.withValues(alpha: 0.85)),
      labelStyle: TextStyle(color: muted, fontWeight: FontWeight.w600),
      floatingLabelStyle: TextStyle(color: AppColors.primary, fontWeight: FontWeight.w700),
      helperStyle: TextStyle(color: muted, fontSize: 12),
      errorStyle: TextStyle(color: AppColors.danger, fontWeight: FontWeight.w600),
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
      enabledBorder: outline(border),
      focusedBorder: outline(AppColors.primary, 1.6),
      errorBorder: outline(AppColors.danger),
      focusedErrorBorder: outline(AppColors.danger, 1.6),
    );

    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme.copyWith(surface: surface, onSurface: text),
      scaffoldBackgroundColor: bg,
      textTheme: textTheme,
      splashFactory: InkSparkle.splashFactory,

      appBarTheme: AppBarTheme(
        backgroundColor: surface,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        foregroundColor: text,
        titleTextStyle: textTheme.titleLarge,
      ),

      cardTheme: CardThemeData(
        color: surface,
        elevation: 0,
        margin: EdgeInsets.zero,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.l),
          side: BorderSide(color: border),
        ),
      ),

      inputDecorationTheme: inputTheme,

      dividerTheme: DividerThemeData(color: border, thickness: 1, space: 1),

      chipTheme: ChipThemeData(
        backgroundColor: surfaceAlt,
        side: BorderSide(color: border),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        labelStyle: TextStyle(
            fontSize: 11.5, fontWeight: FontWeight.w700, color: muted),
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      ),

      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: AppColors.primary,
          foregroundColor: Colors.white,
          minimumSize: const Size(0, 50),
          textStyle:
              const TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
          shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(AppRadius.m)),
        ),
      ),

      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: AppColors.primary,
          minimumSize: const Size(0, 48),
          side: BorderSide(color: AppColors.primary, width: 1.4),
          textStyle:
              const TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
          shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(AppRadius.m)),
        ),
      ),

      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: surface,
        surfaceTintColor: Colors.transparent,
        indicatorColor: primarySoft,
        height: 68,
        labelBehavior: NavigationDestinationLabelBehavior.alwaysShow,
        iconTheme: WidgetStateProperty.resolveWith((states) => IconThemeData(
              size: 24,
              color: states.contains(WidgetState.selected)
                  ? AppColors.primary
                  : muted,
            )),
        labelTextStyle: WidgetStateProperty.resolveWith((states) => TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: states.contains(WidgetState.selected)
                  ? AppColors.primary
                  : muted,
            )),
      ),

      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: isDark ? AppColors.accentSoft : const Color(0xFF0A0908),
        contentTextStyle: const TextStyle(fontSize: 14, color: Color(0xFFF8F9FA)),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),

      listTileTheme: ListTileThemeData(
        iconColor: muted,
        subtitleTextStyle: TextStyle(fontSize: 13, color: muted),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.m)),
      ),

      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: surface,
        surfaceTintColor: Colors.transparent,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
        ),
        showDragHandle: true,
      ),

      dialogTheme: DialogThemeData(
        backgroundColor: surface,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.l)),
      ),
    );
  }
}
