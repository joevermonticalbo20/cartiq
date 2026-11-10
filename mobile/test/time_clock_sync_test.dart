import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/services/api_client.dart';
import 'package:cartiq_mobile/services/auth_state.dart';

class FakeStore implements KeyValueStore {
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

/// Counts the calls the time-clock sync makes so a test can prove it ran.
class FakeApi extends ApiClient {
  FakeApi({KeyValueStore? store}) : super(secureStorage: store ?? FakeStore());

  int timeClockCalls = 0;
  int shiftCalls = 0;

  @override
  Future<Map<String, dynamic>> login(String username, String password) async {
    return {
      'token': 'tok',
      'refreshToken': 'ref',
      'user': {
        'username': username,
        'role': 'STAFF',
        'name': username,
        'rfidUid': null,
        'location': {'code': 'CART-01'},
      },
    };
  }

  @override
  Future<void> logout(String? refreshToken) async {}

  @override
  Future<Map<String, dynamic>> me(String token) async => {
        'user': {
          'username': 'staff01',
          'role': 'STAFF',
          'name': 'staff01',
          'rfidUid': null,
          'location': {'code': 'CART-01'},
        }
      };

  @override
  Future<Map<String, dynamic>> getTimeClock(String token) async {
    timeClockCalls++;
    return {
      'enabled': true,
      'inOpen': '07:00',
      'inClose': '09:00',
      'outOpen': '17:00',
      'outClose': '19:00',
      'days': [0, 1, 2, 3, 4, 5, 6],
    };
  }

  @override
  Future<Map<String, dynamic>> shiftsHistory(
    String token, {
    required String code,
    required String date,
    int pageSize = 100,
  }) async {
    shiftCalls++;
    return {
      'data': [],
      'meta': {'total': 0, 'page': 1, 'pageSize': pageSize, 'totalPages': 1},
    };
  }

  @override
  Future<Map<String, dynamic>> myAlerts(String token) async => {
        'data': [],
        'meta': {'total': 0, 'page': 1, 'pageSize': 50, 'totalPages': 1},
      };
}

void main() {
  group('time clock sync', () {
    test('signing in starts the sync that fetches the owner windows', () async {
      // signOut() stops the timer, so signIn() has to start it again. Without
      // that, the Time in / Time out buttons keep the always-open fallback and
      // "already timed in today" is never detected.
      final api = FakeApi();
      final auth = AuthState(apiClient: api, secureStorage: FakeStore());

      await auth.signIn('staff01', 'pw');
      // The fetch is kicked off right away; give the microtask queue a tick.
      await Future<void>.delayed(Duration.zero);

      expect(api.timeClockCalls, greaterThan(0),
          reason: 'the owner-configured windows must be fetched on sign-in');
      expect(auth.timeClock?.enabled, isTrue);
      expect(auth.timeClock?.inOpen, '07:00');
    });

    test('signing in also refreshes today\'s own shifts', () async {
      final api = FakeApi();
      final auth = AuthState(apiClient: api, secureStorage: FakeStore());

      await auth.signIn('staff01', 'pw');
      await Future<void>.delayed(Duration.zero);

      expect(api.shiftCalls, greaterThan(0),
          reason: 'the "already timed in today" check needs the shift history');
    });

    test('a sign-out stops the sync again', () async {
      final api = FakeApi();
      final auth = AuthState(apiClient: api, secureStorage: FakeStore());

      await auth.signIn('staff01', 'pw');
      await Future<void>.delayed(Duration.zero);
      final afterSignIn = api.timeClockCalls;

      await auth.signOut();
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(api.timeClockCalls, afterSignIn,
          reason: 'no polling must continue after sign-out');
    });
  });
}
