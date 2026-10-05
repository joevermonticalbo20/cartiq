import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'screens/login_screen.dart';
import 'screens/root_shell.dart';
import 'services/api_client.dart';
import 'services/auth_state.dart';
import 'services/persisted_queue.dart';
import 'services/sync_service.dart';
import 'state/cart_state.dart';
import 'state/theme_controller.dart';
import 'theme.dart';
import 'utils/haptics.dart';
import 'widgets/brand_hero.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Everything below runs BEFORE runApp(). In release there is no red error
  // screen, so any uncaught throw here leaves the operator staring at a blank
  // white window with no way out - which is exactly the symptom reported
  // after installing the APK. Two realistic triggers: sqflite refusing to open
  // cartiq_queue.db (corrupt/locked after an interrupted write), and
  // flutter_secure_storage throwing when the Android Keystore can no longer
  // decrypt its entries (device restore or a changed signing key).
  //
  // Both are handled internally by their services now, but this stays as a
  // backstop: startup degrades, it never blanks.
  final startupWarnings = <String>[];

  try {
    await PersistedOfflineQueue.instance.open();
    if (PersistedOfflineQueue.instance.isDegraded) {
      startupWarnings.add(
        'Offline storage unavailable - unsynced sales will not survive '
        'closing the app.',
      );
    }
  } catch (e) {
    startupWarnings.add('Offline storage unavailable ($e).');
  }

  final api = ApiClient();
  final auth = AuthState(apiClient: api);
  final sync = SyncService(api: api, auth: auth, queue: PersistedOfflineQueue.instance);
  final themeController = ThemeController();
  try {
    await themeController.load();
  } catch (e) {
    startupWarnings.add('Saved preferences unavailable ($e).');
  }

  // Show UI immediately; server discovery runs behind the splash so a slow
  // /24 scan never leaves the user on a black screen.
  runApp(_BootApp(
    api: api,
    auth: auth,
    sync: sync,
    themeController: themeController,
    startupWarnings: startupWarnings,
  ));
}

/// Startup splash: finds the API on the LAN in the background with progress,
/// Skip (use fallback), and manual-IP entry. Never blocks the UI.
class _BootApp extends StatefulWidget {
  const _BootApp({
    required this.api,
    required this.auth,
    required this.sync,
    required this.themeController,
    this.startupWarnings = const [],
  });

  final ApiClient api;
  final AuthState auth;
  final SyncService sync;
  final ThemeController themeController;

  /// Non-fatal problems hit while starting up (degraded offline storage, an
  /// unreadable preference store). Shown on the splash so a degraded POS is
  /// never silently degraded.
  final List<String> startupWarnings;

  @override
  State<_BootApp> createState() => _BootAppState();
}

