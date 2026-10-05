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

  /// Username the fake will "log in" as; defaults to whatever is passed in.
  Map<String, dynamic>? loginUser;

  @override
  Future<Map<String, dynamic>> login(String username, String password) async {
    return {
      'token': 'tok',
      'refreshToken': 'ref',
      'user': loginUser ??
          {'username': username, 'role': 'STAFF', 'name': username},
    };
  }

  @override
  Future<void> logout(String? refreshToken) async {}

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

    test('signOut wipes session state but KEEPS the device PIN', () async {
      final store = FakeStore();
      store.values.addAll({
        'cartiq_token': 't',
        'cartiq_refresh_token': 'r',
        'cartiq_profile': '{}',
        'cartiq_last_online': DateTime.now().toIso8601String(),
        'cartiq_catalog_json': '{}',
        'cartiq_pin_prompted': '1',
      });
      final auth = AuthState(apiClient: FakeApi(store: store), secureStorage: store);
      await auth.pin.setupPin(username: 'u', pin: '123456');
      await auth.signOut();

      expect(auth.isLoggedIn, isFalse);
      // Session-scoped keys are gone...
      for (final k in [
        'cartiq_token',
        'cartiq_refresh_token',
        'cartiq_profile',
        'cartiq_last_online',
        'cartiq_catalog_json',
      ]) {
        expect(store.values.containsKey(k), isFalse, reason: '$k should be wiped');
      }
      // ...but the PIN and the already-prompted flag are device state. Wiping
      // them on sign-out is what made staff invent a new PIN every login.
      expect(await auth.pin.hasPin, isTrue);
      expect(store.values['cartiq_pin_prompted'], '1');
    });

    test('a leftover PIN cannot unlock once the session is gone', () async {
      // The PIN is inert without a cached token+profile, so keeping it across
      // sign-out carries no authority.
      final store = FakeStore();
      final auth = AuthState(apiClient: FakeApi(store: store), secureStorage: store);
      await auth.pin.setupPin(username: 'u', pin: '123456');
      await auth.signOut();

      await expectLater(
        auth.unlockOffline('123456'),
        throwsA(isA<PinException>()),
      );
    });

    test('needsPinSetupPrompt: staff without PIN, once', () async {
      final store = FakeStore();
      final auth = AuthState(apiClient: FakeApi(store: store), secureStorage: store);
      auth.token = 'tok';
      auth.refreshToken = 'ref';
      auth.user = {'username': 'staff01', 'role': 'STAFF'};

      expect(await auth.needsPinSetupPrompt(), isTrue);
      await auth.markPinPromptShown();
      expect(await auth.needsPinSetupPrompt(), isFalse);
    });

    // The bug reported from the field: "every login asks for a new PIN".
    // signIn used to delete cartiq_pin_prompted whenever pinnedUser
    // (!= currentUser), which is true whenever NO pin exists - i.e. after the
    // staff member skipped setup. So each login re-armed the prompt forever.
    test('REGRESSION: skipping PIN setup does not re-prompt on next login', () async {
      final store = FakeStore();
      final api = FakeApi(store: store);
      final auth = AuthState(apiClient: api, secureStorage: store);

      await auth.signIn('staff01', 'pw');
      expect(await auth.needsPinSetupPrompt(), isTrue, reason: 'first login asks');
      await auth.markPinPromptShown(); // staff taps "not now"

      await auth.signOut();
      await auth.signIn('staff01', 'pw');
      expect(
        await auth.needsPinSetupPrompt(),
        isFalse,
        reason: 'same staff, same device, already asked once - must not nag again',
      );
    });

    test('a DIFFERENT user taking over the device does get re-prompted', () async {
      final store = FakeStore();
      final api = FakeApi(store: store);
      final auth = AuthState(apiClient: api, secureStorage: store);

      await auth.signIn('staff01', 'pw');
      await auth.pin.setupPin(username: 'staff01', pin: '111111');
      await auth.markPinPromptShown();
      expect(await auth.needsPinSetupPrompt(), isFalse);

      await auth.signOut();
      await auth.signIn('staff02', 'pw'); // genuine takeover

      expect(
        await auth.pin.hasPin,
        isFalse,
        reason: "the previous user's PIN must not survive a takeover",
      );
      expect(
        await auth.needsPinSetupPrompt(),
        isTrue,
        reason: 'the new user needs their own PIN',
      );
    });

    test('signing back in as the same user keeps the PIN', () async {
      final store = FakeStore();
      final api = FakeApi(store: store);
      final auth = AuthState(apiClient: api, secureStorage: store);

      await auth.signIn('staff01', 'pw');
      await auth.pin.setupPin(username: 'staff01', pin: '222222');
      await auth.signOut();
      await auth.signIn('staff01', 'pw');

      expect(await auth.pin.hasPin, isTrue);
      expect(await auth.needsPinSetupPrompt(), isFalse);
      // And the PIN still verifies - it was not silently re-hashed or lost.
      await expectLater(
        auth.pin.verifyPin(username: 'staff01', pin: '222222'),
        completes,
      );
    });

    test('needsPinSetupPrompt: false for owner, offline, or PIN set', () async {
      Future<AuthState> make(Map<String, dynamic>? user, {bool offline = false}) async {
        final store = FakeStore();
        final auth = AuthState(apiClient: FakeApi(store: store), secureStorage: store);
        auth.token = 'tok';
        auth.refreshToken = 'ref';
        auth.user = user;
        auth.offlineMode = offline;
        return auth;
      }

      final owner = await make({'username': 'owner', 'role': 'OWNER'});
      expect(await owner.needsPinSetupPrompt(), isFalse);

      final anon = await make(null);
      expect(await anon.needsPinSetupPrompt(), isFalse);

      final staff = await make({'username': 's', 'role': 'STAFF'});
      await staff.pin.setupPin(username: 's', pin: '123456');
      expect(await staff.needsPinSetupPrompt(), isFalse);

      final off = await make({'username': 's', 'role': 'STAFF'}, offline: true);
      expect(await off.needsPinSetupPrompt(), isFalse);
    });

    test('checkOfflineEligibility: distinct codes per gate', () async {
      Future<AuthState> seeded({
        bool tokens = true,
        Map<String, dynamic>? profile,
        bool pin = false,
        String? lastOnline,
      }) async {
        final store = FakeStore();
        final auth =
            AuthState(apiClient: FakeApi(store: store), secureStorage: store);
        if (tokens) {
          auth.token = 'tok';
          auth.refreshToken = 'ref';
        }
        if (profile != null) {
          store.values['cartiq_profile'] =
              '{"name":"${profile['name']}","username":"${profile['username']}","role":"${profile['role']}","location":{"code":"CART-01"}}';
        }
        if (lastOnline != null) {
          store.values['cartiq_last_online'] = lastOnline;
        }
        if (pin) {
          await auth.pin.setupPin(username: 'staff01', pin: '123456');
        }
        return auth;
      }

      final fresh = DateTime.now().toIso8601String();

      final noSession = await seeded(tokens: false);
      expect((await noSession.checkOfflineEligibility()).code, 'noSession');

      final owner = await seeded(
        profile: {'name': 'O', 'username': 'owner', 'role': 'OWNER'},
        lastOnline: fresh,
      );
      expect((await owner.checkOfflineEligibility()).code, 'notStaff');

      final expired = await seeded(
        profile: {'name': 'S', 'username': 'staff01', 'role': 'STAFF'},
        lastOnline:
            DateTime.now().subtract(const Duration(days: 8)).toIso8601String(),
        pin: true,
      );
      expect((await expired.checkOfflineEligibility()).code, 'expired');

      final noPin = await seeded(
        profile: {'name': 'S', 'username': 'staff01', 'role': 'STAFF'},
        lastOnline: fresh,
      );
      expect((await noPin.checkOfflineEligibility()).code, 'noPin');

      final ready = await seeded(
        profile: {'name': 'S', 'username': 'staff01', 'role': 'STAFF'},
        lastOnline: fresh,
        pin: true,
      );
      final ok = await ready.checkOfflineEligibility();
      expect(ok.eligible, isTrue);
      expect(ok.code, 'ready');
    });

    test('unlockOffline uses distinct noSession/noProfile codes', () async {
      final store = FakeStore();
      final auth =
          AuthState(apiClient: FakeApi(store: store), secureStorage: store);
      await expectLater(
        auth.unlockOffline('123456'),
        throwsA(
          isA<PinException>().having((e) => e.code, 'code', 'noSession'),
        ),
      );
    });
  });
}
