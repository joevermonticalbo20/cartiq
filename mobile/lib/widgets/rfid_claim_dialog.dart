import 'dart:async';

import 'package:flutter/material.dart';

import '../services/rfid_registration.dart';
import '../theme.dart';
import '../utils/haptics.dart';

/// The "tap your RFID card" prompt.
///
/// Registration happens on the cart's reader (ESP32 + MFRC522), not on the
/// phone, so this dialog cannot read anything itself - it opens a claim and
/// shows progress while the person walks over to the reader. For IN/OUT
/// clocking claims the dialog cannot be dismissed by tapping outside (or by
/// the system back gesture): only the explicit "Not now" button closes it.
class RfidClaimDialog extends StatefulWidget {
  const RfidClaimDialog({
    super.key,
    required this.token,
    required this.registration,
    this.locationCode,
    this.event,
    this.title = 'Tap your RFID card',
    this.message,
    this.onBound,
  });

  final String token;
  final RfidRegistrationService registration;

  /// Fired when the server reports the tap bound a card, before the dialog
  /// pops, so the session state updates in place. The dialog itself never
  /// persists anything.
  final Future<void> Function(String rfidUid)? onBound;

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
    Future<void> Function(String rfidUid)? onBound,
  }) {
    return showDialog<RfidClaimResult>(
      context: context,
      // IN/OUT claims cannot be dismissed by tapping outside: the vendor must
      // make a deliberate choice ("Not now") instead of accidentally bumping
      // the shift off. Card enrollments stay light-dismissable.
      barrierDismissible: event == null,
      builder: (_) => RfidClaimDialog(
        token: token,
        registration: registration,
        locationCode: locationCode,
        event: event,
        title: title,
        message: message,
        onBound: onBound,
      ),
    );
  }

  @override
  State<RfidClaimDialog> createState() => _RfidClaimDialogState();
}

class _RfidClaimDialogState extends State<RfidClaimDialog> {
  // null until the server has opened the claim.
  int? _secondsLeft;
  int? _totalSeconds;
  String? _error;
  Timer? _countdownTimer;
  Timer? _escalationTimer;
  Timer? _autoDismissTimer;
  bool _readerOnline = false;
  int? _readerLastSeen; // seconds since the cart reader last heartbeated
  bool _readerLost = false; // was online mid-wait, then dropped
  bool _escalated = false; // been stuck "connecting" for 45s+
  DateTime? _connectingSince; // when the reader went offline during this claim
  String? _resultText; // non-null once the claim resolved successfully

  @override
  void initState() {
    super.initState();
    Haptics.tap();
    _run();
  }

  @override
  void dispose() {
    _countdownTimer?.cancel();
    _escalationTimer?.cancel();
    _autoDismissTimer?.cancel();
    super.dispose();
  }

