import 'package:flutter/material.dart';

import '../theme.dart';
import 'notification_style.dart';

/// One row in the in-app notification lists (Home sheet, Settings).
/// Tinted avatar per type, unread dot, unread/read weight difference, and
/// relative time trailing with a read check.
class NotificationTile extends StatelessWidget {
  const NotificationTile({
    super.key,
    required this.alert,
    required this.onTap,
  });

  final Map<String, dynamic> alert;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final isRead = alert['isRead'] == true;
    final title = (alert['title']?.toString() ?? '').trim();
    final message = (alert['message']?.toString() ?? '').trim();
    final time = notificationRelativeTime(alert['createdAt']?.toString());
    final tone = notificationToneFor(alert);
    final typeLabel = notificationTypeLabel(alert);

    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.space4,
          vertical: AppSpacing.space3,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _Avatar(tone: tone, icon: notificationIconFor(alert), isRead: isRead),
            const SizedBox(width: AppSpacing.space3),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    title.isNotEmpty ? title : typeLabel,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontWeight: isRead ? FontWeight.w600 : FontWeight.w800,
                      fontSize: 14.5,
                      color: isRead
                          ? Theme.of(context).textTheme.bodyMedium?.color!.withValues(alpha: 0.55)
                          : Theme.of(context).textTheme.bodyMedium?.color,
                    ),
                  ),
                  if (message.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      message,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12.5,
                        height: 1.35,
                        color: AppColors.muted.withValues(alpha: isRead ? 0.75 : 1),
                      ),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(width: AppSpacing.space3),
            Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  time,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        fontSize: 11,
                        color: AppColors.muted,
                      ),
                ),
                if (isRead) ...[
                  const SizedBox(height: 4),
                  Icon(
                    Icons.check_circle_outline,
                    size: 15,
                    color: AppColors.muted.withValues(alpha: 0.8),
                  ),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _Avatar extends StatelessWidget {
  const _Avatar({
    required this.tone,
    required this.icon,
    required this.isRead,
  });

  final NotificationTone tone;
  final IconData icon;
  final bool isRead;

  @override
  Widget build(BuildContext context) {
    final fg = isRead ? Theme.of(context).disabledColor : tone.fg;
    final bg = isRead
        ? Theme.of(context).dividerColor.withValues(alpha: 0.45)
        : tone.bg;
    return SizedBox(
      width: 40,
      height: 40,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(color: bg, shape: BoxShape.circle),
            child: Icon(icon, size: 20, color: fg),
          ),
          if (!isRead)
            Positioned(
              top: -2,
              right: -2,
              child: Container(
                width: 12,
                height: 12,
                decoration: BoxDecoration(
                  color: AppColors.primary,
                  shape: BoxShape.circle,
                  border: Border.all(
                    color: Theme.of(context).scaffoldBackgroundColor,
                    width: 2,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
