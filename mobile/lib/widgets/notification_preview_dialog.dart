import 'package:flutter/material.dart';

import '../theme.dart';
import '../utils/manila_time.dart';
import 'notification_style.dart';

/// Preview dialog for one notification: tap a row in the Notifications list
/// and this shows the whole thing out loud - type, cart, full message, and
/// the exact Manila date and time it was filed.
Future<void> showNotificationPreview(
  BuildContext context,
  Map<String, dynamic> alert,
) async {
  final theme = Theme.of(context);
  final message = (alert['message']?.toString() ?? '').trim();
  final title = (alert['title']?.toString() ?? '').trim();
  final location = (alert['locationCode']?.toString() ?? '').trim();
  final createdAt = ManilaTime.formatFull(alert['createdAt']);
  final typeLabel = notificationTypeLabel(alert);
  final tone = notificationToneFor(alert);

  await showDialog<void>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      contentPadding: const EdgeInsets.fromLTRB(20, 18, 20, 4),
      titlePadding: const EdgeInsets.fromLTRB(20, 18, 20, 0),
      title: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 64,
            height: 64,
            decoration: BoxDecoration(
              color: tone.bg,
              borderRadius: BorderRadius.circular(AppRadius.l),
            ),
            child: Icon(notificationIconFor(alert), size: 30, color: tone.fg),
          ),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
            decoration: BoxDecoration(
              color: tone.bg,
              borderRadius: BorderRadius.circular(AppRadius.pill),
            ),
            child: Text(
              typeLabel.toUpperCase(),
              style: TextStyle(
                color: tone.fg,
                fontSize: 10.5,
                fontWeight: FontWeight.w800,
                letterSpacing: 0.08,
              ),
            ),
          ),
          const SizedBox(height: 8),
          Text(
            title.isNotEmpty ? title : typeLabel,
            textAlign: TextAlign.center,
            style: const TextStyle(
              fontWeight: FontWeight.w800,
              fontSize: 19,
              height: 1.25,
            ),
          ),
        ],
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (message.isNotEmpty)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: theme.dividerColor.withValues(alpha: 0.25),
                borderRadius: BorderRadius.circular(AppRadius.m),
              ),
              child: SelectableText(
                message,
                style: theme.textTheme.bodyMedium?.copyWith(height: 1.45),
              ),
            ),
          const SizedBox(height: 12),
          Container(
            width: double.infinity,
            decoration: BoxDecoration(
              color: theme.colorScheme.surface,
              borderRadius: BorderRadius.circular(AppRadius.m),
              border: Border.all(
                color: theme.dividerColor,
              ),
            ),
            child: Column(
              children: [
                _DetailRow(
                  icon: Icons.schedule_rounded,
                  label: 'When',
                  value: createdAt.isNotEmpty ? createdAt : '-',
                ),
                if (location.isNotEmpty) ...[
                  Divider(height: 1, indent: 44, color: theme.dividerColor),
                  _DetailRow(
                    icon: Icons.storefront_rounded,
                    label: 'Cart',
                    value: location,
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
      actionsPadding: const EdgeInsets.fromLTRB(20, 4, 20, 16),
      actions: [
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('Close'),
          ),
        ),
      ],
    ),
  );
}

class _DetailRow extends StatelessWidget {
  const _DetailRow({
    required this.icon,
    required this.label,
    required this.value,
  });

  final IconData icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      child: Row(
        children: [
          Icon(icon, size: 18, color: AppColors.muted),
          const SizedBox(width: 12),
          SizedBox(
            width: 44,
            child: Text(
              label,
              style: theme.textTheme.labelSmall?.copyWith(
                    color: AppColors.muted,
                    fontWeight: FontWeight.w700,
                  ),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: const TextStyle(
                fontSize: 12.5,
                height: 1.35,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
