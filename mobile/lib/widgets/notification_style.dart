import 'package:flutter/material.dart';

import '../theme.dart';

/// Shared visual language for the in-app notifications: one tinted avatar,
/// one type label and one relative-time format for both lists and the
/// preview dialog.

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

/// Icon for a raw alert type.
IconData notificationIconFor(Map<String, dynamic> alert) {
  final t = ((alert['type'] as String?) ?? '').toLowerCase();
  if (t.contains('void')) return Icons.cancel_rounded;
  if (t.contains('restock')) return Icons.inventory_2_outlined;
  if (t.contains('low')) return Icons.warning_amber_rounded;
  return Icons.notifications_outlined;
}

/// Avatar colors for a raw alert type.
class NotificationTone {
  const NotificationTone(this.fg, this.bg);
  final Color fg;
  final Color bg;
}

NotificationTone notificationToneFor(Map<String, dynamic> alert) {
  final t = ((alert['type'] as String?) ?? '').toLowerCase();
  if (t.contains('void')) return const NotificationTone(AppColors.danger, AppColors.dangerBg);
  if (t.contains('restock')) return const NotificationTone(AppColors.info, AppColors.infoBg);
  if (t.contains('low')) return const NotificationTone(AppColors.warn, AppColors.warnBg);
  return const NotificationTone(AppColors.primary, AppColors.primaryTint);
}

/// Short relative time, such as `just now`, `7m ago`, `3h ago`, `2d ago`.
String notificationRelativeTime(String? iso) {
  final dt = DateTime.tryParse(iso ?? '');
  if (dt == null) return '';
  final diff = DateTime.now().difference(dt);
  if (diff.inMinutes < 1) return 'just now';
  if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
  if (diff.inHours < 24) return '${diff.inHours}h ago';
  return '${diff.inDays}d ago';
}

/// "3 new" pill shown in the notification headers when there is unread news.
class NotificationUnreadPill extends StatelessWidget {
  const NotificationUnreadPill(this.count, {super.key});

  final int count;

  @override
  Widget build(BuildContext context) {
    if (count <= 0) return const SizedBox.shrink();
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: AppColors.primaryTint,
        borderRadius: BorderRadius.circular(AppRadius.pill),
        border: Border.all(
          color: AppColors.primary.withValues(alpha: 0.35),
        ),
      ),
      child: Text(
        '$count new',
        style: const TextStyle(
          color: AppColors.primary,
          fontSize: 11,
          fontWeight: FontWeight.w800,
          letterSpacing: 0.02,
        ),
      ),
    );
  }
}

/// Friendly empty state shared by both lists.
class NotificationEmptyState extends StatelessWidget {
  const NotificationEmptyState({super.key});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 28, horizontal: 24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 64,
            height: 64,
            decoration: BoxDecoration(
              color: AppColors.primaryTint,
              shape: BoxShape.circle,
            ),
            child: const Icon(
              Icons.notifications_none_rounded,
              size: 30,
              color: AppColors.primary,
            ),
          ),
          const SizedBox(height: 12),
          const Text(
            'All caught up!',
            style: TextStyle(fontWeight: FontWeight.w800, fontSize: 16),
          ),
          const SizedBox(height: 4),
          Text(
            'Restock updates, void decisions and low-stock alerts will show up here.',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: AppColors.muted,
                ),
          ),
        ],
      ),
    );
  }
}
