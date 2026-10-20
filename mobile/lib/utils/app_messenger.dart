import 'dart:async';
import 'dart:io';
import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';

import '../services/auth_state.dart';
import '../services/api_client.dart';
import '../services/offline_pin.dart';
import '../theme.dart';
import '../widgets/pin_pad.dart';

class AppMessenger {
  AppMessenger._();

  static String messageFor(Object error) {
    if (error is ApiException) {
      if (error.statusCode == 401) return ApiClient.sessionExpiredMessage;
      if (error.statusCode == 500 ||
          error.statusCode == 502 ||
          error.statusCode == 503) {
        return ApiClient.unavailableMessage;
      }
      if (error.statusCode == 403) return ApiClient.permissionDeniedMessage;
      if (error.statusCode == 429) return ApiClient.rateLimitedMessage;
      if (error.statusCode == 409 && error.code != 'INSUFFICIENT_STOCK') {
        return ApiClient.conflictMessage;
      }
      return error.message;
    }
    if (error is TimeoutException) return ApiClient.timeoutMessage;
    if (error is SocketException || error is http.ClientException) {
      return ApiClient.noInternetMessage;
    }
    return 'Something went wrong. Please try again.';
  }

  static void showErrorSnackBar({
    required BuildContext context,
    required Object error,
    VoidCallback? onRetry,
    VoidCallback? onOfflinePin,
  }) {
    if (!context.mounted) return;
    if (messageFor(error) == ApiClient.noInternetMessage) return;
    final sessionExpired = error is ApiException && error.statusCode == 401;
    final action = sessionExpired
        ? onOfflinePin ?? () => _openOfflinePin(context)
        : onRetry;
    final actionLabel = sessionExpired ? 'Offline PIN' : 'Retry';
    final messenger = ScaffoldMessenger.of(context);
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(messageFor(error)),
          duration: const Duration(seconds: 8),
          action: action == null
              ? null
              : SnackBarAction(label: actionLabel, onPressed: action),
        ),
      );
  }

  static Future<void> _openOfflinePin(BuildContext context) async {
    final auth = context.read<AuthState>();
    final eligibility = await auth.checkOfflineEligibility();
    if (!context.mounted) return;
    if (!eligibility.eligible) {
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(SnackBar(content: Text(eligibility.message)));
      return;
    }

    String? error;
    var verifying = false;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) => StatefulBuilder(
        builder: (context, setSheetState) => SafeArea(
          child: Padding(
            padding: EdgeInsets.only(
              left: AppSpacing.space5,
              right: AppSpacing.space5,
              top: AppSpacing.space4,
              bottom:
                  MediaQuery.of(context).viewInsets.bottom + AppSpacing.space6,
            ),
            child: PinPad(
              title: 'Offline PIN',
              errorText: error,
              onComplete: (value) async {
                if (verifying) return;
                setSheetState(() {
                  verifying = true;
                  error = null;
                });
                try {
                  await auth.unlockOffline(value);
                  if (sheetContext.mounted) Navigator.pop(sheetContext);
                } on PinException catch (exception) {
                  setSheetState(() {
                    verifying = false;
                    error = exception.message;
                  });
                } catch (_) {
                  setSheetState(() {
                    verifying = false;
                    error =
                        'Could not verify the Offline PIN on this device. Please log in online.';
                  });
                }
              },
            ),
          ),
        ),
      ),
    );
  }

  static void showRecoverySnackBar({
    required BuildContext context,
    required String message,
    required String actionLabel,
    required VoidCallback onAction,
  }) {
    if (!context.mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(message),
          duration: const Duration(seconds: 8),
          action: SnackBarAction(label: actionLabel, onPressed: onAction),
        ),
      );
  }

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
    _slide = Tween<Offset>(begin: const Offset(0, 0.16), end: Offset.zero)
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
                          crossAxisAlignment: CrossAxisAlignment.center,
                          children: [
                            Icon(icon, color: textColor, size: 22),
                            const SizedBox(width: 12),
                            Flexible(
                              child: Text(
                                widget.message,
                                textAlign: TextAlign.center,
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
    );
  }
}
