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
import 'package:cartiq_mobile/utils/manila_time.dart';

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

  /// Scripted /shifts/history payload; the refreshMyShifts path consumes it.
  Map<String, dynamic> historyResponse = const {'data': []};

  @override
  Future<Map<String, dynamic>> shiftsHistory(
    String token, {
    required String code,
    required String date,
    int pageSize = 100,
  }) async => historyResponse;
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
    'id': 42,
    'name': 'S1',
    'username': 'staff01',
    'role': 'STAFF',
    'location': {'code': 'CART-01'},
    'rfidUid': 'AABBCC11',
  };
  return auth;
}

Map<String, dynamic> _shiftRow(String event, DateTime when) => {
  'id': 1,
  'event': event,
  'ts': when.toUtc().toIso8601String(),
  'staffId': 42,
  'staffUid': 'AABBCC11',
  'staffName': 'S1',
  'locationId': 1,
};

/// The tappable part of one attendance tile.
InkWell _clockTile(WidgetTester tester, String key) => tester.widget<InkWell>(
  find.descendant(
    of: find.byKey(ValueKey(key)),
    matching: find.byType(InkWell),
  ),
);

String _clock12(Map<String, dynamic> shift) =>
    ManilaTime.formatClock12(ManilaTime.parse(shift['ts'])!);

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

    expect(
      _clockTile(tester, 'attendance-time-in').onTap,
      isNull,
      reason: 'Time in must be disabled now',
    );
    expect(
      _clockTile(tester, 'attendance-time-out').onTap,
      isNull,
      reason: 'Time out must be disabled now',
    );
    expect(find.textContaining('Time in opens 7:00 AM'), findsOneWidget);
    expect(find.textContaining('Time out opens 5:00 PM'), findsOneWidget);
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

    final timeIn = _clockTile(tester, 'attendance-time-in');
    final timeOut = _clockTile(tester, 'attendance-time-out');
    expect(timeIn.onTap, isNotNull, reason: 'Time in window is open');
    expect(timeOut.onTap, isNull, reason: 'Time out window is closed');
    expect(find.textContaining('Time in opens'), findsNothing);
    expect(find.textContaining('Time out opens 5:00 PM'), findsOneWidget);
  });

  testWidgets('closed day disables both buttons with the closed-day hint', (
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
      days: [1, 2, 3, 4, 5, 6],
    );
    // Sunday 2026-11-08 07:30 Manila (Sat 2026-11-07 23:30 UTC) - inside the
    // IN window on paper, but the day rule wins.
    auth.clockNow = () => DateTime.utc(2026, 11, 7, 23, 30);

    await tester.pumpWidget(_settingsHarness(auth));
    await tester.pumpAndSettle();

    final timeIn = _clockTile(tester, 'attendance-time-in');
    final timeOut = _clockTile(tester, 'attendance-time-out');
    expect(timeIn.onTap, isNull);
    expect(timeOut.onTap, isNull);
    expect(find.text('Closed today - no selling day.'), findsOneWidget);
  });

  testWidgets('already timed in: Time in disabled, 12h time and reason shown', (
    tester,
  ) async {
    final store = _FakeStore();
    final auth = _staffAuth(store);
    final inShift = _shiftRow('IN', DateTime.now());
    (auth.api as _FakeApi).historyResponse = {
      'data': [inShift],
    };
    auth.token = 'tok';
    await auth.refreshMyShifts();

    await tester.pumpWidget(_settingsHarness(auth));
    await tester.pumpAndSettle();

    expect(
      _clockTile(tester, 'attendance-time-in').onTap,
      isNull,
      reason: 'already timed in — cannot do it twice today',
    );
    expect(
      _clockTile(tester, 'attendance-time-out').onTap,
      isNotNull,
      reason: 'Time out must stay tappable',
    );
    expect(find.text(_clock12(inShift)), findsOneWidget);
    expect(find.text('Recorded'), findsOneWidget);
    expect(find.text('On shift'), findsOneWidget);
  });

  testWidgets('already timed out: Time out disabled, 12h time and reason shown', (
    tester,
  ) async {
    final store = _FakeStore();
    final auth = _staffAuth(store);
    final inShift = _shiftRow(
      'IN',
      DateTime.now().subtract(const Duration(hours: 8)),
    );
    final outShift = _shiftRow(
      'OUT',
      DateTime.now().subtract(const Duration(hours: 4)),
    );
    (auth.api as _FakeApi).historyResponse = {
      'data': [inShift, outShift],
    };
    auth.token = 'tok';
    await auth.refreshMyShifts();

    await tester.pumpWidget(_settingsHarness(auth));
    await tester.pumpAndSettle();

    final timeIn = _clockTile(tester, 'attendance-time-in');
    final timeOut = _clockTile(tester, 'attendance-time-out');
    expect(timeIn.onTap, isNull, reason: 'already timed in today');
    expect(timeOut.onTap, isNull, reason: 'already timed out today');
    expect(find.text('Shift complete for today'), findsOneWidget);
    expect(find.text(_clock12(inShift)), findsOneWidget);
    expect(find.text(_clock12(outShift)), findsOneWidget);
    expect(find.text('Complete'), findsOneWidget);
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

    final timeIn = _clockTile(tester, 'attendance-time-in');
    final timeOut = _clockTile(tester, 'attendance-time-out');
    expect(timeIn.onTap, isNotNull);
    expect(timeOut.onTap, isNotNull);
    expect(find.text('Tap card'), findsNWidgets(2));
    expect(find.textContaining('opens'), findsNothing);
  });
}
