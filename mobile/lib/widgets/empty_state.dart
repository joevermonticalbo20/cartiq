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
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final borderColor = isError
        ? AppColors.danger
        : Theme.of(context).dividerColor;
    final iconColor = isError ? AppColors.danger : AppColors.primary;
    final displayIcon =
        isError &&
            (icon == Icons.receipt_long_rounded || icon == Icons.receipt_long)
        ? Icons.error_outline_rounded
        : icon;
    final bgColor = isDark
        ? Colors.white.withValues(alpha: 0.02)
        : Colors.black.withValues(alpha: 0.02);

    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: EdgeInsets.symmetric(
        horizontal: AppSpacing.space6,
        vertical: compact ? 32 : 64,
      ),
      children: [
        Center(
          child: CustomPaint(
            painter: _DashedBorderPainter(
              color: borderColor,
              radius: AppRadius.xl,
            ),
            child: Container(
              width: double.infinity,
              padding: EdgeInsets.symmetric(
                horizontal: AppSpacing.space5,
                vertical: compact ? AppSpacing.space6 : AppSpacing.space8,
              ),
              decoration: BoxDecoration(
                color: bgColor,
                borderRadius: BorderRadius.circular(AppRadius.xl),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Premium double-ring icon container (Web App Aesthetic)
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
                    Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: AppSpacing.space4,
                      ),
                      child: Text(
                        subtitle!,
                        textAlign: TextAlign.center,
                        style: Theme.of(
                          context,
                        ).textTheme.bodySmall?.copyWith(height: 1.4),
                      ),
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
          ),
        ),
      ],
    );
  }
}

/// Custom dashed border na madalas gamitin sa mga web app placeholders
class _DashedBorderPainter extends CustomPainter {
  final Color color;
  final double radius;

  _DashedBorderPainter({required this.color, required this.radius});

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..strokeWidth = 1.5
      ..style = PaintingStyle.stroke;

    final path = Path()
      ..addRRect(
        RRect.fromRectAndRadius(
          Rect.fromLTWH(0, 0, size.width, size.height),
          Radius.circular(radius),
        ),
      );

    final dashedPath = Path();
    const dashWidth = 6.0;
    const dashSpace = 6.0;

    for (final metric in path.computeMetrics()) {
      var distance = 0.0;
      var draw = true;
      while (distance < metric.length) {
        final len = draw ? dashWidth : dashSpace;
        if (draw) {
          dashedPath.addPath(
            metric.extractPath(distance, distance + len),
            Offset.zero,
          );
        }
        distance += len;
        draw = !draw;
      }
    }
    canvas.drawPath(dashedPath, paint);
  }

  @override
  bool shouldRepaint(covariant _DashedBorderPainter oldDelegate) {
    return oldDelegate.color != color || oldDelegate.radius != radius;
  }
}
