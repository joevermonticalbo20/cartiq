import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:cartiq_mobile/screens/settings_screen.dart';
import 'package:cartiq_mobile/services/api_client.dart';
import 'package:cartiq_mobile/services/auth_state.dart';
import 'package:cartiq_mobile/services/sync_service.dart';
import 'package:cartiq_mobile/services/offline_queue.dart';
import 'package:cartiq_mobile/state/theme_controller.dart';
import 'package:cartiq_mobile/widgets/pin_pad.dart';

class _FakeStore implements KeyValueStore {
  final Map<String, String?> values = {};

  @override
  Future<String?> read({required String key}) async => values[key];

  @override
  Future<void> write({required String key, required String? value}) async {
    values[key] = value;
  }

  @override
  Future<void> delete({required String key}) async {
    values.remove(key);
  }
}

class _FakeApi extends ApiClient {
  _FakeApi({KeyValueStore? store}) : super(secureStorage: store ?? _FakeStore());
}

class _FakeQueue implements OfflineQueue {
  @override
  Stream<int> get changes => const Stream<int>.empty();

  @override
  Future<void> enqueue(QueuedRecord record) async {}

  @override
  Future<List<QueuedRecord>> pending() async => [];

  @override
  Future<void> remove(String id) async {}

  @override
  Future<int> get count async => 0;
}

Widget _settingsHarness(AuthState auth) {  final sync = SyncService(
    api: auth.api,
    auth: auth,
    queue: _FakeQueue(),
  );
  return MultiProvider(
    providers: [
      ChangeNotifierProvider.value(value: auth),
      ChangeNotifierProvider.value(value: ThemeController()),
      ChangeNotifierProvider.value(value: sync),
    ],
    child: const MaterialApp(home: Scaffold(body: SettingsScreen())),
  );
}

void main() {
  group('PinPad', () {
    testWidgets('emits 6 digits on complete', (tester) async {
      String? got;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: PinPad(onComplete: (pin) => got = pin),
          ),
        ),
      );
      for (final d in '482916'.split('')) {
        await tester.tap(find.text(d));
        await tester.pump();
      }
      await tester.pump();
      expect(got, '482916');
    });

    testWidgets('shows error text', (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: PinPad(onComplete: _noop, errorText: 'Wrong PIN'),
          ),
        ),
      );
      expect(find.text('Wrong PIN'), findsOneWidget);
    });
  });

  group('SettingsScreen', () {
    testWidgets('shows account, PIN, appearance, session sections', (
      tester,
    ) async {
      final store = _FakeStore();
      final auth = AuthState(
        apiClient: _FakeApi(store: store),
        secureStorage: store,
      );
      auth.user = {
        'name': 'S1',
        'username': 'staff01',
        'role': 'STAFF',
        'location': {'code': 'CART-01'},
      };
      await tester.pumpWidget(_settingsHarness(auth));
      await tester.pumpAndSettle();

      expect(find.text('Account'), findsOneWidget);
      expect(find.text('Offline PIN'), findsWidgets);
      expect(find.text('Appearance'), findsOneWidget);
      expect(find.text('Session'), findsOneWidget);
      expect(find.text('S1'), findsOneWidget);
      await tester.scrollUntilVisible(
        find.text('Change password'),
        200,
      );
      expect(find.text('Change password'), findsOneWidget);
      expect(find.text('Log out'), findsOneWidget);
    });

    testWidgets('owner sees staff-only explainer, no setup', (tester) async {
      final store = _FakeStore();
      final auth = AuthState(
        apiClient: _FakeApi(store: store),
        secureStorage: store,
      );
      auth.user = {
        'name': 'O',
        'username': 'owner',
        'role': 'OWNER',
      };
      await tester.pumpWidget(_settingsHarness(auth));
      await tester.pumpAndSettle();

      expect(find.textContaining('Staff accounts only'), findsOneWidget);
      expect(find.text('Set up PIN'), findsNothing);
    });

    testWidgets('staff without PIN sees setup row', (tester) async {
      final store = _FakeStore();
      final auth = AuthState(
        apiClient: _FakeApi(store: store),
        secureStorage: store,
      );
      auth.user = {
        'name': 'S1',
        'username': 'staff01',
        'role': 'STAFF',
      };
      await tester.pumpWidget(_settingsHarness(auth));
      await tester.pumpAndSettle();

      expect(find.text('Set up PIN'), findsOneWidget);
    });
  });
}

void _noop(String _) {}
