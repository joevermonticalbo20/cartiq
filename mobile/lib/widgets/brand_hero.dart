import 'package:flutter/material.dart';

import '../theme.dart';

/// Shared CartIQ brand hero: gradient CQ mark, title, yellow rule, tagline.
/// Used by the boot splash. (The login screen shows assets/logo.png instead.)
class BrandHero extends StatelessWidget {
  const BrandHero({super.key, this.compact = false});

  final bool compact;

  @override
  Widget build(BuildContext context) {
    final markSize = compact ? 52.0 : 64.0;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: markSize,
          height: markSize,
          decoration: BoxDecoration(
            gradient: const LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [AppColors.primary, Color(0xFFD4A82F)],
            ),
            borderRadius: BorderRadius.circular(18),
            boxShadow: [
              BoxShadow(
                color: AppColors.primary.withValues(alpha: 0.3),
                blurRadius: 16,
                offset: const Offset(0, 6),
              ),
            ],
          ),
          child: Center(
            child: Text(
              'CQ',
              style: TextStyle(
                color: Colors.white,
                fontSize: compact ? 20 : 24,
                fontWeight: FontWeight.w900,
              ),
            ),
          ),
        ),
        SizedBox(height: compact ? 10 : 14),
        Text(
          'CartIQ',
          style: (compact
                  ? Theme.of(context).textTheme.headlineSmall
                  : Theme.of(context).textTheme.headlineMedium)
              ?.copyWith(
            color: AppColors.primary,
            fontWeight: FontWeight.w800,
            letterSpacing: -0.5,
          ),
        ),
        Container(
          width: 44,
          height: 4,
          margin: const EdgeInsets.symmetric(vertical: 8),
          decoration: BoxDecoration(
            color: AppColors.highlight,
            borderRadius: BorderRadius.circular(4),
          ),
        ),
        Text(
          'Pota Fries Operations',
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ],
    );
  }
}
