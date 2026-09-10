import 'package:flutter/material.dart';

import '../theme.dart';

/// Shimmer loading placeholder mirroring web `Skeleton`.
/// Pulses soft bars; use for list rows/cards while content loads.
class AppSkeleton extends StatelessWidget {
  const AppSkeleton({
    super.key,
    this.rows = 4,
    this.height = 14,
    this.padding = const EdgeInsets.symmetric(vertical: 4),
  });

  final int rows;
  final double height;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: List.generate(
        rows,
        (i) => Padding(
          padding: padding,
          child: _PulseBar(
            height: height,
            widthFactor: 0.95 - ((i * 13) % 40) / 100,
          ),
        ),
      ),
    );
  }
}

class _PulseBar extends StatefulWidget {
  const _PulseBar({required this.height, required this.widthFactor});

  final double height;
  final double widthFactor;

  @override
  State<_PulseBar> createState() => _PulseBarState();
}

class _PulseBarState extends State<_PulseBar>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 700),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final base = Theme.of(context).dividerColor;
    return FractionallySizedBox(
      alignment: Alignment.centerLeft,
      widthFactor: widget.widthFactor,
      child: AnimatedBuilder(
        animation: _controller,
        builder: (context, child) => Opacity(
          opacity: 0.45 + 0.4 * _controller.value,
          child: child,
        ),
        child: Container(
          height: widget.height,
          decoration: BoxDecoration(
            color: base,
            borderRadius: BorderRadius.circular(AppRadius.s),
          ),
        ),
      ),
    );
  }
}
