import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'dart:async';

import '../app_version.dart';
import '../services/api_client.dart';
import '../services/auth_state.dart';
import '../services/offline_pin.dart';
import '../services/rfid_registration.dart';
import '../services/sync_service.dart';
import '../state/cart_state.dart';
import '../state/theme_controller.dart';
import '../theme.dart';
import '../utils/app_messenger.dart';
import '../utils/haptics.dart';
import '../utils/manila_time.dart';
import '../utils/password_strength.dart';
import '../utils/pin_setup.dart';
import '../widgets/pin_pad.dart';
import '../widgets/app_badge.dart';
import '../widgets/rfid_claim_dialog.dart';
import '../widgets/app_dialog.dart';
import '../widgets/section_header.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});
  @override
  State<SettingsScreen> createState() => SettingsScreenState();
}

class SettingsScreenState extends State<SettingsScreen> {
  bool? _hasPin;
  DateTime? _lastOnline;

  @override
  void initState() {
    super.initState();
    _loadAuthData();
  }

  Future<void> _loadAuthData() async {
    final auth = context.read<AuthState>();
    // The owner sets and changes staff cards in the dashboard, so the card
    // number shown here must be the current one - not the one from the last
    // sign-in.
    await auth.refreshProfile();
    final hasPin = await auth.pin.hasPin;
    final lastOnline = await auth.lastOnline;
    await auth.refreshTimeClock();
    await auth.refreshMyShifts();

    if (mounted) {
      setState(() {
        _hasPin = hasPin;
        _lastOnline = lastOnline;
      });
    }
  }

  Future<void> reload() async {
    await _loadAuthData();
  }

