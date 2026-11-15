import 'package:flutter/material.dart';

import '../theme.dart';
import '../utils/manila_time.dart';

/// Shared icon for a notification, by raw type. Used by both the Home
/// notification sheet and Settings -> Notifications.
IconData notificationIconFor(Map<String, dynamic> alert) {
  final t = ((alert['type'] as String?) ?? '').toLowerCase();
  if (t.contains('void')) return Icons.cancel_rounded;
  if (t.contains('restock')) return Icons.inventory_2_outlined;
  if (t.contains('low')) return Icons.warning_amber_rounded;
  return Icons.notifications_outlined;
}

/// Pretty label from a raw type, such as `RESTOCK_UPDATE` -> `Restock Update`.
String notificationTypeLabel(Map<String, dynamic> alert) {
  final raw = ((alert['type'] as String?) ?? '').trim();
  if (raw.isEmpty) return 'Notification';
  return raw
      .split(RegExp(r'[_\s]+'))
      .where((p) => p.isNotEmpty)
      .map((p) {
        final s = p.toLowerCase();
        return s[0].toUpperCase() + s.substring(1);
      })
      .join(' ');
}

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

  await showDialog<void>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      contentPadding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
      title: Row(
        children: [
          CircleAvatar(
            radius: 20,
            backgroundColor:
                AppColors.primary.withValues(alpha: 0.12),
            child: Icon(
              notificationIconFor(alert),
              color: AppColors.primary,
              size: 20,
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  typeLabel.toUpperCase(),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: AppColors.muted,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 0.06,
                  ),
                ),
                Text(
                  title.isNotEmpty ? title : typeLabel,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontWeight: FontWeight.w800,
                    fontSize: 18,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (message.isNotEmpty) ...[
            const SizedBox(height: 4),
            SelectableText(
              message,
              style: theme.textTheme.bodyMedium,
            ),
          ] else
            Text(
              'This notification carries no extra details.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: AppColors.muted,
              ),
            ),
          const SizedBox(height: 16),
          const Divider(height: 1),
          const SizedBox(height: 12),
          _DetailRow(label: 'When', value: createdAt.isNotEmpty ? createdAt : '-'),
          if (location.isNotEmpty) _DetailRow(label: 'Cart', value: location),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(dialogContext),
          child: const Text('Close'),
        ),
      ],
    ),
  );
}

class _DetailRow extends StatelessWidget {
  const _DetailRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 48,
            child: Text(
              label,
              style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: AppColors.muted,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 0.04,
                  ),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: const TextStyle(
                fontSize: 12.5,
                height: 1.35,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
