import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/services/api_client.dart';
import 'package:cartiq_mobile/services/auth_state.dart';
import 'package:cartiq_mobile/services/offline_pin.dart';

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

class FakeApi extends ApiClient {
  FakeApi({KeyValueStore? store}) : super(secureStorage: store ?? FakeStore());

  Object? meOutcome;
  Object? refreshOutcome;

  @override
  Future<Map<String, dynamic>> me(String token) async {
    final o = meOutcome;
    if (o is ApiException) throw o;
    if (o is Exception) throw o;
    return (o ?? {}) as Map<String, dynamic>;
  }

  @override
  Future<Map<String, dynamic>> refresh(String refreshToken) async {
    final o = refreshOutcome;
    if (o is ApiException) throw o;
    if (o is Exception) throw o;
    return (o ?? {}) as Map<String, dynamic>;
  }
}

void main() {
  group('OfflinePinService', () {
    test('setup then verify succeeds; wrong PIN throws wrong', () async {
      final pin = OfflinePinService(FakeStore());
      await pin.setupPin(username: 'staff01', pin: '123456');
      expect(await pin.hasPin, isTrue);
      await pin.verifyPin(username: 'staff01', pin: '123456');
      expect(
        () => pin.verifyPin(username: 'staff01', pin: '000000'),
        throwsA(
          isA<PinException>().having((e) => e.code, 'code', 'wrong'),
        ),
      );
    });

    test('rejects bad formats', () async {
      final pin = OfflinePinService(FakeStore());
      for (final bad in ['12345', '1234567', 'abcdef', '12 456', '']) {
        expect(
          () => pin.setupPin(username: 'u', pin: bad),
          throwsA(
            isA<PinException>().having((e) => e.code, 'code', 'invalid'),
          ),
        );
      }
    });

    test('PIN bound to username', () async {
      final pin = OfflinePinService(FakeStore());
      await pin.setupPin(username: 'staff01', pin: '123456');
      expect(
        () => pin.verifyPin(username: 'staff02', pin: '123456'),
        throwsA(
          isA<PinException>().having((e) => e.code, 'code', 'noPin'),
        ),
      );
    });

    test('5 failures lock out, success resets', () async {
      final pin = OfflinePinService(FakeStore());
      await pin.setupPin(username: 'u', pin: '123456');
      for (var i = 0; i < 4; i++) {
        await expectLater(
          pin.verifyPin(username: 'u', pin: '000000'),
          throwsA(
            isA<PinException>().having((e) => e.code, 'code', 'wrong'),
          ),
        );
      }
      await expectLater(
        pin.verifyPin(username: 'u', pin: '000000'),
        throwsA(
          isA<PinException>().having((e) => e.code, 'code', 'locked'),
        ),
      );
      // Even the right PIN is rejected while locked.
      await expectLater(
        pin.verifyPin(username: 'u', pin: '123456'),
        throwsA(
          isA<PinException>().having((e) => e.code, 'code', 'locked'),
        ),
      );
    });

    test('changePin needs old PIN', () async {
      final pin = OfflinePinService(FakeStore());
      await pin.setupPin(username: 'u', pin: '123456');
      await expectLater(
        pin.changePin(username: 'u', oldPin: '000000', newPin: '654321'),
        throwsA(isA<PinException>()),
      );
      await pin.changePin(username: 'u', oldPin: '123456', newPin: '654321');
      await pin.verifyPin(username: 'u', pin: '654321');
    });

    test('clear wipes everything', () async {
      final store = FakeStore();
      final pin = OfflinePinService(store);
      await pin.setupPin(username: 'u', pin: '123456');
      await pin.clear();
      expect(await pin.hasPin, isFalse);
      expect(store.values.keys.where((k) => k.startsWith('cartiq_pin')), isEmpty);
    });
  });

  group('AuthState offline session', () {
    test('offline cold start keeps tokens and restores cached profile', () async {
      final store = FakeStore();
      store.values['cartiq_token'] = 'tok';
      store.values['cartiq_refresh_token'] = 'ref';
      store.values['cartiq_profile'] =
          '{"name":"S1","username":"staff01","role":"STAFF","location":{"code":"CART-01"}}';
      final api = FakeApi(store: store)
        ..meOutcome = ApiException('no network');
      final auth = AuthState(apiClient: api, secureStorage: store);
      await auth.restoreSession();

      expect(auth.isLoggedIn, isTrue);
      expect(auth.locationCode, 'CART-01');
      expect(auth.displayName, 'S1');
    });

    test('explicit 401 with dead refresh signs out', () async {
      final store = FakeStore();
      store.values['cartiq_token'] = 'tok';
      store.values['cartiq_refresh_token'] = 'ref';
      final api = FakeApi(store: store)
        ..meOutcome = ApiException('bad', statusCode: 401)
        ..refreshOutcome = ApiException('dead', statusCode: 401);
      final auth = AuthState(apiClient: api, secureStorage: store);
      await auth.restoreSession();

      expect(auth.isLoggedIn, isFalse);
      expect(store.values['cartiq_token'], isNull);
    });

    test('unlockOffline gates: staff + fresh + PIN', () async {
      final store = FakeStore();
      store.values['cartiq_token'] = 'tok';
      store.values['cartiq_refresh_token'] = 'ref';
      store.values['cartiq_profile'] =
          '{"name":"S1","username":"staff01","role":"STAFF","location":{"code":"CART-01"}}';
      store.values['cartiq_last_online'] =
          DateTime.now().toIso8601String();
      final api = FakeApi(store: store)
        ..meOutcome = ApiException('offline');
      final auth = AuthState(apiClient: api, secureStorage: store);
      await auth.restoreSession();

      // No PIN yet.
      await expectLater(
        auth.unlockOffline('123456'),
        throwsA(
          isA<PinException>().having((e) => e.code, 'code', 'noPin'),
        ),
      );
      expect(auth.offlineMode, isFalse);

      await auth.pin.setupPin(username: 'staff01', pin: '123456');
      await auth.unlockOffline('123456');
      expect(auth.offlineMode, isTrue);
      expect(auth.locationCode, 'CART-01');
    });

    test('unlockOffline rejects owner, stale window, wrong PIN', () async {
      Future<AuthState> loginAs(Map<String, dynamic> profile) async {
        final store = FakeStore();
        store.values['cartiq_token'] = 'tok';
        store.values['cartiq_refresh_token'] = 'ref';
        final api = FakeApi(store: store)..meOutcome = ApiException('off');
        final auth = AuthState(apiClient: api, secureStorage: store);
        auth.token = 'tok';
        auth.refreshToken = 'ref';
        auth.user = profile;
        await auth.pin.setupPin(
            username: profile['username'] as String, pin: '123456');
        return auth;
      }

      final owner = await loginAs({
        'name': 'O',
        'username': 'owner',
        'role': 'OWNER',
      });
      // lastOnline missing -> expired path (or notStaff first).
      await expectLater(
        owner.unlockOffline('123456'),
        throwsA(isA<PinException>()),
      );

      final staleStoreAuth = await loginAs({
        'name': 'S',
        'username': 'staff01',
        'role': 'STAFF',
      });
      await expectLater(
        staleStoreAuth.unlockOffline('123456'),
        throwsA(
          isA<PinException>().having((e) => e.code, 'code', 'expired'),
        ),
      );
    });

    test('signOut wipes tokens, profile, PIN, catalog', () async {
      final store = FakeStore();
      store.values.addAll({
        'cartiq_token': 't',
        'cartiq_refresh_token': 'r',
        'cartiq_profile': '{}',
        'cartiq_last_online': DateTime.now().toIso8601String(),
        'cartiq_catalog_json': '{}',
      });
      final auth = AuthState(apiClient: FakeApi(store: store), secureStorage: store);
      await auth.pin.setupPin(username: 'u', pin: '123456');
      await auth.signOut();

      expect(auth.isLoggedIn, isFalse);
      expect(
        store.values.keys.where((k) => k.startsWith('cartiq_')),
        isEmpty,
      );
    });
  });
}
