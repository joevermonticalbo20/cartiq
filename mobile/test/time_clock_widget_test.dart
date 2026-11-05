import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:cartiq_mobile/screens/settings_screen.dart';
import 'package:cartiq_mobile/services/api_client.dart';
import 'package:cartiq_mobile/services/auth_state.dart';
import 'package:cartiq_mobile/services/offline_queue.dart';
import 'package:cartiq_mobile/services/sync_service.dart';
import 'package:cartiq_mobile/services/time_clock.dart';
import 'package:cartiq_mobile/state/theme_controller.dart';

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
  _FakeApi({KeyValueStore? store})
    : super(secureStorage: store ?? _FakeStore());
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

Widget _settingsHarness(AuthState auth) {
  final sync = SyncService(api: auth.api, auth: auth, queue: _FakeQueue());
  return MultiProvider(
    providers: [
      ChangeNotifierProvider.value(value: auth),
      ChangeNotifierProvider.value(value: ThemeController()),
      ChangeNotifierProvider.value(value: sync),
    ],
    child: const MaterialApp(home: Scaffold(body: SettingsScreen())),
  );
}

AuthState _staffAuth(_FakeStore store) {
  final auth = AuthState(
    apiClient: _FakeApi(store: store),
    secureStorage: store,
  );
  auth.user = {
    'name': 'S1',
    'username': 'staff01',
    'role': 'STAFF',
    'location': {'code': 'CART-01'},
    'rfidUid': 'AABBCC11',
  };
  return auth;
}

void main() {
  testWidgets('closed clock window greys out Time in / Time out with the hint', (
    tester,
  ) async {
    final store = _FakeStore();
    final auth = _staffAuth(store);
    auth.timeClock = const TimeClockConfig(
      enabled: true,
      inOpen: '07:00',
      inClose: '09:00',
      outOpen: '17:00',
      outClose: '19:00',
    );
    // Manila midnight (16:00 UTC) — both windows closed, always.
    auth.clockNow = () => DateTime.utc(2026, 11, 5, 16);

    await tester.pumpWidget(_settingsHarness(auth));
    await tester.pumpAndSettle();

    final timeIn = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, 'Time in'),
    );
    final timeOut = tester.widget<OutlinedButton>(
      find.widgetWithText(OutlinedButton, 'Time out'),
    );
    expect(timeIn.onPressed, isNull, reason: 'Time in must be disabled now');
    expect(timeOut.onPressed, isNull, reason: 'Time out must be disabled now');
    expect(find.textContaining('Time in opens 07:00'), findsOneWidget);
    expect(find.textContaining('Time out opens 17:00'), findsOneWidget);
  });

  testWidgets('one open window greys out only its own button', (
    tester,
  ) async {
    final store = _FakeStore();
    final auth = _staffAuth(store);
    auth.timeClock = const TimeClockConfig(
      enabled: true,
      inOpen: '07:00',
      inClose: '09:00',
      outOpen: '17:00',
      outClose: '19:00',
    );
    // Manila 08:00 (00:00 UTC) — inside the IN window, outside OUT.
    auth.clockNow = () => DateTime.utc(2026, 11, 6);

    await tester.pumpWidget(_settingsHarness(auth));
    await tester.pumpAndSettle();

    final timeIn = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, 'Time in'),
    );
    final timeOut = tester.widget<OutlinedButton>(
      find.widgetWithText(OutlinedButton, 'Time out'),
    );
    expect(timeIn.onPressed, isNotNull, reason: 'Time in window is open');
    expect(timeOut.onPressed, isNull, reason: 'Time out window is closed');
    expect(find.textContaining('Time in opens'), findsNothing);
    expect(find.textContaining('Time out opens 17:00'), findsOneWidget);
  });

  testWidgets('unrestricted windows keep both buttons tappable', (
    tester,
  ) async {
    final store = _FakeStore();
    final auth = _staffAuth(store);
    // No timeClock set: feature unconfigured must behave exactly as before.
    auth.clockNow = () => DateTime.utc(2026, 11, 5, 16); // Manila midnight

    await tester.pumpWidget(_settingsHarness(auth));
    await tester.pumpAndSettle();

    final timeIn = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, 'Time in'),
    );
    final timeOut = tester.widget<OutlinedButton>(
      find.widgetWithText(OutlinedButton, 'Time out'),
    );
    expect(timeIn.onPressed, isNotNull);
    expect(timeOut.onPressed, isNotNull);
    expect(find.textContaining('opens'), findsNothing);
  });
}