class _BootAppState extends State<_BootApp> {
  bool _done = false;
  bool _skipped = false;
  String? _error;
  final _manualController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _discover();
  }

  @override
  void dispose() {
    _manualController.dispose();
    super.dispose();
  }

  Future<void> _discover() async {
    try {
      await widget.api.ensureResolved().timeout(const Duration(seconds: 15));
    } catch (_) {
      // Timeout or scan failure - stay on the splash and let the user
      // skip or type the server manually instead of hanging.
      if (mounted && !_skipped) {
        setState(() => _error = 'Auto-discovery is taking a while.');
      }
      return;
    }
    if (mounted && !_skipped) setState(() => _done = true);
  }

  void _skip() {
    Haptics.tap();
    widget.api.useFallback();
    setState(() {
      _skipped = true;
      _done = true;
    });
  }

  Future<void> _useManual() async {
    try {
      await widget.api.setManualBaseUrl(_manualController.text);
      if (!mounted) return;
      setState(() => _done = true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_done) {
      return CartIQApp(
        auth: widget.auth,
        sync: widget.sync,
        themeController: widget.themeController,
      );
    }
    return MaterialApp(
      title: 'CartIQ POS',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      home: Scaffold(
        body: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(AppSpacing.space6),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 360),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const BrandHero(compact: true),
                    const SizedBox(height: AppSpacing.space4),
                    Text('Finding CartIQ server…',
                        style: Theme.of(context).textTheme.titleMedium),
                    const SizedBox(height: AppSpacing.space3),
                    const SizedBox(
                      width: 28,
                      height: 28,
                      child: CircularProgressIndicator(strokeWidth: 3),
                    ),
                    if (_error != null) ...[
                      const SizedBox(height: AppSpacing.space3),
                      Text(_error!,
                          textAlign: TextAlign.center,
                          style: Theme.of(context).textTheme.bodySmall),
                    ],
                    for (final w in widget.startupWarnings) ...[
                      const SizedBox(height: AppSpacing.space3),
                      Container(
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: Theme.of(context).colorScheme.errorContainer,
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Text(
                          w,
                          textAlign: TextAlign.center,
                          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                                color: Theme.of(context).colorScheme.onErrorContainer,
                              ),
                        ),
                      ),
                    ],
                    const SizedBox(height: AppSpacing.space5),
                    OutlinedButton(
                      onPressed: _skip,
                      child: const Text('Skip - enter later'),
                    ),
                    const SizedBox(height: AppSpacing.space4),
                    const Divider(),
                    const SizedBox(height: AppSpacing.space2),
                    Text('Or enter the server manually',
                        style: Theme.of(context).textTheme.bodySmall),
                    const SizedBox(height: AppSpacing.space2),
                    TextField(
                      controller: _manualController,
                      keyboardType: TextInputType.url,
                      decoration: const InputDecoration(
                        labelText: 'Server (IP or host)',
                        hintText: '192.168.1.5',
                        prefixIcon: Icon(Icons.dns_outlined),
                      ),
                      onSubmitted: (_) => _useManual(),
                    ),
                    const SizedBox(height: AppSpacing.space3),
                    FilledButton(
                      onPressed: _useManual,
                      child: const Text('Connect'),
                    ),
                    const SizedBox(height: AppSpacing.space5),
                    Text(
                      'Pota Fries • Staff POS • v1.0.0',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class CartIQApp extends StatefulWidget {
  const CartIQApp({
    super.key,
    required this.auth,
    required this.sync,
    required this.themeController,
  });

  final AuthState auth;
  final SyncService sync;
  final ThemeController themeController;

  @override
  State<CartIQApp> createState() => _CartIQAppState();
}

class _CartIQAppState extends State<CartIQApp> {
  late final Future<void> _restoreFuture;
  late final SyncLifecycleObserver _syncObserver;

  /// Last state we handed to the sync service, so start/stop happens once
  /// per transition rather than on every rebuild.
  bool? _syncRunning;

  @override
  void initState() {
    super.initState();
    _restoreFuture = widget.auth.restoreSession();
    _syncObserver = SyncLifecycleObserver(widget.sync);
    WidgetsBinding.instance.addObserver(_syncObserver);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(_syncObserver);
    // Stop on the way out so a timer is never left running after teardown.
    try {
      widget.sync.stop();
    } catch (_) {}
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider.value(value: widget.auth),
        ChangeNotifierProvider.value(value: widget.themeController),
        ChangeNotifierProvider.value(value: widget.sync),
        ChangeNotifierProvider(create: (_) => CartState()),
      ],
      child: Consumer2<ThemeController, AuthState>(
        builder: (context, theme, auth, _) {
          // Sync is started/stopped from a post-frame callback, never from
          // build(): a throw inside build() is a build error, and in release
          // that renders a blank ErrorWidget instead of the app.
          final loggedIn = auth.isLoggedIn;
          if (loggedIn != _syncRunning) {
            _syncRunning = loggedIn;
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (!mounted) return;
              try {
                if (loggedIn) {
                  widget.sync.start();
                } else {
                  widget.sync.stop();
                }
              } catch (_) {
                // A sync that cannot start must not take the POS down; sales
                // still queue locally and drain on the next manual attempt.
              }
            });
          }
          return MaterialApp(
            title: 'CartIQ POS',
            debugShowCheckedModeBanner: false,
            theme: AppTheme.light(),
            darkTheme: AppTheme.dark(),
            themeMode: theme.mode,
            home: Directionality(
              textDirection: TextDirection.ltr,
              child: FutureBuilder<void>(
                future: _restoreFuture,
                builder: (context, snap) {
                  if (snap.connectionState != ConnectionState.done) {
                    return const Scaffold(
                      body: Center(child: CircularProgressIndicator()),
                    );
                  }
                  // restoreSession() is guarded internally, but never let an
                  // unexpected error leave the user with no way into the app.
                  if (snap.hasError) {
                    return LoginScreen();
                  }
                  return auth.isLoggedIn
                      ? const RootShell()
                      : const LoginScreen();
                },
              ),
            ),
            routes: {'/login': (_) => const LoginScreen()},
          );
        },
      ),
    );
  }
}
