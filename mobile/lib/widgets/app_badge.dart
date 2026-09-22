import 'package:flutter/material.dart';

import '../theme.dart';

/// Pill badge mirroring web `Badge` (ok/warn/danger/info/neutral/brand).
class AppBadge extends StatelessWidget {
  const AppBadge({
    super.key,
    required this.label,
    this.variant = AppBadgeVariant.neutral,
    this.icon,
  });

  final String label;
  final AppBadgeVariant variant;
  final IconData? icon;

  (Color, Color) _colors(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    switch (variant) {
      case AppBadgeVariant.ok:
        return (AppColors.ok, AppColors.okBg);
      case AppBadgeVariant.warn:
        return (AppColors.warn, AppColors.warnBg);
      case AppBadgeVariant.danger:
        return (AppColors.danger, AppColors.dangerBg);
      case AppBadgeVariant.info:
        return (AppColors.info, AppColors.infoBg);
      case AppBadgeVariant.brand:
        return (
          AppColors.primaryStrong,
          dark ? AppColors.darkPrimarySoft : AppColors.primarySoft
        );
      case AppBadgeVariant.neutral:
        return (
          Theme.of(context).textTheme.bodySmall?.color ?? AppColors.accentSoft,
          Theme.of(context).cardColor,
        );
    }
  }

  @override
  Widget build(BuildContext context) {
    final (fg, bg) = _colors(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(99),
        border: Border.all(color: fg.withValues(alpha: 0.35)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 11, color: fg),
            const SizedBox(width: 4),
          ],
          Text(
            label,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.4,
              color: fg,
            ),
          ),
        ],
      ),
    );
  }
}

enum AppBadgeVariant { ok, warn, danger, info, neutral, brand }
