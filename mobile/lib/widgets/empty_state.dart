import 'package:flutter/material.dart';

import '../theme.dart';

/// Reusable empty state placeholder for ListView bodies.
/// Designed to live inside a scrollable so the parent's pull-to-refresh
/// (e.g. RefreshIndicator) still works.
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
  });

  final IconData icon;
  final String title;
  final String? subtitle;
  final String? actionLabel;
  final IconData? actionIcon;
  final VoidCallback? onAction;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: EdgeInsets.symmetric(
        horizontal: 24,
        vertical: compact ? 60 : 90,
      ),
      children: [
        Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: compact ? 64 : 76,
                height: compact ? 64 : 76,
                decoration: BoxDecoration(
                  color: AppColors.primary.withValues(alpha: 0.12),
                  shape: BoxShape.circle,
                ),
                alignment: Alignment.center,
                child: Icon(icon,
                    size: compact ? 30 : 34, color: AppColors.primary),
              ),
              const SizedBox(height: 14),
              Text(
                title,
                textAlign: TextAlign.center,
                style: Theme.of(context)
                    .textTheme
                    .headlineSmall
                    ?.copyWith(fontWeight: FontWeight.w800),
              ),
              if (subtitle != null) ...[
                const SizedBox(height: 6),
                Text(
                  subtitle!,
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
              if (actionLabel != null && onAction != null) ...[
                const SizedBox(height: 18),
                FilledButton.icon(
                  onPressed: onAction,
                  icon: Icon(actionIcon ?? Icons.add),
                  label: Text(actionLabel!),
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}