  /// Local 1s ticker so the number drops by exactly 1 every second even when
  /// the status poll is slow (a poll round-trip longer than a second would
  /// otherwise make the wall-clock value leap by 2). Each [onTick] (the
  /// authoritative server expiry) resyncs [_secondsLeft]; between polls the
  /// timer simply decrements. It starts only after the first server tick —
  /// i.e. once the reader is confirmed online — and stops with the dialog.
  void _startCountdown() {
    _countdownTimer ??= Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted || _secondsLeft == null) return;
      final next = _secondsLeft! - 1;
      setState(() => _secondsLeft = next < 0 ? 0 : next);
    });
  }

  /// Reset and re-run the claim (the Retry button on a failure).
  void _retry() {
    _countdownTimer?.cancel();
    _escalationTimer?.cancel();
    _autoDismissTimer?.cancel();
    setState(() {
      _secondsLeft = null;
      _totalSeconds = null;
      _error = null;
      _readerOnline = false;
      _readerLost = false;
      _escalated = false;
      _connectingSince = null;
      _resultText = null;
    });
    _run();
  }

  void _onReaderStatus(bool connected, int? lastSeenSeconds) {
    if (!mounted) return;
    final now = DateTime.now();
    setState(() {
      if (connected) {
        _readerOnline = true;
        _readerLost = false;
        _connectingSince = null;
        _escalated = false;
        _escalationTimer?.cancel();
        // Resume the local ticker (it had been paused while offline).
        _startCountdown();
      } else {
        // The countdown was already running - the reader had been online -
        // so this is a mid-wait disconnect: surface it instead of letting
        // the person keep watching a dead spinner behind the Wi-Fi icon.
        if (_secondsLeft != null) {
          _readerLost = true;
          // Pause the local ticker so the number doesn't drain while the
          // person is staring at the "lost connection" message. The server's
          // expiry is the authoritative source on every reconnect tick.
          _countdownTimer?.cancel();
          _countdownTimer = null;
        }
        _readerOnline = false;
        _connectingSince ??= now;
        _escalationTimer ??=
            Timer(const Duration(seconds: 15), () {
          if (mounted) setState(() => _escalated = true);
        });
      }
      _readerLastSeen = lastSeenSeconds;
    });
  }

  /// The message shown for a terminal attempt, non-null when the dialog must
  /// stay open for the person to read it. Null for a clean (recorded) bound.
  String? _outcomeMessage(RfidClaimResult result) {
    switch (result) {
      case RfidBound():
        return null;
      case RfidFailed(:final message):
        return message;
      case RfidRefused(:final reason):
        if (reason.isNotEmpty) return reason;
        return widget.event == 'OUT'
            ? 'Card read, but no time-out recorded.'
            : 'Card read, but no time-in recorded.';
      case RfidUnbound():
        return 'Card removed from this account.';
      case RfidConflict(:final holderName):
        return holderName.isEmpty
            ? 'That card is already registered to someone else.'
            : 'That card already belongs to $holderName.';
      case RfidUnregistered():
        return 'This card is not registered to anyone here.';
      case RfidWrongCart(:final cardLocationCode):
        return cardLocationCode.isEmpty
            ? 'This card belongs to another cart.'
            : 'This card is registered at $cardLocationCode.';
      case RfidAlreadyRegistered():
        return 'This card is already registered.';
      case RfidExpired():
        return 'No card tapped in time.';
      case RfidNoShift():
        return widget.event == 'OUT'
            ? 'Card read, but no time-out recorded.'
            : 'Card read, but no time-in recorded.';
    }
  }

  Future<void> _run() async {
    final result = await widget.registration.register(
      token: widget.token,
      locationCode: widget.locationCode,
      event: widget.event,
      onTick: (seconds) {
        if (!mounted) return;
        _startCountdown();
        setState(() {
          _totalSeconds ??= seconds;
          _secondsLeft = seconds;
          _error = null;
        });
      },
      onReaderStatus: _onReaderStatus,
    );
    if (!mounted) return;
    switch (result) {
      case RfidBound():
        unawaited(Haptics.success());
        if (widget.onBound != null) {
          try {
            await widget.onBound!(result.rfidUid);
          } catch (_) {}
          if (!mounted) return;
        }
        setState(() {
          _resultText = result.event == 'IN'
              ? 'Time in recorded'
              : result.event == 'OUT'
                  ? 'Time out recorded'
                  : 'Card registered';
        });
        _autoDismissTimer ??= Timer(const Duration(milliseconds: 1400), () {
          if (!mounted) return;
          Navigator.of(context).pop(result);
        });
      default:
        setState(() => _error = _outcomeMessage(result) ?? 'Registration failed.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final isClock = widget.event != null;
    final succeeded = _resultText != null;
    final failed = _error != null;
    final readerLost = !succeeded && !failed && _readerLost;
    final connecting = !succeeded && !failed && !_readerOnline && !readerLost;
    final urgent = (_secondsLeft ?? 99) <= 5;

    Widget body;
    if (succeeded) {
      body = _SuccessPane(text: _resultText!);
    } else if (readerLost) {
      body = _ReaderLostPane(lastSeenSeconds: _readerLastSeen);
    } else if (connecting) {
      body = _ConnectingPane(
        escalated: _escalated,
        lastSeenSeconds: _readerLastSeen,
        onRetry: _escalated ? _retry : null,
      );
    } else if (failed) {
      body = _FailurePane(message: _error!);
    } else {
      // The reader is online and the 30s server window is ticking.
      final left = _secondsLeft ?? 0;
      final total = _totalSeconds ?? (left > 0 ? left : 30);
      body = Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text.rich(
                  TextSpan(
                    text: 'Waiting for your card ',
                    children: [
                      TextSpan(
                        text: '${left}s left',
                        style: TextStyle(
                          fontWeight: FontWeight.w800,
                          color: urgent ? scheme.error : null,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.space3),
          ClipRRect(
            borderRadius: BorderRadius.circular(AppRadius.pill),
            child: LinearProgressIndicator(
              value: total > 0 ? (left / total).clamp(0, 1) : null,
              minHeight: 6,
              backgroundColor: scheme.onSurface.withValues(alpha: 0.08),
              valueColor: AlwaysStoppedAnimation(
                urgent ? scheme.error : AppColors.primary,
              ),
            ),
          ),
        ],
      );
    }

    return PopScope(
      // Only a deliberate "Not now" wins out for clock claims; anything else
      // must go through the reader.
      canPop: !isClock,
      child: AlertDialog(
      title: Text(widget.title),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (succeeded)
              const SizedBox.shrink()
            else
              Text(
                widget.message ??
                    (widget.event == null
                        ? 'Hold your staff card against the reader on the cart to register it to your staff account. This tap only registers the card and does not log a shift.'
                        : 'Hold your staff card against the reader on the cart to clock in and out without typing.'),
              ),
            const SizedBox(height: AppSpacing.space4),
            body,
          ],
        ),
      ),
      actions: succeeded
          ? const []
          : [
              if (_escalated || failed || readerLost)
                TextButton(
                  style: TextButton.styleFrom(minimumSize: const Size(0, 48)),
                  onPressed: _retry,
                  child: const Text('Retry'),
                ),
              TextButton(
                style: TextButton.styleFrom(minimumSize: const Size(0, 48)),
                onPressed: () => Navigator.of(context).pop(),
                child: Text(failed ? 'Close' : 'Not now'),
              ),
            ],
    ),
  );
  }
}

