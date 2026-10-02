import 'package:flutter/material.dart';
import '../theme.dart';

/// Reusable empty state placeholder.
/// INAYOS NA: Tinanggal ang "grid" (dashed border) para malinis at centered.
class AppEmptyState extends StatelessWidget {
  const AppEmptyState({
    super.key,
    required this.icon,
    required this.title,
    this.subtitle,
    this.actionLabel,
    this.actionIcon,
    this.onAction,
    this.compact = false,
    this.isError = false,
  });

  final IconData icon;
  final String title;
  final String? subtitle;
  final String? actionLabel;
  final IconData? actionIcon;
  final VoidCallback? onAction;
  final bool compact;
  final bool isError;

  @override
  Widget build(BuildContext context) {
    final iconColor = isError ? AppColors.danger : AppColors.primary;
    final displayIcon =
        isError &&
            (icon == Icons.receipt_long_rounded || icon == Icons.receipt_long)
        ? Icons.error_outline_rounded
        : icon;

    return Center(
      child: Padding(
        padding: EdgeInsets.symmetric(
          horizontal: AppSpacing.space6,
          vertical: compact ? AppSpacing.space5 : AppSpacing.space8,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            // Premium double-ring icon container
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: iconColor.withValues(alpha: 0.05),
                shape: BoxShape.circle,
              ),
              child: Container(
                width: compact ? 56 : 72,
                height: compact ? 56 : 72,
                decoration: BoxDecoration(
                  color: iconColor.withValues(alpha: 0.12),
                  shape: BoxShape.circle,
                ),
                alignment: Alignment.center,
                child: Icon(
                  displayIcon,
                  size: compact ? 28 : 32,
                  color: iconColor,
                ),
              ),
            ),
            const SizedBox(height: AppSpacing.space4),
            Text(
              title,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.titleLarge?.copyWith(
                fontWeight: FontWeight.w800,
                letterSpacing: -0.5,
                color: isError ? AppColors.danger : null,
              ),
            ),
            if (subtitle != null) ...[
              const SizedBox(height: AppSpacing.space2),
              Text(
                subtitle!,
                textAlign: TextAlign.center,
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(height: 1.4),
              ),
            ],
            if (actionLabel != null && onAction != null) ...[
              const SizedBox(height: AppSpacing.space6),
              FilledButton.icon(
                onPressed: onAction,
                icon: Icon(actionIcon ?? Icons.add, size: 18),
                label: Text(actionLabel!),
                style: FilledButton.styleFrom(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 24,
                    vertical: 12,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
