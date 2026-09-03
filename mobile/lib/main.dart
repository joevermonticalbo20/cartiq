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
  // Auto-discover the API on the local subnet so the app works on any WiFi
  // without rebuilding. Scans the /24 subnet for port 4000.
  await api.ensureResolved();
  final auth = AuthState(apiClient: api);
  final sync = SyncService(api: api, auth: auth, queue: PersistedOfflineQueue.instance);
  final themeController = ThemeController();
  await themeController.load();

  runApp(CartIQApp(auth: auth, sync: sync, themeController: themeController));
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
