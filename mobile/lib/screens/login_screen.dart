import 'dart:ui';
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
      _serverMsg = 'Scanning local network...';
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
                const SizedBox(height: AppSpacing.space3),
                PinPad(
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
              ],
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _forgotPassword() async {
    final loginContext = context;
    final api = loginContext.read<AuthState>().api;
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
        backgroundColor: Theme.of(context).colorScheme.surface,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
        ),
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
                final data = await api.forgotPassword(email);
                setSheetState(() {
                  busy = false;
                  notice =
                      (data['message'] as String?) ??
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
                  () => error = 'New password must be at least 6 characters.',
                );
                return;
              }
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
                      content: Text(
                        'Password updated - sign in with the new password.',
                      ),
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
                  Text(
                    'Reset password',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
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
                    Text(
                      error!,
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: AppColors.danger),
                    ),
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
                  Text(
                    'New password',
                    style: Theme.of(context).textTheme.titleLarge,
                  ),
                  const SizedBox(height: AppSpacing.space2),
                  if (notice != null)
                    Text(notice!, style: Theme.of(context).textTheme.bodySmall),
                  const SizedBox(height: AppSpacing.space4),
                  TextField(
                    controller: pwCtrl,
                    obscureText: !showPw,
                    decoration: InputDecoration(
                      labelText: 'New password (min 6)',
                      prefixIcon: const Icon(Icons.lock_outline),
                      suffixIcon: IconButton(
                        icon: Icon(
                          showPw
                              ? Icons.visibility_off_rounded
                              : Icons.visibility_rounded,
                        ),
                        onPressed: () => setSheetState(() => showPw = !showPw),
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
                    Text(
                      error!,
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: AppColors.danger),
                    ),
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
                  bottom:
                      MediaQuery.of(context).viewInsets.bottom +
                      AppSpacing.space6,
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
                    const SizedBox(height: AppSpacing.space3),
                    body,
                  ],
                ),
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
      backgroundColor: Theme.of(context).scaffoldBackgroundColor,
      body: Stack(
        children: [
          // 1. Subtle Background Tilted Grid Dot
          Positioned.fill(
            child: CustomPaint(
              painter: _DotGridPainter(
                color: Theme.of(context).dividerColor.withValues(alpha: 0.15),
                spacing: 24.0,
                angle: -0.15,
              ),
            ),
          ),

          // 2. Main Content
          SingleChildScrollView(
            child: Column(
              children: [
                // Header
                const _MobileHeroHeader(),

                // Login Form Card
                Transform.translate(
                  offset: const Offset(0, -64),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: AppSpacing.space6,
                    ),
                    child: Container(
                      constraints: const BoxConstraints(maxWidth: 400),
                      decoration: BoxDecoration(
                        color: Theme.of(context).colorScheme.surface,
                        borderRadius: BorderRadius.circular(AppRadius.xl),
                        boxShadow: AppShadow.md(),
                        // Tinanggal ang border para consistent at borderless
                      ),
                      padding: const EdgeInsets.all(AppSpacing.space6),
                      child: Form(
                        key: _formKey,
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            const Text(
                              'Welcome back',
                              style: TextStyle(
                                fontSize: 28,
                                fontWeight: FontWeight.w800,
                                letterSpacing: -0.5,
                              ),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              'Protected operations POS portal.',
                              style: Theme.of(context).textTheme.bodyMedium
                                  ?.copyWith(
                                    fontWeight: FontWeight.w500,
                                    color: AppColors.muted,
                                  ),
                            ),
                            const SizedBox(height: 32),

                            const Text(
                              'Username',
                              style: TextStyle(
                                fontSize: 13,
                                fontWeight: FontWeight.bold,
                                color: AppColors.accent,
                              ),
                            ),
                            const SizedBox(height: 8),
                            TextFormField(
                              controller: _username,
                              decoration: const InputDecoration(
                                prefixIcon: Icon(Icons.person_outline),
                              ),
                              validator: (v) => (v == null || v.trim().isEmpty)
                                  ? 'Enter username'
                                  : null,
                            ),

                            const SizedBox(height: 24),
                            const Text(
                              'Password',
                              style: TextStyle(
                                fontSize: 13,
                                fontWeight: FontWeight.bold,
                                color: AppColors.accent,
                              ),
                            ),
                            const SizedBox(height: 8),
                            TextFormField(
                              controller: _password,
                              obscureText: !_showPassword,
                              decoration: InputDecoration(
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

                            const SizedBox(height: 24),
                            if (_error != null)
                              Padding(
                                padding: const EdgeInsets.only(
                                  bottom: AppSpacing.space3,
                                ),
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
                              style: FilledButton.styleFrom(
                                padding: const EdgeInsets.symmetric(
                                  vertical: 16,
                                ),
                                textStyle: const TextStyle(
                                  fontWeight: FontWeight.w800,
                                  letterSpacing: 1.5,
                                ),
                              ),
                              child: _loading
                                  ? const SizedBox(
                                      height: 18,
                                      width: 18,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                        color: Colors.white,
                                      ),
                                    )
                                  : const Row(
                                      mainAxisAlignment:
                                          MainAxisAlignment.center,
                                      children: [
                                        Text('SIGN IN'),
                                        SizedBox(width: 8),
                                        Icon(
                                          Icons.arrow_forward_rounded,
                                          size: 20,
                                        ),
                                      ],
                                    ),
                            ),
                            const SizedBox(height: 16),
                            Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                TextButton(
                                  onPressed: (_loading || _checkingOffline)
                                      ? null
                                      : _continueOffline,
                                  style: TextButton.styleFrom(
                                    padding: EdgeInsets.zero,
                                  ),
                                  child: _checkingOffline
                                      ? const SizedBox(
                                          height: 16,
                                          width: 16,
                                          child: CircularProgressIndicator(
                                            strokeWidth: 2,
                                          ),
                                        )
                                      : const Text(
                                          'Continue offline',
                                          style: TextStyle(
                                            fontWeight: FontWeight.w700,
                                          ),
                                        ),
                                ),
                                TextButton(
                                  onPressed: _loading ? null : _forgotPassword,
                                  style: TextButton.styleFrom(
                                    padding: EdgeInsets.zero,
                                  ),
                                  child: const Text(
                                    'Forgot password?',
                                    style: TextStyle(
                                      fontWeight: FontWeight.w700,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),

                const SizedBox(height: 8),
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    const Icon(
                      Icons.shield_outlined,
                      size: 14,
                      color: Colors.grey,
                    ),
                    const SizedBox(width: 8),
                    Text(
                      'ENTERPRISE-GRADE SECURITY',
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        fontWeight: FontWeight.w800,
                        letterSpacing: 1.2,
                        fontSize: 11,
                      ),
                    ),
                  ],
                ),

                const SizedBox(height: 32),
                Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: AppSpacing.space6,
                  ),
                  child: _ServerCard(
                    showServer: _showServer,
                    onToggle: () => setState(() => _showServer = !_showServer),
                    scanning: _scanning,
                    onRescan: _rescanServer,
                    serverController: _serverController,
                    onSave: _saveServer,
                    serverMsg: _serverMsg,
                    serverOk: _serverOk,
                  ),
                ),
                const SizedBox(height: 48),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _MobileHeroHeader extends StatelessWidget {
  const _MobileHeroHeader();

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      height: 320,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Positioned.fill(
            child: Container(
              decoration: const BoxDecoration(
                borderRadius: BorderRadius.vertical(
                  bottom: Radius.circular(40),
                ),
                gradient: RadialGradient(
                  center: Alignment.topLeft,
                  radius: 1.5,
                  colors: [AppColors.highlightSoft, AppColors.cream],
                  stops: [0.0, 0.8],
                ),
              ),
            ),
          ),
          Positioned(
            top: -40,
            right: -40,
            child: Container(
              width: 180,
              height: 180,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: AppColors.primarySoft.withValues(alpha: 0.8),
              ),
            ),
          ),
          Positioned(
            bottom: 40,
            left: -40,
            child: Container(
              width: 160,
              height: 160,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: AppColors.highlight.withValues(alpha: 0.3),
              ),
            ),
          ),
          Positioned.fill(
            child: ClipRRect(
              borderRadius: const BorderRadius.vertical(
                bottom: Radius.circular(40),
              ),
              child: BackdropFilter(
                filter: ImageFilter.blur(sigmaX: 24, sigmaY: 24),
                child: Container(color: Colors.transparent),
              ),
            ),
          ),
          Align(
            alignment: Alignment.topCenter,
            child: Padding(
              padding: const EdgeInsets.only(top: 64),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(
                    width: 72,
                    height: 72,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(20),
                      boxShadow: [
                        BoxShadow(
                          color: AppColors.primary.withValues(alpha: 0.4),
                          blurRadius: 16,
                          offset: const Offset(0, 6),
                        ),
                      ],
                      image: const DecorationImage(
                        image: AssetImage('assets/logo.png'),
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),
                  const Text(
                    'CartIQ',
                    style: TextStyle(
                      fontSize: 32,
                      fontWeight: FontWeight.w800,
                      color: AppColors.accent,
                      letterSpacing: -0.5,
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
    final surfaceColor = Theme.of(context).colorScheme.surface;

    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: surfaceColor,
        borderRadius: BorderRadius.circular(AppRadius.l),
        boxShadow: AppShadow.sm(),
      ),
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
              label: const Text('Server configuration'),
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
                  padding: const EdgeInsets.only(bottom: AppSpacing.space2),
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
                label: const Text('Rescan network'),
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

class _DotGridPainter extends CustomPainter {
  final Color color;
  final double spacing;
  final double angle;

  _DotGridPainter({
    required this.color,
    this.spacing = 24.0,
    this.angle = -0.15,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.fill;

    canvas.save();
    canvas.translate(size.width / 2, size.height / 2);
    canvas.rotate(angle);

    final double maxBounds = size.longestSide;
    for (double x = -maxBounds; x < maxBounds; x += spacing) {
      for (double y = -maxBounds; y < maxBounds; y += spacing) {
        canvas.drawCircle(Offset(x, y), 1.5, paint);
      }
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant _DotGridPainter oldDelegate) {
    return oldDelegate.color != color ||
        oldDelegate.spacing != spacing ||
        oldDelegate.angle != angle;
  }
}
