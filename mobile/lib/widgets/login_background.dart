import 'package:flutter/material.dart';

import '../theme.dart';

/// Login backdrop mirroring the web brand panel: 32px grid paper plus
/// soft pink/amber glows. Theme-aware (grid follows divider color).
class LoginBackground extends StatelessWidget {
  const LoginBackground({super.key});

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    return Stack(
      children: [
        const Positioned.fill(child: _GridPaper()),
        Positioned(
          top: -110,
          left: -70,
          child: _Glow(
            diameter: 300,
            color: AppColors.primary.withValues(alpha: dark ? 0.10 : 0.08),
          ),
        ),
        Positioned(
          bottom: -120,
          right: -70,
          child: _Glow(
            diameter: 340,
            color: AppColors.highlight.withValues(alpha: dark ? 0.10 : 0.14),
          ),
        ),
      ],
    );
  }
}

class _Glow extends StatelessWidget {
  const _Glow({required this.diameter, required this.color});

  final double diameter;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: diameter,
      height: diameter,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: RadialGradient(
          colors: [color, color.withValues(alpha: 0)],
        ),
      ),
    );
  }
}

class _GridPaper extends StatelessWidget {
  const _GridPaper();

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      size: Size.infinite,
      painter: _GridPainter(
        color: Theme.of(context).dividerColor.withValues(alpha: 0.4),
      ),
    );
  }
}

class _GridPainter extends CustomPainter {
  const _GridPainter({required this.color});

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    const step = 32.0;
    final paint = Paint()
      ..color = color
      ..strokeWidth = 1;
    for (var x = 0.0; x <= size.width; x += step) {
      canvas.drawLine(Offset(x, 0), Offset(x, size.height), paint);
    }
    for (var y = 0.0; y <= size.height; y += step) {
      canvas.drawLine(Offset(0, y), Offset(size.width, y), paint);
    }
  }

  @override
  bool shouldRepaint(covariant _GridPainter oldDelegate) =>
      oldDelegate.color != color;
}
