import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/api_client.dart';
import '../services/auth_state.dart';
import '../services/offline_pin.dart';
import '../theme.dart';
import '../utils/haptics.dart';
import '../widgets/app_badge.dart';
import '../widgets/pin_pad.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _username = TextEditingController();
  final _password = TextEditingController();
  final _serverController = TextEditingController();
  bool _loading = false;
  bool _checkingOffline = false;
  bool _showPassword = false;
  bool _showServer = false;
  bool _scanning = false;
  String? _error;
  String? _serverMsg;
  bool? _serverOk;

  @override
  void dispose() {
    _username.dispose();
    _password.dispose();
    _serverController.dispose();
    super.dispose();
  }

  Future<void> _rescanServer() async {
    setState(() {
      _scanning = true;
      _serverMsg = 'Scanning local network…';
      _serverOk = null;
    });
    try {
      final url = await context.read<AuthState>().api.rescan();
      if (!mounted) return;
      setState(() {
        _serverMsg = 'Found: $url';
        _serverOk = true;
      });
      await Haptics.success();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _serverMsg = 'Scan failed: $e';
        _serverOk = false;
      });
      await Haptics.error();
    } finally {
      if (mounted) setState(() => _scanning = false);
    }
  }

  Future<void> _saveServer() async {
    final api = context.read<AuthState>().api;
    setState(() {
      _serverMsg = null;
      _serverOk = null;
    });
    try {
      final url = await api.setManualBaseUrl(_serverController.text);
      final ok = await api.testConnection();
      if (!mounted) return;
      setState(() {
        _serverOk = ok;
        _serverMsg = ok
            ? 'Connected: $url'
            : 'Saved $url but no response - is the API running?';
      });
      if (ok) {
        await Haptics.success();
      } else {
        await Haptics.error();
      }
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _serverOk = false;
        _serverMsg = e.message;
      });
      await Haptics.error();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _serverOk = false;
        _serverMsg = 'Connection failed: $e';
      });
      await Haptics.error();
    }
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await context.read<AuthState>().signIn(
        _username.text.trim(),
        _password.text,
      );
      if (!mounted) return;
      await Haptics.success();
      // No imperative navigation here: CartIQApp's home rebuilds from
      // AuthState (logged in -> RootShell, logged out -> LoginScreen).
      // A pushReplacement would strand the shell route on top after a
      // later sign-out, so the login page would never reappear.
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _error = e.message);
      await Haptics.error();
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = 'Login failed: $e');
      await Haptics.error();
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _continueOffline() async {
    final auth = context.read<AuthState>();
    setState(() {
      _checkingOffline = true;
      _error = null;
    });
    // Eligibility gate: never open the PIN pad when failure is certain.
    // Each reason maps to a specific message so the user knows what to do.
    final eligibility = await auth.checkOfflineEligibility();
    if (!mounted) return;
    setState(() => _checkingOffline = false);
    if (!eligibility.eligible) {
      setState(() {
        _error = eligibility.lockedUntil != null
            ? '${eligibility.message} (until ${eligibility.lockedUntil!.hour.toString().padLeft(2, "0")}:${eligibility.lockedUntil!.minute.toString().padLeft(2, "0")})'
            : eligibility.message;
      });
      await Haptics.error();
      return;
    }
    String? error;
    var busy = false;
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
              bottom: MediaQuery.of(context).viewInsets.bottom +
                  AppSpacing.space6,
            ),
            child: PinPad(
              title: 'Device PIN',
              errorText: error,
              onComplete: (pin) async {
                if (busy) return;
                setSheetState(() {
                  busy = true;
                  error = null;
                });
                try {
                  await auth.unlockOffline(pin);
                  await Haptics.success();
                  if (sheetContext.mounted) {
                    Navigator.pop(sheetContext);
                  }
                  // No navigation needed: CartIQApp rebuilds from AuthState.
                } on PinException catch (e) {
                  await Haptics.error();
                  setSheetState(() {
                    busy = false;
                    error = e.lockedUntil != null
                        ? '${e.message} (until ${e.lockedUntil!.hour.toString().padLeft(2, "0")}:${e.lockedUntil!.minute.toString().padLeft(2, "0")})'
                        : e.message;
                  });
                } catch (e) {
                  setSheetState(() {
                    busy = false;
                    error = 'Could not unlock: $e';
                  });
                }
              },
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _forgotPassword() async {
    final loginContext = context;
    final api = loginContext.read<AuthState>().api;
    // Sheet-local flow state: email -> code (PIN pad) -> new password.
    var step = 'email';
    final emailCtrl = TextEditingController();
    final pwCtrl = TextEditingController();
    final pw2Ctrl = TextEditingController();
    String? code;
    String? error;
    String? notice;
    var busy = false;
    var showPw = false;
    try {
      await showModalBottomSheet<void>(
        context: loginContext,
        isScrollControlled: true,
        builder: (sheetContext) => StatefulBuilder(
          builder: (context, setSheetState) {
            Future<void> sendCode() async {
              if (busy) return;
              final email = emailCtrl.text.trim();
              if (email.isEmpty || !email.contains('@')) {
                setSheetState(() => error = 'Enter a valid Gmail address.');
                return;
              }
              setSheetState(() {
                busy = true;
                error = null;
              });
              try {
                // Generic success either way (the server never reveals
                // whether the address is registered).
                final data = await api.forgotPassword(email);
                setSheetState(() {
                  busy = false;
                  notice = (data['message'] as String?) ??
                      'If an account exists for this email, a reset code was sent.';
                  step = 'code';
                });
                await Haptics.success();
              } on ApiException catch (e) {
                await Haptics.error();
                setSheetState(() {
                  busy = false;
                  error = e.message;
                });
              }
            }

            Future<void> redeem() async {
              if (busy || code == null) return;
              if (pwCtrl.text != pw2Ctrl.text) {
                setSheetState(() => error = 'New passwords do not match.');
                return;
              }
              if (pwCtrl.text.length < 6) {
                setSheetState(
                    () => error = 'New password must be at least 6 characters.');
                return;
              }
              // Captured before the async gap (ScaffoldMessenger.of after
              // await trips use_build_context_synchronously).
              final messenger = ScaffoldMessenger.of(loginContext);
              setSheetState(() {
                busy = true;
                error = null;
              });
              try {
                await api.resetPassword(
                  email: emailCtrl.text.trim(),
                  code: code!,
                  newPassword: pwCtrl.text,
                );
                await Haptics.success();
                if (sheetContext.mounted) Navigator.pop(sheetContext);
                if (!mounted) return;
                messenger
                  ..hideCurrentSnackBar()
                  ..showSnackBar(
                    const SnackBar(
                      content:
                          Text('Password updated - sign in with the new password.'),
                      duration: Duration(seconds: 3),
                    ),
                  );
              } on ApiException catch (e) {
                await Haptics.error();
                setSheetState(() {
                  busy = false;
                  error = e.message;
                });
              }
            }

            Widget body;
            if (step == 'email') {
              body = Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text('Reset password',
                      style: Theme.of(context).textTheme.titleLarge),
                  const SizedBox(height: AppSpacing.space2),
                  Text(
                    'Enter the Gmail address saved on your account. We\'ll send a 6-digit code (expires in 10 minutes).',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                  const SizedBox(height: AppSpacing.space4),
                  TextField(
                    controller: emailCtrl,
                    keyboardType: TextInputType.emailAddress,
                    decoration: const InputDecoration(
                      labelText: 'Gmail address',
                      prefixIcon: Icon(Icons.mail_outline),
                    ),
                    onSubmitted: (_) => sendCode(),
                  ),
                  if (error != null) ...[
                    const SizedBox(height: AppSpacing.space2),
                    Text(error!,
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: AppColors.danger)),
                  ],
                  const SizedBox(height: AppSpacing.space4),
                  FilledButton(
                    onPressed: busy ? null : sendCode,
                    child: busy
                        ? const SizedBox(
                            height: 18,
                            width: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text('Send code'),
                  ),
                ],
              );
            } else if (step == 'code') {
              body = PinPad(
                title: 'Reset code',
                errorText: error,
                onComplete: (c) {
                  code = c;
                  setSheetState(() {
                    step = 'password';
                    error = null;
                  });
                },
              );
            } else {
              body = Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text('New password',
                      style: Theme.of(context).textTheme.titleLarge),
                  const SizedBox(height: AppSpacing.space2),
                  if (notice != null)
                    Text(notice!,
                        style: Theme.of(context).textTheme.bodySmall),
                  const SizedBox(height: AppSpacing.space4),
                  TextField(
                    controller: pwCtrl,
                    obscureText: !showPw,
                    decoration: InputDecoration(
                      labelText: 'New password (min 6)',
                      prefixIcon: const Icon(Icons.lock_outline),
                      suffixIcon: IconButton(
                        icon: Icon(showPw
                            ? Icons.visibility_off_rounded
                            : Icons.visibility_rounded),
                        onPressed: () =>
                            setSheetState(() => showPw = !showPw),
                      ),
                    ),
                  ),
                  const SizedBox(height: AppSpacing.space3),
                  TextField(
                    controller: pw2Ctrl,
                    obscureText: !showPw,
                    decoration: const InputDecoration(
                      labelText: 'Confirm new password',
                      prefixIcon: Icon(Icons.lock_outline),
                    ),
                    onSubmitted: (_) => redeem(),
                  ),
                  if (error != null) ...[
                    const SizedBox(height: AppSpacing.space2),
                    Text(error!,
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: AppColors.danger)),
                  ],
                  const SizedBox(height: AppSpacing.space4),
                  FilledButton(
                    onPressed: busy ? null : redeem,
                    child: busy
                        ? const SizedBox(
                            height: 18,
                            width: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text('Set new password'),
                  ),
                ],
              );
            }
            return SafeArea(
              child: Padding(
                padding: EdgeInsets.only(
                  left: AppSpacing.space5,
                  right: AppSpacing.space5,
                  top: AppSpacing.space4,
                  bottom: MediaQuery.of(context).viewInsets.bottom +
                      AppSpacing.space6,
                ),
                child: body,
              ),
            );
          },
        ),
      );
    } finally {
      emailCtrl.dispose();
      pwCtrl.dispose();
      pw2Ctrl.dispose();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
            child: Center(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(AppSpacing.space6),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 380),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 96,
                        height: 96,
                        decoration: BoxDecoration(
                          borderRadius:
                              BorderRadius.circular(AppRadius.xl),
                          boxShadow: [
                            BoxShadow(
                              color: AppColors.primary.withValues(alpha: 0.3),
                              blurRadius: 16,
                              offset: const Offset(0, 6),
                            ),
                          ],
                        ),
                        clipBehavior: Clip.antiAlias,
                        child: Image.asset(
                          'assets/logo.png',
                          fit: BoxFit.cover,
                          errorBuilder: (_, _, _) => Container(
                            color: AppColors.primarySoft,
                            child: const Icon(
                              Icons.point_of_sale_rounded,
                              size: 44,
                              color: AppColors.primary,
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(height: AppSpacing.space3),
                      Text(
                        'CartIQ',
                        style: Theme.of(context).textTheme.headlineMedium,
                      ),
                      Text(
                        'Pota Fries Operations',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                      const SizedBox(height: AppSpacing.space5),
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(AppSpacing.space5),
                      child: Form(
                        key: _formKey,
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            TextFormField(
                              controller: _username,
                              decoration: const InputDecoration(
                                labelText: 'Username',
                                prefixIcon: Icon(Icons.person_outline),
                              ),
                              validator: (v) => (v == null || v.trim().isEmpty)
                                  ? 'Enter username'
                                  : null,
                            ),
                            const SizedBox(height: AppSpacing.space4),
                            TextFormField(
                              controller: _password,
                              obscureText: !_showPassword,
                              decoration: InputDecoration(
                                labelText: 'Password',
                                prefixIcon: const Icon(Icons.lock_outline),
                                suffixIcon: IconButton(
                                  icon: Icon(
                                    _showPassword
                                        ? Icons.visibility_off_rounded
                                        : Icons.visibility_rounded,
                                  ),
                                  tooltip: _showPassword
                                      ? 'Hide password'
                                      : 'Show password',
                                  onPressed: () => setState(
                                    () => _showPassword = !_showPassword,
                                  ),
                                ),
                              ),
                              validator: (v) => (v == null || v.isEmpty)
                                  ? 'Enter password'
                                  : null,
                              onFieldSubmitted: (_) =>
                                  _loading ? null : _submit(),
                            ),
                            const SizedBox(height: AppSpacing.space4),
                            if (_error != null)
                              Padding(
                                padding: const EdgeInsets.only(
                                    bottom: AppSpacing.space3),
                                child: Text(
                                  _error!,
                                  style: const TextStyle(
                                    color: AppColors.danger,
                                  ),
                                  textAlign: TextAlign.center,
                                ),
                              ),
                            FilledButton(
                              onPressed: _loading ? null : _submit,
                              child: _loading
                                  ? const SizedBox(
                                      height: 18,
                                      width: 18,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                      ),
                                    )
                                  : const Text('Sign in'),
                            ),
                            const SizedBox(height: AppSpacing.space2),
                            TextButton(
                              onPressed: (_loading || _checkingOffline)
                                  ? null
                                  : _continueOffline,
                              child: _checkingOffline
                                  ? const SizedBox(
                                      height: 18,
                                      width: 18,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                      ),
                                    )
                                  : const Text('Continue offline'),
                            ),
                            const SizedBox(height: AppSpacing.space1),
                            Text(
                              'No signal? Staff with a device PIN can open the POS offline.',
                              textAlign: TextAlign.center,
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                            TextButton(
                              onPressed: _loading ? null : _forgotPassword,
                              child: const Text('Forgot password?'),
                            ),
                            const SizedBox(height: AppSpacing.space3),
                            Text(
                              'First login after idle can take a few seconds while the server warms up — retry once if it times out.',
                              textAlign: TextAlign.center,
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: AppSpacing.space3),
                  _ServerCard(
                    showServer: _showServer,
                    onToggle: () => setState(() => _showServer = !_showServer),
                    scanning: _scanning,
                    onRescan: _rescanServer,
                    serverController: _serverController,
                    onSave: _saveServer,
                    serverMsg: _serverMsg,
                    serverOk: _serverOk,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ServerCard extends StatelessWidget {
  const _ServerCard({
    required this.showServer,
    required this.onToggle,
    required this.scanning,
    required this.onRescan,
    required this.serverController,
    required this.onSave,
    required this.serverMsg,
    required this.serverOk,
  });

  final bool showServer;
  final VoidCallback onToggle;
  final bool scanning;
  final VoidCallback onRescan;
  final TextEditingController serverController;
  final VoidCallback onSave;
  final String? serverMsg;
  final bool? serverOk;

  @override
  Widget build(BuildContext context) {
    final api = context.watch<AuthState>().api;
    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.space4,
          vertical: AppSpacing.space2,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            TextButton.icon(
              onPressed: onToggle,
              icon: Icon(
                showServer
                    ? Icons.expand_less_rounded
                    : Icons.expand_more_rounded,
                size: 18,
              ),
              label: const Text('Server'),
            ),
            if (showServer) ...[
              SelectableText(
                api.currentBaseUrl,
                textAlign: TextAlign.center,
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(fontFamily: 'monospace'),
              ),
              if (api.isManualUrl)
                const Center(
                  child: Padding(
                    padding: EdgeInsets.only(top: AppSpacing.space1),
                    child: AppBadge(
                      label: 'manual override',
                      variant: AppBadgeVariant.neutral,
                    ),
                  ),
                ),
              const SizedBox(height: AppSpacing.space2),
              if (serverMsg != null)
                Padding(
                  padding:
                      const EdgeInsets.only(bottom: AppSpacing.space2),
                  child: Text(
                    serverMsg!,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color: serverOk == true
                          ? AppColors.ok
                          : serverOk == false
                          ? AppColors.danger
                          : null,
                    ),
                  ),
                ),
              OutlinedButton.icon(
                onPressed: scanning ? null : onRescan,
                icon: scanning
                    ? const SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.radar_rounded, size: 18),
                label: const Text('Rescan'),
              ),
              const SizedBox(height: AppSpacing.space2),
              TextField(
                controller: serverController,
                keyboardType: TextInputType.url,
                decoration: const InputDecoration(
                  labelText: 'Server IP or host',
                  hintText: '192.168.1.5',
                  prefixIcon: Icon(Icons.dns_outlined),
                  isDense: true,
                ),
                onSubmitted: (_) => onSave(),
              ),
              const SizedBox(height: AppSpacing.space2),
              OutlinedButton(
                onPressed: onSave,
                child: const Text('Save & test connection'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