/// Reader is unreachable / still joining Wi-Fi. The countdown stays paused;
/// escalate after 45s with an actionable message and a Retry.
class _ConnectingPane extends StatelessWidget {
  const _ConnectingPane({
    required this.escalated,
    required this.lastSeenSeconds,
    required this.onRetry,
  });

  final bool escalated;
  final int? lastSeenSeconds;
  final VoidCallback? onRetry;

  String _lastSeenLabel() {
    if (lastSeenSeconds == null) return 'The reader has never been online.';
    if (lastSeenSeconds! < 90) return 'Reader last seen a few seconds ago.';
    final minutes = (lastSeenSeconds! / 60).round();
    return 'Reader last seen about $minutes min ago.';
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                escalated
                    ? 'The cart reader is still offline'
                    : 'The cart reader is connecting to Wi-Fi…',
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.space2),
        Text(
          escalated
              ? 'Check that the cart is plugged in and online. Your attendance will record as soon as the reader is back, or you can tap Retry.'
              : 'Almost there. Your attendance records the moment the card reader is ready.',
          style: textTheme.bodySmall,
        ),
        const SizedBox(height: AppSpacing.space2),
        Row(
          children: [
            Icon(Icons.sensors_rounded, size: 14, color: scheme.onSurface.withValues(alpha: 0.6)),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                _lastSeenLabel(),
                style: textTheme.bodySmall?.copyWith(
                  color: scheme.onSurface.withValues(alpha: 0.65),
                ),
              ),
            ),
          ],
        ),
      ],
    );
  }
}

/// Something went wrong. The server's exact words stay on screen; Retry
/// reopens the claim, Close dismisses.
class _FailurePane extends StatelessWidget {
  const _FailurePane({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(Icons.error_outline, color: scheme.error, size: 18),
        const SizedBox(width: 12),
        Expanded(
          child: Text(message, style: TextStyle(color: scheme.error)),
        ),
      ],
    );
  }
}

/// The tap landed and the shift was recorded.
class _SuccessPane extends StatelessWidget {
  const _SuccessPane({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        const Icon(Icons.check_circle_rounded, color: AppColors.ok, size: 30),
        const SizedBox(width: 12),
        Expanded(
          child: Text(text, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
        ),
      ],
    );
  }
}

/// The reader was fine, then dropped Wi-Fi mid-window. The countdown is
/// abandoned — attendance will not record while the node is offline — but
/// the staff member is not stuck staring at a dead spinner: clear words,
/// and a Retry the moment the node is healthy again.
class _ReaderLostPane extends StatelessWidget {
  const _ReaderLostPane({required this.lastSeenSeconds});

  final int? lastSeenSeconds;

  String _lastSeenLabel() {
    if (lastSeenSeconds == null) return 'The reader has never been seen.';
    if (lastSeenSeconds! < 90) return 'Last heartbeat only a moment ago.';
    final minutes = (lastSeenSeconds! / 60).round();
    return 'Last heartbeat about $minutes min ago.';
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.cloud_off_rounded, color: scheme.error, size: 18),
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                'The reader lost its Wi-Fi connection',
                style: TextStyle(
                  fontWeight: FontWeight.w800,
                  color: scheme.error,
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.space2),
        Text(
          'Attendance will not record while the cart reader is offline. Keep the phone nearby — the tap window opens again as soon as the node is back, or tap Retry for a fresh window.',
          style: textTheme.bodySmall,
        ),
        const SizedBox(height: AppSpacing.space2),
        Row(
          children: [
            Icon(Icons.sensors_rounded, size: 14, color: scheme.onSurface.withValues(alpha: 0.6)),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                _lastSeenLabel(),
                style: textTheme.bodySmall?.copyWith(
                  color: scheme.onSurface.withValues(alpha: 0.65),
                ),
              ),
            ),
          ],
        ),
      ],
    );
  }
}