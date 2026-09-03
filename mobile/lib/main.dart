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

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await PersistedOfflineQueue.instance.open();

  final api = ApiClient();
  final auth = AuthState(apiClient: api);
  final sync = SyncService(api: api, auth: auth, queue: PersistedOfflineQueue.instance);
  final themeController = ThemeController();
  await themeController.load();

  // Show UI immediately; server discovery runs behind the splash so a slow
  // /24 scan never leaves the user on a black screen.
  runApp(_BootApp(api: api, auth: auth, sync: sync, themeController: themeController));
}

/// Startup splash: finds the API on the LAN in the background with progress,
/// Skip (use fallback), and manual-IP entry. Never blocks the UI.
class _BootApp extends StatefulWidget {
  const _BootApp({
    required this.api,
    required this.auth,
    required this.sync,
    required this.themeController,
  });

  final ApiClient api;
  final AuthState auth;
  final SyncService sync;
  final ThemeController themeController;

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
              padding: const EdgeInsets.all(28),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 360),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      width: 64,
                      height: 64,
                      decoration: BoxDecoration(
                        gradient: const LinearGradient(
                          begin: Alignment.topLeft,
                          end: Alignment.bottomRight,
                          colors: [AppColors.primary, AppColors.accent],
                        ),
                        borderRadius: BorderRadius.circular(18),
                      ),
                      child: const Center(
                        child: Text('CQ',
                            style: TextStyle(
                                color: Colors.white,
                                fontSize: 24,
                                fontWeight: FontWeight.w900)),
                      ),
                    ),
                    const SizedBox(height: 16),
                    Text('Finding CartIQ server…',
                        style: Theme.of(context).textTheme.titleMedium),
                    const SizedBox(height: 12),
                    const SizedBox(
                      width: 28,
                      height: 28,
                      child: CircularProgressIndicator(strokeWidth: 3),
                    ),
                    if (_error != null) ...[
                      const SizedBox(height: 12),
                      Text(_error!,
                          textAlign: TextAlign.center,
                          style: Theme.of(context).textTheme.bodySmall),
                    ],
                    const SizedBox(height: 20),
                    OutlinedButton(
                      onPressed: _skip,
                      child: const Text('Skip - enter later'),
                    ),
                    const SizedBox(height: 16),
                    const Divider(),
                    const SizedBox(height: 8),
                    Text('Or enter the server manually',
                        style: Theme.of(context).textTheme.bodySmall),
                    const SizedBox(height: 8),
                    TextField(
                      controller: _manualController,
                      keyboardType: TextInputType.url,
                      decoration: const InputDecoration(
                        labelText: 'Server (IP or host)',
                        hintText: '192.168.1.5',
                        prefixIcon: Icon(Icons.dns_outlined),
                        border: OutlineInputBorder(),
                      ),
                      onSubmitted: (_) => _useManual(),
                    ),
                    const SizedBox(height: 10),
                    FilledButton(
                      onPressed: _useManual,
                      child: const Text('Connect'),
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
    widget.sync.stop();
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
                  if (auth.isLoggedIn) {
                    widget.sync.start();
                    return const RootShell();
                  }
                  widget.sync.stop();
                  return const LoginScreen();
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
