import 'dart:async';
import 'dart:ui';

import 'package:flutter/material.dart';

import '../theme.dart';

class AppMessenger {
  AppMessenger._();

  static OverlayEntry? _activeEntry;
  static Timer? _dismissTimer;

  static void showGlassToast({
    required BuildContext context,
    required String message,
    required bool isSuccess,
  }) {
    _dismissTimer?.cancel();
    _dismissTimer = null;
    _activeEntry?.remove();
    _activeEntry = null;

    if (!context.mounted) return;
    final overlay = Overlay.maybeOf(context, rootOverlay: true);
    if (overlay == null) return;

    final toastKey = GlobalKey<_GlassToastState>();
    late final OverlayEntry entry;
    entry = OverlayEntry(
      builder: (_) => _GlassToast(
        key: toastKey,
        message: message,
        isSuccess: isSuccess,
        onDismissed: () {
          if (identical(_activeEntry, entry)) {
            entry.remove();
            _activeEntry = null;
          }
        },
      ),
    );
    _activeEntry = entry;
    overlay.insert(entry);
    _dismissTimer = Timer(const Duration(seconds: 4), () {
      _dismissTimer = null;
      toastKey.currentState?.dismiss();
    });
  }
}

class _GlassToast extends StatefulWidget {
  const _GlassToast({
    super.key,
    required this.message,
    required this.isSuccess,
    required this.onDismissed,
  });

  final String message;
  final bool isSuccess;
  final VoidCallback onDismissed;

  @override
  State<_GlassToast> createState() => _GlassToastState();
}

class _GlassToastState extends State<_GlassToast>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late final Animation<Offset> _slide;
  late final Animation<double> _fade;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 850),
      reverseDuration: const Duration(milliseconds: 500),
    );
    _slide = Tween<Offset>(begin: const Offset(0, -1.6), end: Offset.zero)
        .animate(
          CurvedAnimation(
            parent: _controller,
            curve: Curves.elasticOut,
            reverseCurve: Curves.easeInOutCubic,
          ),
        );
    _fade = CurvedAnimation(
      parent: _controller,
      curve: Curves.easeOut,
      reverseCurve: Curves.easeInOutCubic,
    );
    _controller.forward();
  }

  void dismiss() {
    _controller.reverse().then((_) {
      if (mounted) widget.onDismissed();
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tint = widget.isSuccess ? AppColors.ok : AppColors.danger;
    final icon = widget.isSuccess
        ? Icons.check_circle_rounded
        : Icons.error_rounded;
    final textColor = widget.isSuccess
        ? const Color(0xFF14532D)
        : const Color(0xFF7F1D1D);

    return Positioned.fill(
      child: IgnorePointer(
        child: Stack(
          children: [
            Positioned(
              top: MediaQuery.paddingOf(context).top + 8,
              left: 0,
              right: 0,
              child: Center(
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: ConstrainedBox(
                    constraints: BoxConstraints(
                      maxWidth: MediaQuery.sizeOf(context).width - 32,
                    ),
                    child: FadeTransition(
                      opacity: _fade,
                      child: SlideTransition(
                        position: _slide,
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(28),
                          child: BackdropFilter(
                            filter: ImageFilter.blur(sigmaX: 18, sigmaY: 18),
                            child: DecoratedBox(
                              decoration: BoxDecoration(
                                color: Color.lerp(
                                  Colors.white.withValues(alpha: 0.76),
                                  tint.withValues(alpha: 0.78),
                                  0.24,
                                ),
                                borderRadius: BorderRadius.circular(28),
                                border: Border.all(
                                  color: Colors.white.withValues(alpha: 0.72),
                                  width: 1,
                                ),
                                boxShadow: [
                                  BoxShadow(
                                    color: Colors.black.withValues(alpha: 0.12),
                                    blurRadius: 24,
                                    offset: const Offset(0, 10),
                                  ),
                                ],
                              ),
                              child: Padding(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 18,
                                  vertical: 14,
                                ),
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  children: [
                                    Icon(icon, color: textColor, size: 22),
                                    const SizedBox(width: 12),
                                    Flexible(
                                      child: Text(
                                        widget.message,
                                        softWrap: true,
                                        overflow: TextOverflow.visible,
                                        style: TextStyle(
                                          color: textColor,
                                          fontSize: 14,
                                          fontWeight: FontWeight.w600,
                                          height: 1.3,
                                          decoration: TextDecoration.none,
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