  Future<String?> _askPin({required String title, String? errorText}) async {
    String? result;
    String? error = errorText;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Theme.of(context).colorScheme.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
      ),
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
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Center(
                  child: Container(
                    width: 40,
                    height: 4,
                    margin: const EdgeInsets.symmetric(
                      vertical: AppSpacing.space2,
                    ),
                    decoration: BoxDecoration(
                      color: AppColors.primary.withValues(alpha: 0.3),
                      borderRadius: BorderRadius.circular(AppRadius.xs),
                    ),
                  ),
                ),
                const SizedBox(height: AppSpacing.space2),
                PinPad(
                  title: title,
                  errorText: error,
                  onComplete: (pin) {
                    result = pin;
                    Navigator.pop(sheetContext);
                  },
                ),
              ],
            ),
          ),
        ),
      ),
    );
    return result;
  }

  /// Clock in or out by tapping the card on the cart reader.
  ///
  /// The dialog is the same one card enrolment uses; only the requested shift
  /// differs. The toast reports what the server actually wrote, so it can never
  /// say "Time in" for a shift the log does not have.
  Future<void> _clockFlow(AuthState auth, String event) async {
    if (auth.offlineMode || auth.token == null) {
      AppMessenger.showGlassToast(
        context: context,
        message: 'Needs internet to clock in or out.',
        isSuccess: false,
      );
      return;
    }
    final isIn = event == 'IN';
    final done = isIn ? auth.myInDone : auth.myOutDone;
    if (done) {
      // One session per day: once timed in (or out), the button stays greyed.
      final at = auth.latestShiftToday(event);
      AppMessenger.showGlassToast(
        context: context,
        message:
            'You already timed ${isIn ? 'in' : 'out'} today${at == null ? '' : ' at ${ManilaTime.formatClock12(at)}'}.',
        isSuccess: false,
      );
      return;
    }
    // The button is greyed out while closed — this backstop covers every
    // programmatic path too. The server enforces the same on the claim.
    final inWindow = event == 'IN'
        ? auth.clockInOpen && auth.scheduleInOpen
        : auth.clockOutOpen && auth.scheduleOutOpen;
    if (!inWindow) {
      // Say which of the two gates locked the row, not just that one did.
      final schedHint = auth.scheduleHint(event);
      final windowOpen = event == 'IN' ? auth.clockInOpen : auth.clockOutOpen;
      AppMessenger.showGlassToast(
        context: context,
        message: (!windowOpen) ? auth.clockHint(event) : (schedHint ?? 'Not your scheduled time.'),
        isSuccess: false,
      );
      return;
    }
    final result = await RfidClaimDialog.show(
      context,
      token: auth.token!,
      registration: auth.rfidRegistration,
      event: event,
      onBound: auth.applyRfidBound,
      title: isIn ? 'Tap to time in' : 'Tap to time out',
      message: isIn
          ? 'Tap your staff card on the reader to start your shift.'
          : 'Tap your staff card on the reader to end your shift.',
    );
    if (!mounted || result == null) return;
    final ok = result is RfidBound;
    await Haptics.success();
    if (!mounted) return;
    AppMessenger.showGlassToast(
      context: context,
      message: RfidRegistrationService.describe(
        result,
        event: event,
        hasRegisteredCard: auth.hasRfidCard,
      ),
      isSuccess: ok,
    );
    // Pull the fresh shift in so the buttons grey out immediately.
    await auth.refreshMyShifts();
  }

  /// RFID card management, and the permanent way back in for anyone who skipped
  /// the post-login prompt.
  ///
  /// A registered card can be removed (borrowed or handed back). Changing it is
  /// the owner's job - they set the card in Settings > Staff accounts - so the
  /// app never offers to swap it. Offline is refused up front rather than after
  /// a long wait.
  Future<void> _rfidFlow(AuthState auth) async {
    if (auth.offlineMode || auth.token == null) {
      AppMessenger.showGlassToast(
        context: context,
        message: 'Needs internet to change your card.',
        isSuccess: false,
      );
      return;
    }

    if (auth.hasRfidCard) {
      final confirmed = await showAppConfirm(
        context,
        title: 'Remove this card?',
        message:
            'You will have to type your username to clock in and out until a card is registered again. To use a different card, ask the owner to change it in Settings > Staff accounts.',
        confirmLabel: 'Remove',
        danger: true,
      );
      if (!confirmed || !mounted) return;
      final removed = await auth.unbindRfid();
      if (!mounted) return;
      // Say it straight away. The card is already gone on the server, so the
      // person must not wait for a reload (or a failed reload) to find out.
      AppMessenger.showGlassToast(
        context: context,
        message: RfidRegistrationService.describe(removed),
        isSuccess: removed is RfidUnbound,
      );
      await reload().catchError((_) {});
      return;
    }

    final result = await RfidClaimDialog.show(
      context,
      token: auth.token!,
      registration: auth.rfidRegistration,
      onBound: auth.applyRfidBound,
      title: 'Tap your RFID card',
      message:
          'Hold your staff card against the reader on the cart to register it to your staff account. This tap only registers the card and does not log a shift.',
    );
    if (!mounted) return;
    await reload();
    if (!mounted) return;
    if (result == null) return;
    AppMessenger.showGlassToast(
      context: context,
      message: RfidRegistrationService.describe(result),
      isSuccess: result is RfidBound,
    );
  }

  Future<void> _setupPinFlow(AuthState auth) async {
    final ok = await showPinSetupFlow(context, auth);
    if (!mounted) return;
    if (ok) {
      await reload();
      if (!mounted) return;
      final username = auth.user?['username'];
      AppMessenger.showGlassToast(
        context: context,
        message: 'Offline PIN set for $username',
        isSuccess: true,
      );
    }
  }

  Future<void> _changePinFlow(AuthState auth) async {
    final username = auth.user?['username'] as String?;
    if (username == null) return;
    final oldPin = await _askPin(title: 'Enter current PIN');
    if (oldPin == null || !mounted) return;
    final next = await _askPin(title: 'Choose a new 6-digit PIN');
    if (next == null || !mounted) return;
    try {
      await auth.pin.changePin(
        username: username,
        oldPin: oldPin,
        newPin: next,
      );
      await Haptics.success();
      if (!mounted) return;
      await reload();
      if (!mounted) return;
      AppMessenger.showGlassToast(
        context: context,
        message: 'Offline PIN changed',
        isSuccess: true,
      );
    } on PinException catch (e) {
      if (!mounted) return;
      AppMessenger.showGlassToast(
        context: context,
        message: e.message,
        isSuccess: false,
      );
    }
  }

  Future<void> _disablePinFlow(AuthState auth) async {
    if (!await auth.api.health()) {
      if (!mounted) return;
      AppMessenger.showGlassToast(
        context: context,
        message: 'Connect to the internet to disable the PIN.',
        isSuccess: false,
      );
      return;
    }
    if (!mounted) return;
    final confirmed = await showAppConfirm(
      context,
      title: 'Disable offline PIN?',
      message:
          'This device will no longer open without internet. You can set a new PIN anytime.',
      confirmLabel: 'Disable',
      danger: true,
    );
    if (!confirmed || !mounted) return;
    await auth.pin.clear();
    await Haptics.success();
    await reload();
    if (!mounted) return;
    AppMessenger.showGlassToast(
      context: context,
      message: 'Offline PIN disabled',
      isSuccess: true,
    );
  }

  Future<void> _editEmailFlow(AuthState auth) async {
    final email = TextEditingController(
      text: auth.hasRealEmail ? auth.email : '',
    );
    final password = TextEditingController();
    final code = TextEditingController();
    var obscure = true;
    String? error;
    var pending = false;
    var sendingCode = false;
    var codeSent = false;
    // The server allows one code per minute: count it down so the button
    // cannot be spammed and the person knows when they can ask again.
    var cooldown = 0;
    Timer? cooldownTimer;
    // "idle" | "checking" | "valid" | "invalid" - is the typed code the right
    // one? Only the server knows, so the field asks (debounced).
    var codeCheck = 'idle';
    var codeExpired = false;
    Timer? checkTimer;
    var closed = false;
    final saved = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) {
          // The border of the code field follows the verdict: red while it does
          // not match, green once the server says it does.
          OutlineInputBorder codeBorder(Color color) => OutlineInputBorder(
                borderRadius: BorderRadius.circular(AppRadius.m),
                borderSide: BorderSide(color: color, width: 1.5),
              );

          // Ask the server whether the typed code is the right one. It cannot
          // be judged on the phone: only the server holds the code. Debounced,
          // so a six-digit code is asked about once, not once per keystroke.
          void checkCode(String value) {
            checkTimer?.cancel();
            final clean = value.trim();
            if (clean.length != 6) {
              setDialogState(() => codeCheck = 'idle');
              return;
            }
            setDialogState(() => codeCheck = 'checking');
            checkTimer = Timer(const Duration(milliseconds: 400), () async {
              try {
                final res = await auth.verifyEmailCode(
                  email.text.trim().toLowerCase(),
                  clean,
                );
                if (closed || !dialogContext.mounted) return;
                final reason = '${res['reason'] ?? ''}';
                if (res['valid'] == true) {
                  setDialogState(() {
                    codeExpired = false;
                    codeCheck = 'valid';
                  });
                } else if (reason == 'no_code') {
                  // Nothing was requested yet: that is not a wrong code.
                  setDialogState(() => codeCheck = 'idle');
                } else {
                  setDialogState(() {
                    codeExpired = reason == 'expired';
                    codeCheck = 'invalid';
                  });
                }
              } on ApiException {
                if (closed || !dialogContext.mounted) return;
                setDialogState(() => codeCheck = 'idle');
              }
            });
          }

          return AlertDialog(
          title: Row(
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: AppColors.primaryTint,
                  borderRadius: BorderRadius.circular(AppRadius.m),
                ),
                child: const Icon(
                  Icons.alternate_email_rounded,
                  color: AppColors.primary,
                  size: 20,
                ),
              ),
              const SizedBox(width: AppSpacing.space3),
              const Expanded(
                child: Text(
                  'Recovery email',
                  style: TextStyle(fontWeight: FontWeight.w800),
                ),
              ),
            ],
          ),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'Reset codes and password-change codes are sent here. Use an inbox you can open on this phone.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: AppSpacing.space3),
              TextField(
                controller: email,
                keyboardType: TextInputType.emailAddress,
                autofillHints: const [AutofillHints.email],
                decoration: InputDecoration(
                  labelText: 'Email address',
                  hintText: auth.displayEmail,
                ),
              ),
              const SizedBox(height: AppSpacing.space3),
              TextField(
                controller: code,
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                // The server is the only one that knows whether the code is
                // right, so the field asks (debounced) and turns red or green.
                onChanged: (value) => checkCode(value),
                decoration: InputDecoration(
                  labelText: 'Verification code',
                  border: codeCheck == 'valid'
                      ? codeBorder(AppColors.ok)
                      : codeCheck == 'invalid'
                          ? codeBorder(AppColors.danger)
                          : null,
                  enabledBorder: codeCheck == 'valid'
                      ? codeBorder(AppColors.ok)
                      : codeCheck == 'invalid'
                          ? codeBorder(AppColors.danger)
                          : null,
                  focusedBorder: codeCheck == 'valid'
                      ? codeBorder(AppColors.ok)
                      : codeCheck == 'invalid'
                          ? codeBorder(AppColors.danger)
                          : null,
                ),
              ),
              const SizedBox(height: AppSpacing.space2),
              Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  Expanded(
                    child: Text(
                      codeCheck == 'valid'
                          ? 'Code verified. You can save it now.'
                          : codeCheck == 'invalid'
                              ? (codeExpired
                                  ? 'That code has expired. Send a new one.'
                                  : 'That code does not match.')
                              : codeSent
                                  ? 'A 6-digit code was sent to that email.'
                                  : 'Send a code first, then type it here.',
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                            color: codeCheck == 'valid'
                                ? AppColors.ok
                                : codeCheck == 'invalid'
                                    ? AppColors.danger
                                    : AppColors.muted,
                            fontWeight:
                                codeCheck == 'idle' ? FontWeight.w500 : FontWeight.w700,
                          ),
                    ),
                  ),
                  TextButton(
                    onPressed: sendingCode || cooldown > 0
                        ? null
                        : () async {
                            final cleanEmail = email.text.trim().toLowerCase();
                            if (!isValidEmail(cleanEmail) ||
                                cleanEmail.endsWith('@cartiq.local')) {
                              setDialogState(
                                () => error = 'Enter a real email address, not a placeholder.',
                              );
                              return;
                            }
                            setDialogState(() {
                              sendingCode = true;
                              error = null;
                            });
                            try {
                              final res = await auth.sendEmailCode(cleanEmail);
                              if (closed || !dialogContext.mounted) return;
                              final seconds = res['cooldown'] == true
                                  ? (((res['retryAfterMs'] ?? 60000) as num) / 1000).ceil()
                                  : 60;
                              setDialogState(() {
                                sendingCode = false;
                                codeSent = true;
                                cooldown = seconds;
                              });
                              cooldownTimer?.cancel();
                              cooldownTimer = Timer.periodic(
                                const Duration(seconds: 1),
                                (t) {
                                  if (closed || !dialogContext.mounted) {
                                    t.cancel();
                                    return;
                                  }
                                  setDialogState(() {
                                    cooldown = cooldown > 0 ? cooldown - 1 : 0;
                                  });
                                  if (cooldown <= 0) t.cancel();
                                },
                              );
                            } on ApiException catch (e) {
                              if (closed || !dialogContext.mounted) return;
                              // The guard refused (429): keep the countdown in
                              // step with the server instead of guessing.
                              final retry = e.retryAfterSeconds ?? 0;
                              if (retry > 0) {
                                setDialogState(() {
                                  sendingCode = false;
                                  codeSent = true;
                                  cooldown = retry;
                                  error = e.message;
                                });
                                cooldownTimer?.cancel();
                                cooldownTimer = Timer.periodic(
                                  const Duration(seconds: 1),
                                  (t) {
                                    if (closed || !dialogContext.mounted) {
                                      t.cancel();
                                      return;
                                    }
                                    setDialogState(() {
                                      cooldown =
                                          cooldown > 0 ? cooldown - 1 : 0;
                                    });
                                    if (cooldown <= 0) t.cancel();
                                  },
                                );
                                return;
                              }
                              setDialogState(() {
                                sendingCode = false;
                                error = e.message;
                              });
                            }
                          },
                    child: Text(sendingCode
                        ? 'Sending...'
                        : cooldown > 0
                            ? 'Resend in ${cooldown}s'
                            : (codeSent ? 'Resend' : 'Send code')),
                  ),
                ],
              ),
              const SizedBox(height: AppSpacing.space3),
              _passwordField(
                controller: password,
                label: 'Current password',
                obscure: obscure,
                onToggle: () => setDialogState(() => obscure = !obscure),
                helperText: 'So a stolen session cannot redirect this.',
              ),              if (error != null) ...[
                const SizedBox(height: AppSpacing.space3),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.space3,
                    vertical: AppSpacing.space2,
                  ),
                  decoration: BoxDecoration(
                    color: AppColors.dangerBg,
                    borderRadius: BorderRadius.circular(AppRadius.s),
                    border: Border.all(
                      color: AppColors.danger.withValues(alpha: 0.45),
                    ),
                  ),
                  child: Row(
                    children: [
                      const Icon(
                        Icons.error_outline_rounded,
                        size: 16,
                        color: AppColors.danger,
                      ),
                      const SizedBox(width: AppSpacing.space2),
                      Expanded(
                        child: Text(
                          error!,
                          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                                color: AppColors.danger,
                                fontWeight: FontWeight.w600,
                              ),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ],
          ),
          actions: [
            TextButton(
              onPressed: pending
                  ? null
                  : () => Navigator.pop(dialogContext, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: pending
                  ? null
                  : () async {
                      final cleanEmail = email.text.trim().toLowerCase();
                      if (!isValidEmail(cleanEmail) ||
                          cleanEmail.endsWith('@cartiq.local')) {
                        setDialogState(
                          () => error =
                              'Enter a real email address, not a placeholder.',
                        );
                        return;
                      }
                      final cleanCode = code.text.trim();
                      if (!RegExp(r'^\d{6}$').hasMatch(cleanCode)) {
                        setDialogState(
                          () => error = 'Enter the 6-digit code sent to that email.',
                        );
                        return;
                      }
                      if (password.text.isEmpty) {
                        setDialogState(
                          () => error = 'Enter your current password.',
                        );
                        return;
                      }
                      setDialogState(() {
                        pending = true;
                        error = null;
                      });
                      try {
                        await auth.updateEmail(
                          email: cleanEmail,
                          currentPassword: password.text,
                          code: cleanCode,
                        );
                        if (dialogContext.mounted) {
                          Navigator.pop(dialogContext, true);
                        }
                      } on ApiException catch (e) {
                        if (closed || !dialogContext.mounted) return;
                        setDialogState(() {
                          pending = false;
                          error = e.message;
                        });
                      }
                    },
              child: Text(pending ? 'Saving...' : 'Save'),
            ),
          ],
        );
        },
      ),
    );
    closed = true;
    cooldownTimer?.cancel();
    checkTimer?.cancel();
    email.dispose();
    password.dispose();
    code.dispose();
    if (saved == true && mounted) {
      AppMessenger.showGlassToast(
        context: context,
        message: 'Recovery email updated.',
        isSuccess: true,
      );
      await Haptics.success();
    }
  }

  Future<void> _changePasswordFlow(AuthState auth) async {
    final current = TextEditingController();
    final code = TextEditingController();
    final next = TextEditingController();
    final confirm = TextEditingController();
    var obscure = true;
    String? error;
    String? notice;
    var codeSent = false;
    var sending = false;
    var pending = false;
    var closed = false;
    var changed = false;
    // "idle" | "checking" | "valid" | "invalid" - is the typed code the right
    // one? Only the server knows, so the field asks (debounced).
    var codeCheck = 'idle';
    var codeExpired = false;
    Timer? checkTimer;

    // The builder below calls sendCode from a button; this variable lets the
    // async helper update the dialog after the first frame.
    late StateSetter setDialogState;
    // The dialog's own context, so an async answer can check that the dialog
    // is still on screen before it calls setDialogState on a disposed builder.
    BuildContext? dialogCtx;

    Future<void> sendCode() async {
      if (sending || closed) return;
      setDialogState(() {
        sending = true;
        error = null;
      });
      try {
        final token = auth.token;
        if (token == null) throw ApiException('Signed out');
        final data = await auth.api.requestChangePasswordCode(token);
        if (closed || !(dialogCtx?.mounted ?? false)) return;
        setDialogState(() {
          sending = false;
          codeSent = true;
          codeCheck = 'idle';
          final masked = data['email'] as String?;
          notice = masked != null && masked.isNotEmpty
              ? 'Code sent to $masked.'
              : ((data['message'] as String?) ??
                    'A 6-digit code was sent to your recovery email.');
        });
        await Haptics.success();
      } on ApiException catch (e) {
        if (closed || !(dialogCtx?.mounted ?? false)) return;
        setDialogState(() {
          sending = false;
          error = e.message;
        });
        await Haptics.error();
      } catch (e) {
        // A platform failure (an invalidated Keystore, for example) must not
        // leave the dialog stuck on "sending".
        if (closed || !(dialogCtx?.mounted ?? false)) return;
        setDialogState(() {
          sending = false;
          error = 'Could not send the code. Try again.';
        });
        await Haptics.error();
      }
    }

    final ok = await showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setState) {
          setDialogState = setState;
          dialogCtx = dialogContext;
          final canSend = auth.hasRealEmail && !sending;

          // The border of the code field follows the verdict: red while it
          // does not match, green once the server says it does.
          OutlineInputBorder codeBorder(Color color) => OutlineInputBorder(
                borderRadius: BorderRadius.circular(AppRadius.m),
                borderSide: BorderSide(color: color, width: 1.5),
              );

          // Ask the server whether the typed code is the right one. It cannot
          // be judged on the phone: only the server holds the code. Debounced,
          // so a six-digit code is asked about once, not once per keystroke.
          void checkCode(String value) {
            checkTimer?.cancel();
            final clean = value.trim();
            if (clean.length != 6) {
              setDialogState(() => codeCheck = 'idle');
              return;
            }
            setDialogState(() => codeCheck = 'checking');
            checkTimer = Timer(const Duration(milliseconds: 400), () async {
              try {
                final res = await auth.verifyEmailCode(
                  auth.displayEmail,
                  clean,
                  purpose: 'change',
                );
                if (closed || !(dialogCtx?.mounted ?? false)) return;
                final reason = '${res['reason'] ?? ''}';
                if (res['valid'] == true) {
                  setDialogState(() {
                    codeExpired = false;
                    codeCheck = 'valid';
                  });
                } else if (reason == 'no_code') {
                  setDialogState(() => codeCheck = 'idle');
                } else {
                  setDialogState(() {
                    codeExpired = reason == 'expired';
                    codeCheck = 'invalid';
                  });
                }
              } on ApiException {
                if (closed || !(dialogCtx?.mounted ?? false)) return;
                setDialogState(() => codeCheck = 'idle');
              }
            });
          }

          return AlertDialog(
            title: Row(
              children: [
                Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: AppColors.primaryTint,
                    borderRadius: BorderRadius.circular(AppRadius.m),
                  ),
                  child: const Icon(
                    Icons.lock_outline_rounded,
                    color: AppColors.primary,
                    size: 20,
                  ),
                ),
                const SizedBox(width: AppSpacing.space3),
                const Expanded(
                  child: Text(
                    'Change password',
                    style: TextStyle(fontWeight: FontWeight.w800),
                  ),
                ),
              ],
            ),
              content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _passwordField(
                    controller: current,
                    label: 'Current password',
                    obscure: obscure,
                    onToggle: () => setDialogState(() => obscure = !obscure),
                  ),
                  const SizedBox(height: AppSpacing.space3),
                  TextField(
                    controller: code,
                    keyboardType: TextInputType.number,
                    maxLength: 6,
                    inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                    // The server is the only one that knows whether the code is
                    // right, so the field asks (debounced) and turns red or green.
                    onChanged: (value) => checkCode(value),
                    decoration: InputDecoration(
                      labelText: 'Email code',
                      counterText: '',
                      helperText: codeCheck == 'valid'
                          ? 'Code verified. You can change the password now.'
                          : codeCheck == 'invalid'
                              ? (codeExpired
                                  ? 'That code has expired. Send a new one.'
                                  : 'That code does not match. Check the digits.')
                              : codeSent
                                  ? 'A 6-digit code was sent to that email.'
                                  : null,
                      helperStyle: TextStyle(
                        color: codeCheck == 'valid'
                            ? AppColors.ok
                            : codeCheck == 'invalid'
                                ? AppColors.danger
                                : null,
                        fontWeight:
                            codeCheck == 'idle' ? null : FontWeight.w600,
                      ),
                      border: codeCheck == 'valid'
                          ? codeBorder(AppColors.ok)
                          : codeCheck == 'invalid'
                              ? codeBorder(AppColors.danger)
                              : null,
                      enabledBorder: codeCheck == 'valid'
                          ? codeBorder(AppColors.ok)
                          : codeCheck == 'invalid'
                              ? codeBorder(AppColors.danger)
                              : null,
                      focusedBorder: codeCheck == 'valid'
                          ? codeBorder(AppColors.ok)
                          : codeCheck == 'invalid'
                              ? codeBorder(AppColors.danger)
                              : null,
                    ),
                  ),
                  const SizedBox(height: AppSpacing.space2),
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          auth.hasRealEmail
                              ? 'Code goes to ${auth.displayEmail}'
                              : 'Add a recovery email first.',
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ),
                      TextButton(
                        onPressed: canSend ? sendCode : null,
                        child: Text(sending ? 'Sending...' : 'Send code'),
                      ),
                    ],
                  ),
                  if (notice != null) ...[
                    const SizedBox(height: AppSpacing.space2),
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: AppSpacing.space3,
                        vertical: AppSpacing.space2,
                      ),
                      decoration: BoxDecoration(
                        color: AppColors.okBg,
                        borderRadius: BorderRadius.circular(AppRadius.s),
                        border: Border.all(
                          color: AppColors.ok.withValues(alpha: 0.35),
                        ),
                      ),
                      child: Row(
                        children: [
                          const Icon(
                            Icons.mark_email_read_outlined,
                            size: 16,
                            color: AppColors.ok,
                          ),
                          const SizedBox(width: AppSpacing.space2),
                          Expanded(
                            child: Text(
                              notice!,
                              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                                    color: AppColors.ok,
                                    fontWeight: FontWeight.w600,
                                  ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                  const SizedBox(height: AppSpacing.space3),
                  _passwordField(
                    controller: next,
                    label: 'New password',
                    obscure: obscure,
                    onToggle: () => setDialogState(() => obscure = !obscure),
                  ),
                  const SizedBox(height: AppSpacing.space3),
                  _passwordField(
                    controller: confirm,
                    label: 'Confirm new password',
                    obscure: obscure,
                    onToggle: () => setDialogState(() => obscure = !obscure),
                  ),
                  if (error != null) ...[
                    const SizedBox(height: AppSpacing.space3),
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: AppSpacing.space3,
                        vertical: AppSpacing.space2,
                      ),
                      decoration: BoxDecoration(
                        color: AppColors.dangerBg,
                        borderRadius: BorderRadius.circular(AppRadius.s),
                        border: Border.all(
                          color: AppColors.danger.withValues(alpha: 0.45),
                        ),
                      ),
                      child: Row(
                        children: [
                          const Icon(
                            Icons.error_outline_rounded,
                            size: 16,
                            color: AppColors.danger,
                          ),
                          const SizedBox(width: AppSpacing.space2),
                          Expanded(
                            child: Text(
                              error!,
                              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                                    color: AppColors.danger,
                                    fontWeight: FontWeight.w600,
                                  ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: pending
                    ? null
                    : () => Navigator.pop(dialogContext, false),
                child: const Text('Cancel'),
              ),
              FilledButton(
                onPressed: pending
                    ? null
                    : () async {
                        if (next.text != confirm.text) {
                          setDialogState(
                            () => error = 'New passwords do not match.',
                          );
                          return;
                        }
                        if (!evaluatePassword(next.text).meetsGood) {
                          setDialogState(
                            () => error =
                                "Password must be at least 'Good' strength (8+ chars, upper/lower, number, special).",
                          );
                          return;
                        }
                        if (!codeSent || code.text.trim().length != 6) {
                          setDialogState(
                            () => error =
                                'Send the 6-digit code and enter it from your email.',
                          );
                          return;
                        }
                        setDialogState(() {
                          pending = true;
                          error = null;
                        });
                        try {
                          final token = auth.token;
                          if (token == null) throw ApiException('Signed out');
                          await auth.api.changePassword(
                            token,
                            currentPassword: current.text,
                            newPassword: next.text,
                            code: code.text.trim(),
                          );
                          changed = true;
                          if (dialogContext.mounted) {
                            Navigator.pop(dialogContext, true);
                          }
                        } on ApiException catch (e) {
                          if (closed || !dialogContext.mounted) return;
                          setDialogState(() {
                            pending = false;
                            error = e.message;
                          });
                        }
                      },
                child: Text(pending ? 'Saving...' : 'Save'),
              ),
            ],
          );
        },
      ),
    );
    closed = true;
    checkTimer?.cancel();
    current.dispose();
    code.dispose();
    next.dispose();
    confirm.dispose();
    if ((ok == true || changed) && mounted) {
      // Toast BEFORE signOut: AppMessenger inserts into the ROOT overlay
      // synchronously, so it survives the swap back to LoginScreen. Showing it
      // after the await would hit a disposed context and silently vanish.
      AppMessenger.showGlassToast(
        context: context,
        message: 'Password changed. Please sign in again.',
        isSuccess: true,
      );
      await auth.signOut();
    }
  }

  Future<void> _signOutFlow(AuthState auth, SyncService sync) async {
    int queued = 0;
    try {
      queued = await sync.queue.count;
    } catch (_) {}
    if (!mounted) return;
    final confirmed = await showAppConfirm(
      context,
      title: 'Log out?',
      message: queued > 0
          ? '$queued sale(s) still queued - they stay saved on this device.'
          : 'No queued sales. You can sign back in anytime.',
      confirmLabel: 'Log out',
    );
    if (!confirmed || !mounted) return;
    sync.cancelActiveSync();
    // The cart belongs to the person who was selling: signing out drops the
    // unfinished order (and its saved draft) for the next person.
    context.read<CartState>().clear();
    await auth.signOut();
    await Haptics.success();
  }

  @override
  Widget build(BuildContext context) {
    final surfaceColor = Theme.of(context).colorScheme.surface;

    return Consumer2<AuthState, ThemeController>(
      builder: (context, auth, theme, _) => ListView(
        padding: const EdgeInsets.fromLTRB(
          AppSpacing.space4,
          AppSpacing.space4,
          AppSpacing.space4,
          120,
        ),
        children: [
          const SectionHeader(title: 'Account', eyebrow: 'Signed in as'),
          const SizedBox(height: AppSpacing.space3),
          _AccountCard(auth: auth, lastOnline: _lastOnline),
          const SizedBox(height: AppSpacing.space6),

          // Attendance gets its own card rather than sitting in the middle of
          // the Session list: it is the staff member's main daily action, and
          // the two clock states need room to read at a glance.
          if (auth.user?['role'] == 'STAFF') ...[
            const SectionHeader(title: 'Attendance', eyebrow: 'Time clock'),
            const SizedBox(height: AppSpacing.space3),
            _TimeRow(
              auth: auth,
              onPressed: (event) => _clockFlow(auth, event),
            ),
            const SizedBox(height: AppSpacing.space6),
          ],

          const SectionHeader(title: 'Session', eyebrow: 'This device'),
          const SizedBox(height: AppSpacing.space3),
          Container(
            clipBehavior: Clip.antiAlias,
            decoration: BoxDecoration(
              color: surfaceColor,
              borderRadius: BorderRadius.circular(AppRadius.xl),
              boxShadow: AppShadow.sm(),
            ),
            child: Material(
              color: Colors.transparent,
              child: Column(
                children: [
                  _PremiumTile(
                    icon: Icons.contactless_outlined,
                    iconColor: auth.hasRfidCard ? AppColors.ok : AppColors.info,
                    title: auth.hasRfidCard
                        ? 'RFID card'
                        : 'Register RFID card',
                    subtitle: auth.hasRfidCard
                        ? auth.rfidUid
                        : 'Tap a card on the cart reader',
                    trailing: auth.hasRfidCard
                        ? const AppBadge(
                            label: 'Registered',
                            variant: AppBadgeVariant.ok,
                          )
                        : null,
                    onTap: () => _rfidFlow(auth),
                  ),
                  const Divider(height: 1, indent: 72),
                  _PremiumTile(
                    icon: Icons.mail_outline_rounded,
                    iconColor: auth.hasRealEmail
                        ? AppColors.ok
                        : AppColors.warn,
                    title: 'Recovery email',
                    subtitle: auth.displayEmail,
                    trailing: auth.hasRealEmail
                        ? null
                        : const AppBadge(
                            label: 'Placeholder',
                            variant: AppBadgeVariant.warn,
                          ),
                    onTap: () => _editEmailFlow(auth),
                  ),
                  const Divider(height: 1, indent: 72),
                  _PremiumTile(
                    icon: Icons.password_outlined,
                    iconColor: AppColors.info,
                    title: 'Change password',
                    subtitle: 'Email code required',
                    onTap: () => _changePasswordFlow(auth),
                  ),
                  const Divider(height: 1, indent: 72),
                  _PremiumTile(
                    icon: Icons.logout_rounded,
                    iconColor: AppColors.danger,
                    title: 'Log out',
                    onTap: () =>
                        _signOutFlow(auth, context.read<SyncService>()),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.space6),

          const SectionHeader(
            title: 'Offline PIN',
            eyebrow: 'No-internet login',
          ),
          const SizedBox(height: AppSpacing.space3),
          _PinSection(
            auth: auth,
            hasPin: _hasPin,
            onSetup: () => _setupPinFlow(auth),
            onChange: () => _changePinFlow(auth),
            onDisable: () => _disablePinFlow(auth),
          ),
          const SizedBox(height: AppSpacing.space6),

          const SectionHeader(title: 'Appearance', eyebrow: 'Theme'),
          const SizedBox(height: AppSpacing.space3),

          Container(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.space4,
              vertical: AppSpacing.space2,
            ),
            decoration: BoxDecoration(
              color: surfaceColor,
              borderRadius: BorderRadius.circular(AppRadius.pill),
              boxShadow: AppShadow.sm(),
            ),
            child: Row(
              children: [
                Expanded(
                  child: _ThemeButton(
                    currentMode: theme.mode,
                    targetMode: ThemeMode.light,
                    icon: Icons.light_mode_outlined,
                    label: 'Light',
                    onTap: () {
                      Haptics.select();
                      theme.setMode(ThemeMode.light);
                    },
                  ),
                ),
                const SizedBox(width: AppSpacing.space2),
                Expanded(
                  child: _ThemeButton(
                    currentMode: theme.mode,
                    targetMode: ThemeMode.dark,
                    icon: Icons.dark_mode_outlined,
                    label: 'Dark',
                    onTap: () {
                      Haptics.select();
                      theme.setMode(ThemeMode.dark);
                    },
                  ),
                ),
                const SizedBox(width: AppSpacing.space2),
                Expanded(
                  child: _ThemeButton(
                    currentMode: theme.mode,
                    targetMode: ThemeMode.system,
                    icon: Icons.settings_suggest_outlined,
                    label: 'Auto',
                    onTap: () {
                      Haptics.select();
                      theme.setMode(ThemeMode.system);
                    },
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: AppSpacing.space6),

          const SectionHeader(title: 'Server', eyebrow: 'Backend connection'),
          const SizedBox(height: AppSpacing.space3),
          _ServerSection(onChanged: () => setState(() {})),
          const SizedBox(height: AppSpacing.space6),

          const SectionHeader(title: 'Sync & storage', eyebrow: 'Offline data'),
          const SizedBox(height: AppSpacing.space3),
          _SyncSection(
            onToast: (message, {error = false, success = false}) {
              AppMessenger.showGlassToast(
                context: context,
                message: message,
                isSuccess: success || !error,
              );
            },
          ),
          const SizedBox(height: AppSpacing.space6),

          const SectionHeader(title: 'About', eyebrow: 'CartIQ POS'),
          const SizedBox(height: AppSpacing.space3),
          Container(
            clipBehavior: Clip.antiAlias,
            decoration: BoxDecoration(
              color: surfaceColor,
              borderRadius: BorderRadius.circular(AppRadius.xl),
              boxShadow: AppShadow.sm(),
            ),
            child: Material(
              color: Colors.transparent,
              child: Column(
                children: [
                  const _PremiumTile(
                    icon: Icons.info_outline_rounded,
                    iconColor: AppColors.primary,
                    title: 'Version',
                    subtitle: 'v$appVersion • Pota Fries Operations',
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ThemeButton extends StatelessWidget {
  const _ThemeButton({
    required this.currentMode,
    required this.targetMode,
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final ThemeMode currentMode;
  final ThemeMode targetMode;
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final isSelected = currentMode == targetMode;

    return Material(
      color: isSelected
          ? AppColors.primary.withValues(alpha: 0.12)
          : Colors.transparent,
      borderRadius: BorderRadius.circular(AppRadius.pill),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppRadius.pill),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 12),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AppRadius.pill),
            border: Border.all(
              color: isSelected
                  ? AppColors.primary.withValues(alpha: 0.3)
                  : Colors.transparent,
              width: 1,
            ),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(
                icon,
                color: isSelected ? AppColors.primary : AppColors.muted,
                size: 16,
              ),
              const SizedBox(width: 8),
              Text(
                label,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                  color: isSelected ? AppColors.primary : AppColors.muted,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _PremiumTile extends StatelessWidget {
  const _PremiumTile({
    required this.icon,
    required this.iconColor,
    required this.title,
    this.subtitle,
    this.trailing,
    this.onTap,
    this.customWidget,
  });

  final IconData icon;
  final Color iconColor;
  final String title;
  final String? subtitle;
  final Widget? trailing;
  final VoidCallback? onTap;
  final Widget? customWidget;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.space4,
          vertical: AppSpacing.space3,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: iconColor.withValues(alpha: 0.12),
                borderRadius: BorderRadius.circular(AppRadius.m),
              ),
              child: Icon(icon, color: iconColor, size: 22),
            ),
            const SizedBox(width: AppSpacing.space3),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    title,
                    style: const TextStyle(
                      fontWeight: FontWeight.w700,
                      fontSize: 15,
                    ),
                  ),
                  if (subtitle != null) ...[
                    const SizedBox(height: 2),
                    Text(
                      subtitle!,
                      style: Theme.of(context).textTheme.bodySmall,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ],
              ),
            ),
            if (customWidget != null)
              customWidget!
            else if (trailing != null)
              trailing!
            else if (onTap != null)
              const Padding(
                padding: EdgeInsets.only(left: 8.0),
                child: Icon(
                  Icons.chevron_right_rounded,
                  size: 20,
                  color: Colors.grey,
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _AccountCard extends StatelessWidget {
  const _AccountCard({required this.auth, required this.lastOnline});

  final AuthState auth;
  final DateTime? lastOnline;

  @override
  Widget build(BuildContext context) {
    final name = auth.displayName;
    final surfaceColor = Theme.of(context).colorScheme.surface;

    final label = lastOnline == null
        ? 'Never verified • connect once to enable offline login'
        : 'Last verified ${ManilaTime.formatTime(lastOnline!)}'
              '${auth.offlineMode ? ' • OFFLINE MODE' : ''}';

    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: surfaceColor,
        borderRadius: BorderRadius.circular(AppRadius.xl),
        boxShadow: AppShadow.sm(),
      ),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.space5),
        child: Column(
          children: [
            Row(
              children: [
                CircleAvatar(
                  radius: 30,
                  backgroundColor: AppColors.primary.withValues(alpha: 0.12),
                  child: Text(
                    name.isNotEmpty ? name[0].toUpperCase() : '?',
                    style: Theme.of(context).textTheme.headlineSmall?.copyWith(
                      color: AppColors.primary,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                ),
                const SizedBox(width: AppSpacing.space4),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        name,
                        style: Theme.of(context).textTheme.titleLarge?.copyWith(
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      const SizedBox(height: 4),
                      // FIX: Tinanggal na ang string interpolation warning
                      Text(
                        auth.locationCode ?? "No cart assigned",
                        style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                          color: AppColors.muted,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        auth.displayEmail,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: auth.hasRealEmail
                              ? AppColors.muted
                              : AppColors.warn,
                        ),
                      ),
                    ],
                  ),
                ),
                AppBadge(
                  label: auth.roleDisplay,
                  variant: auth.roleDisplay == 'OWNER'
                      ? AppBadgeVariant.warn
                      : AppBadgeVariant.info,
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.space4),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              decoration: BoxDecoration(
                color: Theme.of(context).dividerColor.withValues(alpha: 0.2),
                borderRadius: BorderRadius.circular(AppRadius.m),
              ),
              child: Row(
                children: [
                  Icon(
                    auth.offlineMode
                        ? Icons.wifi_off_rounded
                        : Icons.verified_outlined,
                    size: 16,
                    color: auth.offlineMode ? AppColors.warn : AppColors.ok,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      label,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        fontWeight: FontWeight.w600,
                        color: auth.offlineMode ? AppColors.warn : null,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _PinSection extends StatelessWidget {
  const _PinSection({
    required this.auth,
    required this.hasPin,
    required this.onSetup,
    required this.onChange,
    required this.onDisable,
  });

  final AuthState auth;
  final bool? hasPin;
  final VoidCallback onSetup;
  final VoidCallback onChange;
  final VoidCallback onDisable;

  @override
  Widget build(BuildContext context) {
    final surfaceColor = Theme.of(context).colorScheme.surface;
    final isStaff = (auth.user?['role'] as String?) == 'STAFF';

    if (!isStaff) {
      return Container(
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          color: surfaceColor,
          borderRadius: BorderRadius.circular(AppRadius.xl),
          boxShadow: AppShadow.sm(),
        ),
        child: const _PremiumTile(
          icon: Icons.pin_outlined,
          iconColor: Colors.grey,
          title: 'Offline PIN',
          subtitle: 'Staff accounts only. Owners always sign in online.',
        ),
      );
    }

    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: surfaceColor,
        borderRadius: BorderRadius.circular(AppRadius.xl),
        boxShadow: AppShadow.sm(),
      ),
      child: Material(
        color: Colors.transparent,
        child: Column(
          children: [
            _PremiumTile(
              icon: Icons.pin_rounded,
              iconColor: AppColors.primary,
              title: 'Offline PIN',
              subtitle: hasPin == true
                  ? 'On • opens this device without internet'
                  : 'Off • set one to open the app with no signal',
              trailing: AppBadge(
                label: hasPin == true ? 'ON' : 'OFF',
                variant: hasPin == true
                    ? AppBadgeVariant.ok
                    : AppBadgeVariant.neutral,
              ),
            ),
            if (hasPin != null) ...[
              if (!hasPin!)
                _PremiumTile(
                  icon: Icons.add_rounded,
                  iconColor: AppColors.ok,
                  title: 'Set up PIN',
                  onTap: onSetup,
                )
              else ...[
                _PremiumTile(
                  icon: Icons.edit_outlined,
                  iconColor: AppColors.info,
                  title: 'Change PIN',
                  subtitle: 'Works offline with current PIN',
                  onTap: onChange,
                ),
                _PremiumTile(
                  icon: Icons.remove_circle_outline_rounded,
                  iconColor: AppColors.warn,
                  title: 'Disable PIN',
                  subtitle: 'Needs internet',
                  onTap: onDisable,
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }
}

class _ServerSection extends StatefulWidget {
  const _ServerSection({required this.onChanged});
  final VoidCallback onChanged;
  @override
  State<_ServerSection> createState() => _ServerSectionState();
}

class _ServerSectionState extends State<_ServerSection> {
  bool? _lanEnabled;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final api = context.read<AuthState>().api;
    final v = await api.getLanDiscovery();
    if (mounted) setState(() => _lanEnabled = v);
  }

  Future<void> _rescan() async {
    final api = context.read<AuthState>().api;
    setState(() => _busy = true);
    try {
      final url = await api.rescan();
      widget.onChanged();
      if (!mounted) return;
      AppMessenger.showGlassToast(
        context: context,
        message: 'Server: $url',
        isSuccess: true,
      );
    } catch (e) {
      if (!mounted) return;
      AppMessenger.showGlassToast(
        context: context,
        message: 'Rescan failed: $e',
        isSuccess: false,
      );
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _manualEntry() async {
    final controller = TextEditingController();
    String? error;
    final saved = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) {
          // One save path for both the Save button and the keyboard's "Go"
          // action: pressing Enter used to close the dialog as if it had saved,
          // while the address itself was never stored.
          Future<void> save() async {
            try {
              final api = this.context.read<AuthState>().api;
              await api.setManualBaseUrl(controller.text);
              final ok = await api.testConnection();
              if (!ok) {
                setDialogState(
                  () => error =
                      'Saved, but the server did not answer. Check the address.',
                );
                return;
              }
              if (dialogContext.mounted) {
                Navigator.pop(dialogContext, true);
              }
            } on ApiException catch (e) {
              setDialogState(() => error = e.message);
            }
          }

          return AlertDialog(
            title: const Text('Server address'),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: controller,
                  keyboardType: TextInputType.url,
                  decoration: const InputDecoration(
                    labelText: 'IP or host',
                    hintText: '192.168.1.5',
                  ),
                  onSubmitted: (_) => save(),
                ),
                if (error != null) ...[
                  const SizedBox(height: AppSpacing.space2),
                  Text(
                    error!,
                    style: Theme.of(
                      context,
                    ).textTheme.bodySmall?.copyWith(color: AppColors.danger),
                  ),
                ],
              ],
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(dialogContext, false),
                child: const Text('Cancel'),
              ),
              FilledButton(
                onPressed: () => save(),
                child: const Text('Save'),
              ),
            ],
          );
        },
      ),
    );
    controller.dispose();
    if (saved == true) {
      widget.onChanged();
      if (mounted) setState(() {});
    }
  }

  Future<void> _resetDefault() async {
    final api = context.read<AuthState>().api;
    await api.resetServerToDefault();
    widget.onChanged();
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final api = context.watch<AuthState>().api;
    final surfaceColor = Theme.of(context).colorScheme.surface;

    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: surfaceColor,
        borderRadius: BorderRadius.circular(AppRadius.xl),
        boxShadow: AppShadow.sm(),
      ),
      child: Material(
        color: Colors.transparent,
        child: Column(
          children: [
            _PremiumTile(
              icon: Icons.dns_outlined,
              iconColor: Colors.deepPurple,
              title: 'Active server',
              subtitle:
                  api.currentBaseUrl +
                  (api.isManualUrl ? ' • manual override' : ''),
            ),
            _PremiumTile(
              icon: Icons.radar_outlined,
              iconColor: AppColors.info,
              title: 'Rescan network',
              trailing: _busy
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.chevron_right_rounded, color: Colors.grey),
              onTap: _busy ? null : _rescan,
            ),
            _PremiumTile(
              icon: Icons.edit_outlined,
              iconColor: Colors.teal,
              title: 'Enter server manually',
              onTap: _manualEntry,
            ),
            _PremiumTile(
              icon: Icons.restart_alt_rounded,
              iconColor: AppColors.warn,
              title: 'Reset to default',
              onTap: _resetDefault,
            ),
            _PremiumTile(
              icon: Icons.wifi_find_rounded,
              iconColor: AppColors.primary,
              title: 'Offline LAN pilot',
              subtitle:
                  'May attach to a same-Wi-Fi dev server instead of production. Off unless piloting.',
              customWidget: Switch(
                // FIX: Gamitin ang activeThumbColor imbes na activeColor
                activeThumbColor: AppColors.primary,
                value: _lanEnabled ?? false,
                onChanged: _lanEnabled == null
                    ? null
                    : (v) async {
                        await api.setLanDiscovery(v);
                        if (!mounted) return;
                        setState(() => _lanEnabled = v);
                        if (!v) {
                          await api.resetServerToDefault();
                          widget.onChanged();
                          if (mounted) setState(() {});
                        }
                      },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SyncSection extends StatelessWidget {
  const _SyncSection({required this.onToast});
  final void Function(String message, {bool error, bool success}) onToast;

  /// The sales the server refused, with the reason each one was refused.
  static Future<void> _showDroppedSales(
    BuildContext context,
    SyncService sync,
  ) async {
    final store = sync.droppedStore;
    if (store == null) return;
    final entries = await store.list();
    if (!context.mounted) return;
    await showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Rejected sales'),
        content: SizedBox(
          width: double.maxFinite,
          child: entries.isEmpty
              ? const Text('No rejected sales.')
              : ListView(
                  shrinkWrap: true,
                  children: entries
                      .map(
                        (e) {
                          final total = e['total'];
                          final count = e['itemCount'];
                          final at = DateTime.tryParse(
                            e['at'] as String? ?? '',
                          );
                          final reason = e['reason'] as String? ?? 'rejected';
                          final title = 'P${total is num ? total.toStringAsFixed(2) : '?'}'
                              '${count == null ? '' : ' • $count item(s)'}';
                          final subtitle = '$reason'
                              '${at == null ? '' : ' • ${ManilaTime.formatTime(at)}'}';
                          return ListTile(
                            dense: true,
                            contentPadding: EdgeInsets.zero,
                            title: Text(title),
                            subtitle: Text(subtitle),
                            trailing: IconButton(
                              tooltip: 'Forget this sale',
                              icon: const Icon(Icons.delete_outline_rounded),
                              onPressed: () async {
                                final id = e['id'];
                                if (id is String) await store.remove(id);
                                if (dialogContext.mounted) {
                                  Navigator.pop(dialogContext);
                                }
                              },
                            ),
                          );
                        },
                      )
                      .toList(),
                ),
        ),
        actions: [
          TextButton(
            onPressed: () async {
              await store.clear();
              if (dialogContext.mounted) Navigator.pop(dialogContext);
            },
            child: const Text('Clear all'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('Close'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final sync = context.watch<SyncService>();
    final api = context.read<AuthState>().api;
    final surfaceColor = Theme.of(context).colorScheme.surface;

    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: surfaceColor,
        borderRadius: BorderRadius.circular(AppRadius.xl),
        boxShadow: AppShadow.sm(),
      ),
      child: Material(
        color: Colors.transparent,
        child: Column(
          children: [
            FutureBuilder<int>(
              future: sync.queue.count,
              builder: (context, snap) => _PremiumTile(
                icon: Icons.cloud_upload_outlined,
                iconColor: AppColors.primary,
                title: 'Queued sales',
                subtitle: snap.data == null
                    ? '...'
                    : snap.data == 0
                    ? 'All synced'
                    : '${snap.data} waiting to sync',
                customWidget: FilledButton.tonal(
                  onPressed: () async {
                    final result = await sync.syncAll();
                    final dropped = result.dropped.length;
                    onToast(
                      result.fullySynced
                          ? 'Synced ${result.synced} sale(s)'
                          : dropped > 0
                          // A refused sale must never look like a plain
                          // "still pending" - the reason is what matters.
                          ? result.message
                          : result.online
                          ? '${result.remaining} remaining'
                          : 'Offline • will sync when connected',
                      error: result.dropped.isNotEmpty,
                      success: result.fullySynced,
                    );
                  },
                  style: FilledButton.styleFrom(
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    minimumSize: const Size(0, 36),
                  ),
                  child: const Text('Sync now', style: TextStyle(fontSize: 12)),
                ),
              ),
            ),
            // Sales the server refused. They left the queue, so this is the
            // only place the operator can still see them.
            if (sync.droppedStore != null)
              FutureBuilder<int>(
                future: sync.droppedStore!.count(),
                builder: (context, snap) {
                  final count = snap.data ?? 0;
                  if (count == 0) return const SizedBox.shrink();
                  return _PremiumTile(
                    icon: Icons.error_outline_rounded,
                    iconColor: AppColors.danger,
                    title: 'Rejected sales',
                    subtitle: '$count sale(s) the server refused - '
                        're-record them by hand',
                    onTap: () => _showDroppedSales(context, sync),
                  );
                },
              ),
            FutureBuilder<DateTime?>(
              future: api.catalogUpdatedAt(),
              builder: (context, snap) => _PremiumTile(
                icon: Icons.inventory_2_outlined,
                iconColor: AppColors.ok,
                title: 'Catalog cache',
                subtitle: snap.data == null
                    ? 'Never downloaded'
                    : 'Updated ${ManilaTime.formatTime(snap.data!)}',
                customWidget: PopupMenuButton<String>(
                  tooltip: 'Catalog options',
                  icon: const Icon(Icons.more_vert_rounded, color: Colors.grey),
                  onSelected: (v) async {
                    if (v == 'refresh') {
                      final token = context.read<AuthState>().token;
                      if (token == null) return;
                      try {
                        await api.catalog(token, forceRefresh: true);
                        onToast('Catalog refreshed', success: true);
                      } catch (e) {
                        onToast('Refresh failed: $e', error: true);
                      }
                    } else if (v == 'clear') {
                      await api.clearCatalogCache();
                      onToast('Catalog cache cleared');
                    }
                  },
                  itemBuilder: (context) => const [
                    PopupMenuItem(value: 'refresh', child: Text('Refresh now')),
                    PopupMenuItem(value: 'clear', child: Text('Clear cache')),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The attendance pair: RFID Tap (the cart reader) and App Tap (direct,
/// server-validated, straight from the app). Both record through the same
/// backend rules, so an IN from one method is visible to the other, and a
/// card tap and an app tap can never produce two sessions on the same day.
class _TimeRow extends StatefulWidget {
  const _TimeRow({required this.auth, required this.onPressed});

  final AuthState auth;

  /// Action requested for the RFID Tap method ("IN"/"OUT") — the same claim
  /// dialog the card enrolment uses.
  final void Function(String event) onPressed;

  @override
  State<_TimeRow> createState() => _TimeRowState();
}

class _TimeRowState extends State<_TimeRow> {
  bool _appTapBusy = false;

  static const _weekdays = [
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
    'Sunday',
  ];

  static const _months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];

  String _todayLabel() {
    final now = ManilaTime.now();
    return '${_weekdays[now.weekday - 1]}, ${_months[now.month - 1]} ${now.day}';
  }

  /// "App Tap": the account itself records the next action. The server picks
  /// IN or OUT from the attendance state — the app never sends an event —
  /// and answers only after it has actually written the row.
  Future<void> _appTap() async {
    final auth = widget.auth;
    if (_appTapBusy) return;
    if (auth.offlineMode || auth.token == null) {
      AppMessenger.showGlassToast(
        context: context,
        message: 'Internet connection is required to record attendance.',
        isSuccess: false,
      );
      return;
    }
    setState(() => _appTapBusy = true);
    try {
      final res = await auth.api.appTap(auth.token!);
      final ev = (res['event'] ?? '').toString();
      if (!mounted) return;
      AppMessenger.showGlassToast(
        context: context,
        message: ev == 'OUT' ? 'Time out recorded' : 'Time in recorded',
        isSuccess: true,
      );
      unawaited(Haptics.success());
      await auth.refreshMyShifts();
    } on ApiException catch (e) {
      if (!mounted) return;
      AppMessenger.showGlassToast(
        context: context,
        message: e.message,
        isSuccess: false,
      );
    } catch (_) {
      if (!mounted) return;
      AppMessenger.showGlassToast(
        context: context,
        message: 'Could not reach the server. Check your connection.',
        isSuccess: false,
      );
    } finally {
      if (mounted) setState(() => _appTapBusy = false);
    }
  }

  String _methodOf(Map<String, dynamic> row) {
    final m = (row['method'] ?? '').toString().toUpperCase();
    if (m == 'APP' || m == 'MANUAL' || m == 'RFID') return m;
    return (row['deviceId'] ?? '').toString() == 'MANUAL' ? 'MANUAL' : 'RFID';
  }

  Widget _methodCard({
    required IconData icon,
    required Color accent,
    required String title,
    required List<Widget> children,
  }) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      key: Key('attendance-${title.toLowerCase().replaceAll(' ', '-')}'),
      decoration: BoxDecoration(
        color: scheme.onSurface.withValues(alpha: 0.04),
        borderRadius: BorderRadius.circular(AppRadius.l),
        border: Border.all(color: scheme.onSurface.withValues(alpha: 0.07)),
      ),
      padding: const EdgeInsets.all(AppSpacing.space3),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 19, color: accent),
              const SizedBox(width: 8),
              Text(
                title,
                style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 13.5),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.space2),
          ...children,
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final auth = widget.auth;
    final inAt = auth.myInAtToday;
    final outAt = auth.myOutAtToday;
    final inDone = inAt != null;
    final outDone = outAt != null;
    final nextEvent = !inDone ? 'IN' : (!outDone ? 'OUT' : null);
    final canIn = auth.clockInOpen && auth.scheduleInOpen && !inDone;
    final canOut = auth.clockOutOpen && auth.scheduleOutOpen && !outDone;
    final nextOpen = nextEvent == 'IN' ? canIn : nextEvent == 'OUT' ? canOut : false;
    final dayOpen = auth.timeClockDayOpen;
    final caption = auth.timeClockCaption();
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final okColor = isDark ? const Color(0xFF4ADE80) : AppColors.ok;
    final dangerColor = isDark ? const Color(0xFFF87171) : AppColors.danger;
    final online = auth.token != null && !auth.offlineMode;

    final String badge;
    final AppBadgeVariant badgeVariant;
    final scheduleLabel = auth.scheduleTodayLabel;
    if (inDone && outDone) {
      badge = 'Complete';
      badgeVariant = AppBadgeVariant.ok;
    } else if (inDone) {
      badge = 'On shift';
      badgeVariant = AppBadgeVariant.ok;
    } else if (outDone) {
      badge = 'Timed out';
      badgeVariant = AppBadgeVariant.neutral;
    } else if (scheduleLabel == 'Today: Day off') {
      badge = 'Day off';
      badgeVariant = AppBadgeVariant.neutral;
    } else if (!dayOpen) {
      badge = 'Closed';
      badgeVariant = AppBadgeVariant.neutral;
    } else {
      badge = 'Not clocked in';
      badgeVariant = AppBadgeVariant.neutral;
    }

    final deviceStatus = auth.deviceStatus?['status']?.toString();
    final deviceDot = deviceStatus == 'connected'
        ? AppColors.ok
        : deviceStatus == 'offline'
            ? AppColors.danger
            : AppColors.muted;
    final String deviceLine;
    final String deviceDetail;
    switch (deviceStatus) {
      case 'connected':
        deviceLine = 'Reader connected';
        deviceDetail = 'Tap your card on the device';
        break;
      case 'offline':
        deviceLine = 'Reader offline';
        deviceDetail = 'Check the cart has power and Wi-Fi';
        break;
      case 'unavailable':
        deviceLine = 'Reader not set up';
        deviceDetail = 'Ask the owner to set up the reader';
        break;
      default:
        deviceLine = 'Checking reader…';
        deviceDetail = 'Contacting the cart reader';
    }

    final recent = auth.myShiftsToday.reversed.take(3).toList();

    Widget clockButton({
      required Key key,
      required String label,
      required IconData icon,
      required Color accent,
      required bool enabled,
      required VoidCallback? onTap,
      bool busy = false,
    }) {
      return SizedBox(
        key: key,
        width: double.infinity,
        height: 46,
        child: FilledButton.icon(
          onPressed: enabled ? onTap : null,
          style: FilledButton.styleFrom(
            backgroundColor: accent,
            foregroundColor: Colors.white,
            disabledBackgroundColor: scheme.onSurface.withValues(alpha: 0.08),
            disabledForegroundColor: scheme.onSurface.withValues(alpha: 0.45),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.m)),
          ),
          icon: busy
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                )
              : Icon(icon, size: 18),
          label: Text(busy ? 'Recording…' : label),
        ),
      );
    }

    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: scheme.surface,
        borderRadius: BorderRadius.circular(AppRadius.xl),
        boxShadow: AppShadow.sm(),
      ),
      child: Material(
        color: Colors.transparent,
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.space4),
          child: Column(
            children: [
              Row(
                children: [
                  Container(
                    width: 40,
                    height: 40,
                    decoration: BoxDecoration(
                      color: AppColors.primary.withValues(alpha: 0.10),
                      borderRadius: BorderRadius.circular(AppRadius.m),
                    ),
                    child: const Icon(
                      Icons.schedule_rounded,
                      color: AppColors.primary,
                      size: 21,
                    ),
                  ),
                  const SizedBox(width: AppSpacing.space3),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          _todayLabel(),
                          style: const TextStyle(
                            fontWeight: FontWeight.w700,
                            fontSize: 15,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          'Two ways to record attendance',
                          style: textTheme.bodySmall,
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: AppSpacing.space2),
                  AppBadge(label: badge, variant: badgeVariant),
                ],
              ),
              const SizedBox(height: AppSpacing.space3),
              if (scheduleLabel != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: AppSpacing.space3),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(
                        Icons.event_note_rounded,
                        size: 15,
                        color: scheme.onSurface.withValues(alpha: 0.55),
                      ),
                      const SizedBox(width: 6),
                      Text(
                        scheduleLabel,
                        style: textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
              IntrinsicHeight(
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Expanded(
                      child: _methodCard(
                        icon: Icons.contactless_rounded,
                        accent: AppColors.info,
                        title: 'RFID Tap',
                        children: [
                          Text(
                            'Tap your registered card on the cart reader.',
                            style: textTheme.bodySmall,
                          ),
                          const SizedBox(height: AppSpacing.space2),
                          Row(
                            children: [
                              Container(
                                width: 8,
                                height: 8,
                                decoration: BoxDecoration(
                                  color: deviceDot,
                                  shape: BoxShape.circle,
                                ),
                              ),
                              const SizedBox(width: 6),
                              Expanded(
                                child: Text(
                                  deviceLine,
                                  style: textTheme.bodySmall?.copyWith(
                                    fontWeight: FontWeight.w700,
                                  ),
                                ),
                              ),
                            ],
                          ),
                          Text(
                            deviceDetail,
                            style: textTheme.bodySmall?.copyWith(
                              color: scheme.onSurface.withValues(alpha: 0.6),
                            ),
                          ),
                          const SizedBox(height: AppSpacing.space3),
                          const Spacer(),
                          clockButton(
                            key: const Key('attendance-rfid-action'),
                            label: inDone && outDone
                                ? 'Complete'
                                : (nextEvent == 'OUT' ? 'Tap to time out' : 'Tap to time in'),
                            icon: nextEvent == 'OUT' ? Icons.logout_rounded : Icons.login_rounded,
                            accent: okColor,
                            enabled: nextOpen,
                            onTap: nextOpen && nextEvent != null ? () => widget.onPressed(nextEvent) : null,
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(width: AppSpacing.space2),
                    Expanded(
                      child: _methodCard(
                        icon: Icons.fingerprint_rounded,
                        accent: AppColors.primary,
                        title: 'App Tap',
                        children: [
                          Text(
                            'Record attendance directly on this phone.',
                            style: textTheme.bodySmall,
                          ),
                          const SizedBox(height: AppSpacing.space2),
                          if (online)
                            Text(
                              'Works with your signed-in account',
                              style: textTheme.bodySmall?.copyWith(
                                fontWeight: FontWeight.w700,
                              ),
                            )
                          else
                            Text(
                              'Internet connection is required',
                              style: textTheme.bodySmall?.copyWith(
                                fontWeight: FontWeight.w700,
                                color: AppColors.warn,
                              ),
                            ),
                          Text(
                            online
                                ? 'The server records the exact time'
                                : 'Connect to Wi-Fi or data first',
                            style: textTheme.bodySmall?.copyWith(
                              color: scheme.onSurface.withValues(alpha: 0.6),
                            ),
                          ),
                          const SizedBox(height: AppSpacing.space3),
                          const Spacer(),
                          clockButton(
                            key: const Key('attendance-app-action'),
                            label: inDone && outDone
                                ? 'Complete'
                                : (nextEvent == 'OUT' ? 'TIME OUT' : 'TIME IN'),
                            icon: nextEvent == 'OUT' ? Icons.logout_rounded : Icons.login_rounded,
                            accent: AppColors.primary,
                            enabled: online && nextOpen && !_appTapBusy,
                            busy: _appTapBusy,
                            onTap: (online && nextOpen && !_appTapBusy) ? _appTap : null,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              if (recent.isNotEmpty) ...[
                const SizedBox(height: AppSpacing.space3),
                Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    'Recent activity',
                    style: textTheme.labelSmall?.copyWith(fontWeight: FontWeight.w700),
                  ),
                ),
                const SizedBox(height: 4),
                ...recent.map((s) {
                  final dt = ManilaTime.parse(s['ts']);
                  final isIn = (s['event'] ?? '').toString().toUpperCase() == 'IN';
                  return Padding(
                    padding: const EdgeInsets.symmetric(vertical: 2),
                    child: Row(
                      children: [
                        SizedBox(
                          width: 72,
                          child: Text(
                            dt == null ? '--:--' : ManilaTime.formatClock12(dt),
                            style: textTheme.bodySmall?.copyWith(fontWeight: FontWeight.w700),
                          ),
                        ),
                        SizedBox(
                          width: 34,
                          child: Text(
                            isIn ? 'IN' : 'OUT',
                            style: textTheme.bodySmall?.copyWith(
                              fontWeight: FontWeight.w800,
                              color: isIn ? okColor : dangerColor,
                            ),
                          ),
                        ),
                        Expanded(
                          child: Text(
                            'Recorded via ${_methodOf(s)}',
                            style: textTheme.bodySmall?.copyWith(
                              color: scheme.onSurface.withValues(alpha: 0.6),
                            ),
                          ),
                        ),
                      ],
                    ),
                  );
                }),
              ],
              if (inDone && outDone)
                Padding(
                  padding: const EdgeInsets.only(top: AppSpacing.space3),
                  child: _StatusStrip(
                    icon: Icons.verified_rounded,
                    color: okColor,
                    text: 'Shift complete for today',
                  ),
                )
              else if (caption.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: AppSpacing.space3),
                  child: _StatusStrip(
                    icon: Icons.schedule_rounded,
                    color: null,
                    text: caption,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
/// Full-width footer used for "shift complete" and the closed-window hint.
class _StatusStrip extends StatelessWidget {
  const _StatusStrip({
    required this.icon,
    required this.color,
    required this.text,
  });

  final IconData icon;

  /// Null uses the neutral surface tone instead of a semantic color.
  final Color? color;
  final String text;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final accent = color ?? scheme.onSurface.withValues(alpha: 0.62);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpacing.space3,
        vertical: AppSpacing.space2,
      ),
      decoration: BoxDecoration(
        color: color == null
            ? scheme.onSurface.withValues(alpha: 0.045)
            : color!.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(AppRadius.m),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 15, color: accent),
          const SizedBox(width: AppSpacing.space2),
          Expanded(
            child: Text(
              text,
              style: (Theme.of(context).textTheme.bodySmall ?? const TextStyle())
                  .copyWith(color: accent, fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }
}
/// Password field matching the in-app style: a tinted rounded box with a
/// lock on the left, dots, and an eye toggle on the right.
Widget _passwordField({
  required TextEditingController controller,
  required String label,
  required bool obscure,
  required VoidCallback onToggle,
  String? helperText,
}) {
  return TextField(
    controller: controller,
    obscureText: obscure,
    decoration: InputDecoration(
      labelText: label,
      helperText: helperText,
      helperMaxLines: 2,
      filled: true,
      fillColor: AppColors.infoBg,
      prefixIcon: const Icon(
        Icons.lock_outline_rounded,
        color: AppColors.info,
        size: 19,
      ),
      suffixIcon: IconButton(
        tooltip: obscure ? 'Show password' : 'Hide password',
        onPressed: onToggle,
        icon: Icon(
          obscure
              ? Icons.visibility_off_outlined
              : Icons.visibility_outlined,
          size: 20,
          color: AppColors.info,
        ),
      ),
      // Filled, borderless until focused; a quiet ring on focus.
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppRadius.m),
        borderSide: BorderSide.none,
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppRadius.m),
        borderSide: BorderSide.none,
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(AppRadius.m),
        borderSide: const BorderSide(color: AppColors.info, width: 1.5),
      ),
    ),
  );
}
