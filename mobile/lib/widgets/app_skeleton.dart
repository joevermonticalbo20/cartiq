import 'package:flutter/material.dart';
import '../theme.dart';

/// Reusable skeleton loading state na may modern pulsing animation.
/// Automatically adapts: Card-style kung walang height, simple box kung may height.
class AppSkeleton extends StatefulWidget {
  const AppSkeleton({super.key, this.rows = 5, this.height});

  final int rows;
  final double? height;

  @override
  State<AppSkeleton> createState() => _AppSkeletonState();
}

class _AppSkeletonState extends State<AppSkeleton>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  late Animation<double> _animation;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      duration: const Duration(milliseconds: 1000),
      vsync: this,
    )..repeat(reverse: true);

    // I-animate lang ang alpha value para sa mga gray boxes
    _animation = Tween<double>(
      begin: 0.04,
      end: 0.12,
    ).animate(CurvedAnimation(parent: _controller, curve: Curves.easeInOut));
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final surfaceColor = Theme.of(context).colorScheme.surface;
    final isDark = Theme.of(context).brightness == Brightness.dark;

    // Gumamit ng AnimatedBuilder para gray boxes lang ang nag-pa-pulse
    // at hindi maapektuhan ang solid na puting card at ang shadow nito.
    return AnimatedBuilder(
      animation: _animation,
      builder: (context, child) {
        final baseColor = isDark
            ? Colors.white.withValues(alpha: _animation.value)
            : Colors.black.withValues(alpha: _animation.value);

        return Column(
          children: List.generate(widget.rows, (index) {
            // Custom height para sa simpleng text skeletons (e.g. HomeScreen)
            if (widget.height != null) {
              return Container(
                margin: const EdgeInsets.only(bottom: AppSpacing.space2),
                width: double.infinity,
                height: widget.height,
                decoration: BoxDecoration(
                  color: baseColor,
                  borderRadius: BorderRadius.circular(AppRadius.xs),
                ),
              );
            }

            // Default: Perfect Card Skeleton (kopyang-kopya ang History/Receipts)
            return Container(
              margin: const EdgeInsets.only(bottom: AppSpacing.space2),
              decoration: BoxDecoration(
                color: surfaceColor,
                borderRadius: BorderRadius.circular(AppRadius.l),
                boxShadow: AppShadow.sm(), // Solid, identical shadow
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.space4,
                  vertical: AppSpacing.space3,
                ),
                child: Row(
                  children: [
                    // Leading Icon
                    Container(
                      width: 44,
                      height: 44,
                      decoration: BoxDecoration(
                        color: baseColor,
                        borderRadius: BorderRadius.circular(AppRadius.s),
                      ),
                    ),
                    const SizedBox(width: AppSpacing.space3),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              // Price placeholder
                              Container(
                                width: 56,
                                height: 18,
                                decoration: BoxDecoration(
                                  color: baseColor,
                                  borderRadius: BorderRadius.circular(
                                    AppRadius.xs,
                                  ),
                                ),
                              ),
                              const SizedBox(width: 8),
                              // Item count placeholder
                              Container(
                                width: 64,
                                height: 14,
                                decoration: BoxDecoration(
                                  color: baseColor,
                                  borderRadius: BorderRadius.circular(
                                    AppRadius.xs,
                                  ),
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 6),
                          // Description/Items placeholder
                          Container(
                            width: double.infinity,
                            height: 14,
                            decoration: BoxDecoration(
                              color: baseColor,
                              borderRadius: BorderRadius.circular(AppRadius.xs),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 12),
                    // Chevron Trailing
                    Icon(
                      Icons.chevron_right_rounded,
                      size: 20,
                      color: baseColor,
                    ),
                  ],
                ),
              ),
            );
          }),
        );
      },
    );
  }
}
