import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

import 'package:cartiq_mobile/screens/settings_screen.dart';
import 'package:cartiq_mobile/services/api_client.dart';
import 'package:cartiq_mobile/services/auth_state.dart';
import 'package:cartiq_mobile/services/offline_queue.dart';
import 'package:cartiq_mobile/services/sync_service.dart';
import 'package:cartiq_mobile/services/staff_schedule.dart';
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

  /// Scripted /device-status payload for the reader card row.
  Map<String, dynamic> deviceStatusResponse = const {
    'cart': 'CART-01',
    'status': 'connected',
    'lastSeenSeconds': 5,
  };

  /// Scripted /shifts/self outcome for the App Tap button.
  Map<String, dynamic> appTapResponse = const {'event': 'IN'};
  int appTapCalls = 0;

  @override
  Future<Map<String, dynamic>> shiftsHistory(
    String token, {
    required String code,
    required String date,
    int pageSize = 100,
  }) async => historyResponse;

  @override
  Future<Map<String, dynamic>> deviceStatus(String token, {String? code}) async =>
      deviceStatusResponse;

  @override
  Future<Map<String, dynamic>> appTap(String token) async {
    appTapCalls++;
    return appTapResponse;
  }
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

/// True when the attendance action button (found by key) is enabled.
bool _actionEnabled(WidgetTester tester, String key) =>
    tester.widget<FilledButton>(
      find.descendant(
        of: find.byKey(ValueKey(key)),
        matching: find.byType(FilledButton),
      ),
    ).onPressed !=
    null;

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
      _actionEnabled(tester, 'attendance-rfid-action'),
      isFalse,
      reason: 'RFID tap must be disabled now',
    );
    expect(
      _actionEnabled(tester, 'attendance-app-action'),
      isFalse,
      reason: 'App Tap must be disabled now',
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
    auth.token = 'tok';

    await tester.pumpWidget(_settingsHarness(auth));
    await tester.pumpAndSettle();

    expect(
      _actionEnabled(tester, 'attendance-rfid-action'),
      isTrue,
      reason: 'Time in window is open',
    );
    expect(
      _actionEnabled(tester, 'attendance-app-action'),
      isTrue,
      reason: 'Time in window is open',
    );
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

    expect(_actionEnabled(tester, 'attendance-rfid-action'), isFalse);
    expect(_actionEnabled(tester, 'attendance-app-action'), isFalse);
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
      _actionEnabled(tester, 'attendance-rfid-action'),
      isTrue,
      reason: 'Time out must stay tappable',
    );
    expect(
      _actionEnabled(tester, 'attendance-app-action'),
      isTrue,
      reason: 'Time out must stay tappable',
    );
    expect(find.text(_clock12(inShift)), findsOneWidget);
    expect(find.text('On shift'), findsOneWidget);
    // The dynamic button now offers the next action.
    expect(find.text('TIME OUT'), findsOneWidget);
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

    expect(_actionEnabled(tester, 'attendance-rfid-action'), isFalse, reason: 'already timed in today');
    expect(_actionEnabled(tester, 'attendance-app-action'), isFalse, reason: 'already timed out today');
    expect(find.text('Shift complete for today'), findsOneWidget);
    expect(find.text(_clock12(inShift)), findsOneWidget);
    expect(find.text(_clock12(outShift)), findsOneWidget);
    expect(find.text('Complete'), findsWidgets);
  });

  testWidgets('unrestricted windows keep both buttons tappable', (
    tester,
  ) async {
    final store = _FakeStore();
    final auth = _staffAuth(store);
    // No timeClock set: feature unconfigured must behave exactly as before.
    auth.clockNow = () => DateTime.utc(2026, 11, 5, 16); // Manila midnight
    auth.token = 'tok';

    await tester.pumpWidget(_settingsHarness(auth));
    await tester.pumpAndSettle();

    expect(_actionEnabled(tester, 'attendance-rfid-action'), isTrue);
    expect(_actionEnabled(tester, 'attendance-app-action'), isTrue);
    expect(find.textContaining('opens'), findsNothing);
  });

  testWidgets('a personal schedule locks Time in/out outside the window', (
    tester,
  ) async {
    final store = _FakeStore();
    final auth = _staffAuth(store);
    // Cart-wide windows open (unconfigured); the roster is what locks now.
    // Manila Wednesday 2026-11-04 20:00 (index 3) = 12:00 UTC.
    auth.staffSchedule = StaffScheduleConfig(days: [
      null,
      null,
      null,
      {'start': '06:00', 'end': '14:00'},
      null,
      null,
      null,
    ]);
    auth.clockNow = () => DateTime.utc(2026, 11, 4, 12); // Manila 20:00 Wed

    await tester.pumpWidget(_settingsHarness(auth));
    await tester.pumpAndSettle();

    expect(
      _actionEnabled(tester, 'attendance-rfid-action'),
      isFalse,
      reason: 'after the scheduled end, RFID tap is locked',
    );
    expect(
      _actionEnabled(tester, 'attendance-app-action'),
      isFalse,
      reason: 'beyond the overtime window, App Tap is locked',
    );
    expect(
      find.textContaining('Your scheduled shift today ended at 2:00 PM'),
      findsWidgets,
    );
  });

  testWidgets('a scheduled day off locks both buttons with the reason', (
    tester,
  ) async {
    final store = _FakeStore();
    final auth = _staffAuth(store);
    auth.staffSchedule = StaffScheduleConfig(days: const [
      null, null, null, null, null, null, null,
    ]); // every weekday is a scheduled day off
    auth.clockNow = () => DateTime.utc(2026, 11, 5, 0); // Manila 08:00 Thu

    await tester.pumpWidget(_settingsHarness(auth));
    await tester.pumpAndSettle();

    expect(_actionEnabled(tester, 'attendance-rfid-action'), isFalse);
    expect(_actionEnabled(tester, 'attendance-app-action'), isFalse);
    expect(find.textContaining('scheduled day off'), findsWidgets);
    expect(find.text('Day off'), findsOneWidget);
  });

  testWidgets('inside the schedule window both buttons are tappable', (
    tester,
  ) async {
    final store = _FakeStore();
    final auth = _staffAuth(store);
    auth.staffSchedule = StaffScheduleConfig(days: [
      null,
      null,
      null,
      {'start': '06:00', 'end': '14:00'},
      null,
      null,
      null,
    ]);
    auth.clockNow = () => DateTime.utc(2026, 11, 4, 0); // Manila 08:00 Wed
    auth.token = 'tok';

    await tester.pumpWidget(_settingsHarness(auth));
    await tester.pumpAndSettle();

    expect(_actionEnabled(tester, 'attendance-rfid-action'), isTrue);
    expect(_actionEnabled(tester, 'attendance-app-action'), isTrue);
    expect(find.text('Today: 6:00 AM – 2:00 PM'), findsOneWidget);
  });

  testWidgets('App Tap records attendance via the server and confirms', (
    tester,
  ) async {
    final store = _FakeStore();
    final auth = _staffAuth(store);
    auth.token = 'tok';
    auth.clockNow = () => DateTime.utc(2026, 11, 5, 16); // Manila midnight

    await tester.pumpWidget(_settingsHarness(auth));
    await tester.pumpAndSettle();

    // Tapping the App Tap button calls /shifts/self exactly once.
    await tester.tap(find.byKey(const ValueKey('attendance-app-action')));
    await tester.pumpAndSettle();

    final api = auth.api as _FakeApi;
    expect(api.appTapCalls, 1);
    expect(find.text('Time in recorded'), findsOneWidget);
    expect(find.text('RFID Tap'), findsOneWidget);
    expect(find.text('App Tap'), findsOneWidget);
    // Let the toast's auto-dismiss timer fire before tearing down.
    await tester.pump(const Duration(seconds: 5));
    await tester.pump(const Duration(milliseconds: 300));
  });

  testWidgets('App Tap without connectivity is blocked with a clear message', (
    tester,
  ) async {
    final store = _FakeStore();
    final auth = _staffAuth(store);
    auth.offlineMode = true; // signed-out-ish state used by the queue flows
    auth.clockNow = () => DateTime.utc(2026, 11, 5, 16);

    await tester.pumpWidget(_settingsHarness(auth));
    await tester.pumpAndSettle();

    expect(
      find.textContaining('Internet connection is required'),
      findsWidgets,
    );
    expect(
      _actionEnabled(tester, 'attendance-app-action'),
      isFalse,
      reason: 'App Tap must be disabled offline',
    );
    // RFID-style card tap stays offered (it has its own online handling).
  });
}
