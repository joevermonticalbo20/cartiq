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
import '../config.dart';
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
  PinEligibility? _eligibility;

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
    final eligibility = await auth.checkOfflineEligibility();
    await auth.refreshTimeClock();
    await auth.refreshMyShifts();

    if (mounted) {
      setState(() {
        _hasPin = hasPin;
        _lastOnline = lastOnline;
        _eligibility = eligibility;
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
    final open = event == 'IN' ? auth.clockInOpen : auth.clockOutOpen;
    if (!open) {
      AppMessenger.showGlassToast(
        context: context,
        message: auth.clockHint(event),
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
          title: const Text('Recovery email'),
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
                  helperText: codeCheck == 'valid'
                      ? 'Code verified. You can save it now.'
                      : codeCheck == 'invalid'
                          ? (codeExpired
                              ? 'That code has expired. Send a new one.'
                              : 'That code does not match. Check the digits.')
                          : codeSent
                              ? 'A 6-digit code was sent to that email.'
                              : 'Send a code to that email first.',
                  helperStyle: TextStyle(
                    color: codeCheck == 'valid'
                        ? AppColors.ok
                        : codeCheck == 'invalid'
                            ? AppColors.danger
                            : null,
                    fontWeight: codeCheck == 'idle' ? null : FontWeight.w600,
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
                  suffixIcon: TextButton(
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
                ),
              ),
              const SizedBox(height: AppSpacing.space3),
              TextField(
                controller: password,
                obscureText: obscure,
                decoration: const InputDecoration(
                  labelText: 'Current password',
                  helperText:
                      'Required so a stolen session cannot redirect recovery',
                ),
              ),              if (error != null) ...[
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
              onPressed: () => setDialogState(() => obscure = !obscure),
              child: Text(obscure ? 'Show' : 'Hide'),
            ),
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
          return AlertDialog(
            title: const Text('Change password'),
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextField(
                    controller: current,
                    obscureText: obscure,
                    decoration: const InputDecoration(
                      labelText: 'Current password',
                    ),
                  ),
                  const SizedBox(height: AppSpacing.space3),
                  TextField(
                    controller: code,
                    keyboardType: TextInputType.number,
                    maxLength: 6,
                    inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                    decoration: const InputDecoration(
                      labelText: 'Email code',
                      counterText: '',
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
                    Text(notice!, style: Theme.of(context).textTheme.bodySmall),
                  ],
                  const SizedBox(height: AppSpacing.space3),
                  TextField(
                    controller: next,
                    obscureText: obscure,
                    decoration: const InputDecoration(
                      labelText: 'New password',
                    ),
                  ),
                  const SizedBox(height: AppSpacing.space3),
                  TextField(
                    controller: confirm,
                    obscureText: obscure,
                    decoration: const InputDecoration(
                      labelText: 'Confirm new password',
                    ),
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
            ),
            actions: [
              TextButton(
                onPressed: () => setDialogState(() => obscure = !obscure),
                child: Text(obscure ? 'Show' : 'Hide'),
              ),
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
          if (auth.hasRfidCard) ...[
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

          const SectionHeader(title: 'Notifications', eyebrow: 'For you'),
          const SizedBox(height: AppSpacing.space3),
          const _NotificationsSection(),
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
                  _PremiumTile(
                    icon: Icons.dns_outlined,
                    iconColor: Colors.deepPurple,
                    title: 'Backend',
                    subtitle: AppConfig.apiBaseUrl,
                  ),
                  const _PremiumTile(
                    icon: Icons.security_outlined,
                    iconColor: Colors.teal,
                    title: 'Disabled accounts',
                    subtitle:
                        'Stop working within 7 days offline, immediately when online.',
                  ),
                  _PremiumTile(
                    icon: Icons.offline_bolt_outlined,
                    iconColor: _eligibility != null && _eligibility!.eligible
                        ? AppColors.ok
                        : AppColors.warn,
                    title: 'Offline login',
                    subtitle: _eligibility == null
                        ? 'Checking...'
                        : _eligibility!.eligible
                        ? 'Ready • PIN set for this staff account'
                        : _eligibility!.message,
                    trailing: _eligibility == null
                        ? null
                        : AppBadge(
                            label: _eligibility!.eligible
                                ? 'READY'
                                : 'NOT READY',
                            variant: _eligibility!.eligible
                                ? AppBadgeVariant.ok
                                : AppBadgeVariant.neutral,
                          ),
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

/// The Time in / Time out pair. Sits directly under the card tile because the
/// two are one task: register once, then clock in every day.
///
/// The cart-wide clock windows (web dashboard → Settings → Time clock) can
/// grey either button out until its window opens. The state is computed live
/// from the owner-configured config, so the 30s sync in [AuthState] opens the
/// buttons on time without a manual refresh.
class _TimeRow extends StatelessWidget {
  const _TimeRow({required this.auth, required this.onPressed});

  final AuthState auth;
  final void Function(String event) onPressed;

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

  @override
  Widget build(BuildContext context) {
    final inAt = auth.myInAtToday;
    final outAt = auth.myOutAtToday;
    final inDone = inAt != null;
    final outDone = outAt != null;
    final canIn = auth.clockInOpen && !inDone;
    final canOut = auth.clockOutOpen && !outDone;
    final dayOpen = auth.timeClockDayOpen;
    final caption = auth.timeClockCaption();
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final okColor = isDark ? const Color(0xFF4ADE80) : AppColors.ok;
    final dangerColor = isDark ? const Color(0xFFF87171) : AppColors.danger;

    final String badge;
    final AppBadgeVariant badgeVariant;
    if (inDone && outDone) {
      badge = 'Complete';
      badgeVariant = AppBadgeVariant.ok;
    } else if (inDone) {
      badge = 'On shift';
      badgeVariant = AppBadgeVariant.ok;
    } else if (outDone) {
      badge = 'Timed out';
      badgeVariant = AppBadgeVariant.neutral;
    } else if (!dayOpen) {
      badge = 'Closed';
      badgeVariant = AppBadgeVariant.neutral;
    } else {
      badge = 'Not clocked in';
      badgeVariant = AppBadgeVariant.neutral;
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
                          'Tap your card on the reader',
                          style: textTheme.bodySmall,
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: AppSpacing.space2),
                  AppBadge(label: badge, variant: badgeVariant),
                ],
              ),
              const SizedBox(height: AppSpacing.space4),
              IntrinsicHeight(
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Expanded(
                      child: _ClockTile(
                        key: const Key('attendance-time-in'),
                        label: 'Time in',
                        icon: Icons.login_rounded,
                        accent: okColor,
                        done: inDone,
                        at: inAt,
                        onTap: canIn ? () => onPressed('IN') : null,
                      ),
                    ),
                    const SizedBox(width: AppSpacing.space2),
                    Expanded(
                      child: _ClockTile(
                        key: const Key('attendance-time-out'),
                        label: 'Time out',
                        icon: Icons.logout_rounded,
                        accent: dangerColor,
                        done: outDone,
                        at: outAt,
                        onTap: canOut ? () => onPressed('OUT') : null,
                      ),
                    ),
                  ],
                ),
              ),
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

/// One half of the attendance card: a tappable clock state with the recorded
/// time at display size. Locked and recorded states are visibly distinct, so
/// staff can tell at a glance whether the action is still available.
class _ClockTile extends StatelessWidget {
  const _ClockTile({
    super.key,
    required this.label,
    required this.icon,
    required this.accent,
    required this.done,
    required this.at,
    required this.onTap,
  });

  final String label;
  final IconData icon;
  final Color accent;
  final bool done;
  final DateTime? at;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final active = onTap != null;
    final accentColor = done || active ? accent : AppColors.muted;
    final background = done
        ? accent.withValues(alpha: 0.09)
        : active
        ? accent.withValues(alpha: 0.07)
        : scheme.onSurface.withValues(alpha: 0.045);
    final border = done
        ? accent.withValues(alpha: 0.28)
        : active
        ? accent.withValues(alpha: 0.32)
        : scheme.onSurface.withValues(alpha: 0.12);

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppRadius.l),
        child: Container(
          padding: const EdgeInsets.all(AppSpacing.space3),
          decoration: BoxDecoration(
            color: background,
            borderRadius: BorderRadius.circular(AppRadius.l),
            border: Border.all(color: border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(icon, size: 15, color: accentColor),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      label.toUpperCase(),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: textTheme.labelSmall?.copyWith(
                        color: accentColor,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 0.8,
                      ),
                    ),
                  ),
                  if (done)
                    Icon(Icons.check_circle_rounded, size: 16, color: accent),
                ],
              ),
              const SizedBox(height: AppSpacing.space2),
              Text(
                done ? ManilaTime.formatClock12(at!) : '—',
                maxLines: 1,
                style: textTheme.headlineSmall?.copyWith(
                  fontSize: 23,
                  fontWeight: FontWeight.w800,
                  letterSpacing: -0.4,
                  height: 1.05,
                  color: done
                      ? null
                      : AppColors.muted.withValues(alpha: 0.55),
                ),
              ),
              const SizedBox(height: 3),
              Row(
                children: [
                  Icon(
                    done
                        ? Icons.check_rounded
                        : active
                        ? Icons.contactless_rounded
                        : Icons.lock_clock_rounded,
                    size: 13,
                    color: done || active ? accent : AppColors.muted,
                  ),
                  const SizedBox(width: 4),
                  Expanded(
                    child: Text(
                      done
                          ? 'Recorded'
                          : active
                          ? 'Tap card'
                          : 'Locked',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: textTheme.labelSmall?.copyWith(
                        color: done || active ? accent : AppColors.muted,
                        fontWeight: FontWeight.w700,
                        fontSize: 11.5,
                      ),
                    ),
                  ),
                ],
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

class _NotificationsSection extends StatefulWidget {
  const _NotificationsSection();

  @override
  State<_NotificationsSection> createState() => _NotificationsSectionState();
}

class _NotificationsSectionState extends State<_NotificationsSection> {
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _refresh());
  }

  Future<void> _refresh() async {
    // The screen can be gone by the time the post-frame callback runs (the
    // person navigated away). Touching `context` after that throws.
    if (!mounted) return;
    setState(() => _loading = true);
    await context.read<AuthState>().refreshMyAlerts();
    if (mounted) setState(() => _loading = false);
  }

  IconData _iconFor(Map<String, dynamic> alert) {
    final t = (alert['type'] as String? ?? '').toLowerCase();
    if (t.contains('void')) return Icons.cancel_rounded;
    if (t.contains('restock')) return Icons.inventory_2_outlined;
    return Icons.notifications_outlined;
  }

  String _when(String? iso) {
    final dt = DateTime.tryParse(iso ?? '');
    if (dt == null) return '';
    final diff = DateTime.now().difference(dt);
    if (diff.inMinutes < 1) return 'just now';
    if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
    if (diff.inHours < 24) return '${diff.inHours}h ago';
    return '${diff.inDays}d ago';
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthState>();
    final offline = auth.offlineMode || auth.token == null;
    final items = auth.myAlerts;
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
            Padding(
              padding: const EdgeInsets.fromLTRB(
                AppSpacing.space4,
                AppSpacing.space4,
                AppSpacing.space4,
                AppSpacing.space2,
              ),
              child: Row(
                children: [
                  Icon(
                    Icons.notifications_outlined,
                    color: AppColors.primary,
                    size: 20,
                  ),
                  const SizedBox(width: AppSpacing.space3),
                  Expanded(
                    child: Text(
                      'Notifications',
                      style: Theme.of(context).textTheme.titleSmall?.copyWith(
                            fontWeight: FontWeight.w700,
                          ),
                    ),
                  ),
                  if (_loading)
                    const SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  else ...[
                    if (items.isNotEmpty)
                      TextButton(
                        style: TextButton.styleFrom(
                          minimumSize: const Size(0, 36),
                          padding: const EdgeInsets.symmetric(horizontal: 8),
                        ),
                        onPressed: () => auth.markAllMyAlertsRead(),
                        child: const Text('Mark all read'),
                      ),
                    IconButton(
                      icon: const Icon(Icons.refresh_rounded, size: 20),
                      tooltip: 'Refresh',
                      onPressed: offline ? null : _refresh,
                    ),
                  ],
                ],
              ),
            ),
            if (offline) ...[
              const Divider(height: 1, indent: 72),
              Padding(
                padding: const EdgeInsets.all(AppSpacing.space4),
                child: Row(
                  children: [
                    const Icon(
                      Icons.cloud_off_rounded,
                      size: 18,
                      color: AppColors.warn,
                    ),
                    const SizedBox(width: AppSpacing.space3),
                    Expanded(
                      child: Text(
                        'Notifications refresh when you are online.',
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                              color: AppColors.warn,
                              fontWeight: FontWeight.w600,
                            ),
                      ),
                    ),
                  ],
                ),
              ),
            ] else if (items.isEmpty) ...[
              const Divider(height: 1, indent: 72),
              Padding(
                padding: const EdgeInsets.all(AppSpacing.space4),
                child: Text(
                  'No notifications yet.',
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: AppColors.muted,
                      ),
                ),
              ),
            ] else ...[
              for (int i = 0; i < items.length; i++) ...[
                const Divider(height: 1, indent: 72),
                ListTile(
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.space4,
                    vertical: AppSpacing.space2,
                  ),
                  leading: CircleAvatar(
                    radius: 18,
                    backgroundColor: AppColors.primary.withValues(alpha: 0.12),
                    child: Icon(
                      _iconFor(items[i]),
                      size: 18,
                      color: AppColors.primary,
                    ),
                  ),
                  title: Text(
                    items[i]['title']?.toString() ??
                        items[i]['type']?.toString() ??
                        'Update',
                    style: const TextStyle(fontWeight: FontWeight.w700),
                  ),
                  subtitle: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (items[i]['message'] != null)
                        Text(
                          items[i]['message'].toString(),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                      const SizedBox(height: 2),
                      Text(
                        _when(items[i]['createdAt']?.toString()),
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                              color: AppColors.muted,
                            ),
                      ),
                    ],
                  ),
                  trailing: const Icon(
                    Icons.chevron_right_rounded,
                    size: 20,
                    color: Colors.grey,
                  ),
                  onTap: () => auth.markMyAlertRead(
                    (items[i]['id'] as num).toInt(),
                  ),
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }
}
