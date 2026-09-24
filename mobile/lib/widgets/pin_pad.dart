import 'package:flutter/material.dart';

import '../theme.dart';
import '../utils/haptics.dart';

/// Six-digit PIN pad shown in a bottom sheet or inline.
///
/// Calls [onComplete] with the 6 digits (no validation here — the caller
/// verifies). Shows [errorText] with a shake when set. Haptic tap per digit.
class PinPad extends StatefulWidget {
  const PinPad({
    super.key,
    required this.onComplete,
    this.errorText,
    this.title = 'Enter PIN',
  });

  final ValueChanged<String> onComplete;
  final String? errorText;
  final String title;

  @override
  State<PinPad> createState() => _PinPadState();
}

class _PinPadState extends State<PinPad> with SingleTickerProviderStateMixin {
  String _digits = '';
  late final AnimationController _shake;

  @override
  void initState() {
    super.initState();
    _shake = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 400),
    );
  }

  @override
  void didUpdateWidget(PinPad oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.errorText != null &&
        widget.errorText != oldWidget.errorText) {
      _shake.forward(from: 0);
      Haptics.error();
    }
  }

  @override
  void dispose() {
    _shake.dispose();
    super.dispose();
  }

  void _press(String d) {
    if (_digits.length >= 6) return;
    Haptics.select();
    setState(() => _digits += d);
    if (_digits.length == 6) {
      final done = _digits;
      // Clear after the frame so dots visibly fill before proceeding.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        setState(() => _digits = '');
        widget.onComplete(done);
      });
    }
  }

  void _backspace() {
    if (_digits.isEmpty) return;
    Haptics.select();
    setState(() => _digits = _digits.substring(0, _digits.length - 1));
  }

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return AnimatedBuilder(
      animation: _shake,
      builder: (context, child) {
        final dx = _shake.value < 1
            ? 8 *
                (1 - _shake.value) *
                [0, 1, 0, -1, 0][(_shake.value * 5).floor().clamp(0, 4)]
            : 0.0;
        return Transform.translate(offset: Offset(dx, 0), child: child);
      },
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(widget.title, style: textTheme.titleLarge),
          const SizedBox(height: AppSpacing.space4),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: List.generate(6, (i) {
              final filled = i < _digits.length;
              return Container(
                width: 16,
                height: 16,
                margin: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.space2),
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: filled
                      ? AppColors.primary
                      : Theme.of(context).dividerColor.withValues(alpha: 0.4),
                ),
              );
            }),
          ),
          if (widget.errorText != null) ...[
            const SizedBox(height: AppSpacing.space3),
            Text(
              widget.errorText!,
              style: textTheme.bodySmall?.copyWith(
                color: AppColors.danger,
                fontWeight: FontWeight.w600,
              ),
              textAlign: TextAlign.center,
            ),
          ],
          const SizedBox(height: AppSpacing.space4),
          for (final row in [
            ['1', '2', '3'],
            ['4', '5', '6'],
            ['7', '8', '9'],
            ['', '0', 'back'],
          ])
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceEvenly,
              children: row.map((k) {
                if (k.isEmpty) return const SizedBox(width: 72, height: 72);
                if (k == 'back') {
                  return SizedBox(
                    width: 72,
                    height: 72,
                    child: IconButton(
                      onPressed: _backspace,
                      icon: const Icon(Icons.backspace_outlined),
                      tooltip: 'Delete',
                    ),
                  );
                }
                return SizedBox(
                  width: 72,
                  height: 72,
                  child: TextButton(
                    onPressed: () => _press(k),
                    style: TextButton.styleFrom(
                      shape: const CircleBorder(),
                      textStyle: const TextStyle(
                          fontSize: 24, fontWeight: FontWeight.w600),
                    ),
                    child: Text(k),
                  ),
                );
              }).toList(),
            ),
        ],
      ),
    );
  }
}
