import 'package:flutter/material.dart';

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
    final outline = Theme.of(context).colorScheme.outline;
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
              Icon(icon, size: compact ? 38 : 48, color: outline),
              const SizedBox(height: 12),
              Text(
                title,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.titleMedium,
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
                const SizedBox(height: 16),
                FilledButton.tonalIcon(
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
