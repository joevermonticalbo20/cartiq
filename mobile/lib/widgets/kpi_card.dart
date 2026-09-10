import 'package:flutter/material.dart';

import '../theme.dart';

/// KPI card mirroring web `.kpi-card` / `.solid-brand`.
/// Set [solid] for the red-gradient hero variant (e.g. sales today).
class AppKpiCard extends StatelessWidget {
  const AppKpiCard({
    super.key,
    required this.label,
    required this.value,
    this.icon,
    this.trendLabel,
    this.trendUp,
    this.solid = false,
    this.trailing,
    this.onTap,
  });

  final String label;
  final String value;
  final IconData? icon;
  final String? trendLabel;
  final bool? trendUp;
  final bool solid;
  final Widget? trailing;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final onSolid = Colors.white;
    final labelStyle = (textTheme.labelSmall ?? const TextStyle()).copyWith(
      color: solid ? onSolid.withValues(alpha: 0.85) : null,
    );
    final valueStyle =
        (textTheme.headlineMedium ?? const TextStyle()).copyWith(
      color: solid ? onSolid : AppColors.primary,
    );

    final card = Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        gradient: solid
            ? const LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                colors: [AppColors.primary, AppColors.primaryStrong],
              )
            : null,
        color: solid ? null : Theme.of(context).cardColor,
        borderRadius: BorderRadius.circular(AppRadius.l),
        border: solid
            ? null
            : Border.all(color: Theme.of(context).dividerColor),
        boxShadow: solid ? AppShadow.md(color: AppColors.primary) : null,
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  children: [
                    if (icon != null) ...[
                      Icon(icon, size: 16, color: solid ? onSolid : AppColors.primary),
                      const SizedBox(width: 6),
                    ],
                    Flexible(child: Text(label, style: labelStyle)),
                  ],
                ),
                const SizedBox(height: 6),
                Text(value, style: valueStyle),
                if (trendLabel != null) ...[
                  const SizedBox(height: 6),
                  _TrendPill(
                    label: trendLabel!,
                    up: trendUp,
                    solid: solid,
                  ),
                ],
              ],
            ),
          ),
          if (trailing != null) ...[
            const SizedBox(width: 12),
            trailing!,
          ],
        ],
      ),
    );

    if (onTap == null) return card;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(AppRadius.l),
      child: card,
    );
  }
}

class _TrendPill extends StatelessWidget {
  const _TrendPill({required this.label, required this.up, required this.solid});

  final String label;
  final bool? up;
  final bool solid;

  @override
  Widget build(BuildContext context) {
    final Color fg;
    final Color bg;
    if (solid) {
      fg = Colors.white;
      bg = Colors.white.withValues(alpha: 0.2);
    } else if (up == null) {
      fg = Theme.of(context).textTheme.bodySmall?.color ?? AppColors.warn;
      bg = Theme.of(context).cardColor;
    } else if (up!) {
      fg = AppColors.ok;
      bg = AppColors.okBg;
    } else {
      fg = AppColors.danger;
      bg = AppColors.dangerBg;
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(99),
      ),
      child: Text(
        label,
        style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: fg),
      ),
    );
  }
}
