import 'package:flutter/material.dart';

import '../services/rfid_registration.dart';
import '../theme.dart';

/// The "tap your RFID card" prompt.
///
/// Registration happens on the cart's reader (ESP32 + MFRC522), not on the
/// phone, so this dialog cannot read anything itself - it opens a claim and
/// shows progress while the person walks over to the reader. Dismissing is
/// always allowed: Settings keeps a permanent way back in.
class RfidClaimDialog extends StatefulWidget {
  const RfidClaimDialog({
    super.key,
    required this.token,
    required this.registration,
    this.locationCode,
    this.event,
    this.title = 'Tap your RFID card',
    this.message,
  });

  final String token;
  final RfidRegistrationService registration;

  /// Only an owner needs this; staff always register on their own cart.
  final String? locationCode;

  /// `"IN"` / `"OUT"` when clocking on or off; null when only enrolling a card.
  final String? event;

  final String title;
  final String? message;

  /// Run the claim and resolve to its outcome, or null when the person
  /// dismissed the dialog (the claim is then left to expire on the server).
  static Future<RfidClaimResult?> show(
    BuildContext context, {
    required String token,
    required RfidRegistrationService registration,
    String? locationCode,
    String? event,
    String title = 'Tap your RFID card',
    String? message,
  }) {
    return showDialog<RfidClaimResult>(
      context: context,
      // Dismissible on purpose: someone who cannot find the reader must not be
      // trapped here. Settings always offers a way back.
      barrierDismissible: true,
      builder: (_) => RfidClaimDialog(
        token: token,
        registration: registration,
        locationCode: locationCode,
        event: event,
        title: title,
        message: message,
      ),
    );
  }

  @override
  State<RfidClaimDialog> createState() => _RfidClaimDialogState();
}

class _RfidClaimDialogState extends State<RfidClaimDialog> {
  // null until the server has opened the claim.
  int? _secondsLeft;
  String? _error;

  @override
  void initState() {
    super.initState();
    _run();
  }

  Future<void> _run() async {
    final result = await widget.registration.register(
      token: widget.token,
      locationCode: widget.locationCode,
      event: widget.event,
      onTick: (seconds) {
        if (!mounted) return;
        setState(() {
          _secondsLeft = seconds;
          _error = null;
        });
      },
    );
    if (!mounted) return;
    if (result is RfidFailed) {
      // Stay open on a failure so the reason is readable, and let the person
      // retry without losing the dialog.
      setState(() => _error = result.message);
      return;
    }
    Navigator.of(context).pop(result);
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final waiting = _error == null;
    return AlertDialog(
      title: Text(widget.title),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            widget.message ??
                'Hold your staff card against the reader on the cart to clock in and out without typing.',
          ),
          const SizedBox(height: AppSpacing.space4),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (waiting) ...[
                const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
                const SizedBox(width: 12),
              ] else ...[
                Icon(Icons.error_outline, color: scheme.error, size: 18),
                const SizedBox(width: 12),
              ],
              Expanded(
                child: Text(
                  _error ??
                      (_secondsLeft == null
                          ? 'Connecting to the cart reader...'
                          : 'Waiting for your card'
                                '${_secondsLeft! <= 5 ? '' : '   ${_secondsLeft!}s left'}'),
                  style: _error == null
                      ? null
                      : TextStyle(color: scheme.error),
                ),
              ),
            ],
          ),
        ],
      ),
      actions: [
        TextButton(
          style: TextButton.styleFrom(minimumSize: const Size(0, 48)),
          onPressed: () => Navigator.of(context).pop(),
          child: Text(waiting ? 'Not now' : 'Close'),
        ),
      ],
    );
  }
}