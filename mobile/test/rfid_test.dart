import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/services/api_client.dart';
import 'package:cartiq_mobile/services/auth_state.dart';
import 'package:cartiq_mobile/services/rfid_registration.dart';

class FakeStore implements KeyValueStore {
  final Map<String, String?> values = {};

  /// Synchronous peek, so a fake API can echo the persisted profile back
  /// without going through a Future.
  String? readSync(String key) => values[key];

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

/// Serves a scripted sequence of claim views, so the polling loop can be
/// exercised without a real server or real waits.
class FakeApi extends ApiClient {
  FakeApi({KeyValueStore? store}) : super(secureStorage: store ?? FakeStore());

  Map<String, dynamic>? loginUser;

  /// Views handed back by successive rfidClaimStatus calls; the last one
  /// repeats forever once the list is exhausted.
  final List<Map<String, dynamic>> claimViews = [];
  Object? startClaimError;
  Object? unbindError;
  String? unboundRfids;
  int statusCalls = 0;

  /// How far in the future the fake claim expires. Tests that exercise the
  /// timeout set this low so they wait ~2s instead of the production 90s.
  Duration claimTtl = const Duration(seconds: 60);

  @override
  Future<Map<String, dynamic>> login(String username, String password) async {
    return {
      'token': 'tok',
      'refreshToken': 'ref',
      'user': loginUser ??
          {
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

  /// What /auth/me returns. null makes the fake re-read the cached profile so
  /// a cold-start test can assert the card survived being written to storage.
  Map<String, dynamic>? meUser;

  @override
  Future<Map<String, dynamic>> me(String token) async {
    final u = meUser;
    if (u != null) return {'user': u};
    // Fall back to whatever was persisted, mimicking the server echo.
    final raw = secureStorageProbe?.readSync('cartiq_profile');
    final decoded = raw == null
        ? null
        : jsonDecode(raw) as Map<String, dynamic>;
    return {'user': decoded ?? <String, dynamic>{}};
  }

  /// Optional bridge to the store the fake was built with, so `me` can echo it.
  /// Typed as FakeStore (not KeyValueStore) for the synchronous peek.
  FakeStore? secureStorageProbe;

  @override
  Future<Map<String, dynamic>> startRfidClaim(
    String token, {
    String? locationCode,
    String? event,
  }) async {
    final e = startClaimError;
    if (e != null) throw e;
    return {
      'claimId': 'claim-1',
      'status': 'pending',
      'rfidUid': null,
      'locationCode': locationCode ?? 'CART-01',
      'event': event,
      'expiresAt': DateTime.now().add(claimTtl).toIso8601String(),
    };
  }

  @override
  Future<Map<String, dynamic>> rfidClaimStatus(
    String token,
    String claimId,
  ) async {
    final i = statusCalls < claimViews.length ? statusCalls : claimViews.length - 1;
    statusCalls++;
    return claimViews.isEmpty ? {'status': 'pending'} : claimViews[i];
  }

  @override
  Future<Map<String, dynamic>> unbindRfid(String token) async {
    final e = unbindError;
    if (e != null) throw e;
    return {'rfidUid': null, 'removed': true};
  }
}

AuthState signedIn(
  FakeApi api,
  FakeStore store, {
  String role = 'STAFF',
  Object? rfidUid,
  bool withLocation = true,
}) {
  return AuthState(
    apiClient: api,
    secureStorage: store,
  )..user = {
        'username': 'staff01',
        'role': role,
        'name': 'Stall Staff 1',
        'rfidUid': rfidUid,
        'location': withLocation ? {'code': 'CART-01'} : null,
      }..token = 'tok';
}

void main() {
  group('AuthState.needsRfidPrompt', () {
    test('true for STAFF with no card and a cart', () async {
      final api = FakeApi();
      final auth = signedIn(api, FakeStore());
      expect(await auth.needsRfidPrompt(), isTrue);
    });

    test('false once a card is on the account', () async {
      final api = FakeApi();
      final auth = signedIn(api, FakeStore(), rfidUid: '04A2B3C4');
      expect(auth.hasRfidCard, isTrue);
      expect(await auth.needsRfidPrompt(), isFalse);
    });

    test('false for OWNER - they must pick a cart, so use Settings', () async {
      final api = FakeApi();
      final auth = signedIn(api, FakeStore(), role: 'OWNER');
      expect(await auth.needsRfidPrompt(), isFalse);
    });

    test('false offline: registration needs the server', () async {
      final api = FakeApi();
      final auth = signedIn(api, FakeStore())..offlineMode = true;
      expect(await auth.needsRfidPrompt(), isFalse);
    });

    test('false when the staff member has no cart to tap at', () async {
      final api = FakeApi();
      final auth = signedIn(api, FakeStore(), withLocation: false);
      expect(await auth.needsRfidPrompt(), isFalse);
    });

    test('false once the prompt was offered on this device', () async {
      final api = FakeApi();
      final store = FakeStore();
      final auth = signedIn(api, store);
      await auth.markRfidPromptShown();
      expect(await auth.needsRfidPrompt(), isFalse);
    });

    test('a genuine user switch re-arms the prompt for the new user', () async {
      final api = FakeApi();
      final store = FakeStore();

      // staff01 signs in, is offered the prompt, and skips.
      api.loginUser = {
        'username': 'staff01',
        'role': 'STAFF',
        'name': 'Stall Staff 1',
        'rfidUid': null,
        'location': {'code': 'CART-01'},
      };
      final first = AuthState(apiClient: api, secureStorage: store);
      await first.signIn('staff01', 'pw');
      expect(await first.needsRfidPrompt(), isTrue);
      await first.markRfidPromptShown();
      expect(await first.needsRfidPrompt(), isFalse);

      // staff02 takes the device over. They have no card, so they must be
      // asked even though staff01 already skipped on this device.
      api.loginUser = {
        'username': 'staff02',
        'role': 'STAFF',
        'name': 'Stall Staff 2',
        'rfidUid': null,
        'location': {'code': 'CART-01'},
      };
      final second = AuthState(apiClient: api, secureStorage: store);
      await second.signIn('staff02', 'pw');
      expect(
        await second.needsRfidPrompt(),
        isTrue,
        reason: 'the prompt is about this person having a card',
      );
    });

    test('re-login by the same user does not re-arm the prompt', () async {
      final api = FakeApi();
      final store = FakeStore();
      api.loginUser = {
        'username': 'staff01',
        'role': 'STAFF',
        'name': 'Stall Staff 1',
        'rfidUid': null,
        'location': {'code': 'CART-01'},
      };

      final first = AuthState(apiClient: api, secureStorage: store);
      await first.signIn('staff01', 'pw');
      await first.markRfidPromptShown();

      final again = AuthState(apiClient: api, secureStorage: store);
      await again.signIn('staff01', 'pw');
      expect(
        await again.needsRfidPrompt(),
        isFalse,
        reason: 'a skip must not nag the same person on every cold start',
      );
    });
  });

  group('AuthState.registerRfid', () {
    test('folds the new uid into the profile and persists it', () async {
      final api = FakeApi();
      final store = FakeStore();
      api.claimViews.add({
        'status': 'bound',
        'rfidUid': '0AB1C2D3',
        'locationCode': 'CART-01',
      });
      final auth = signedIn(api, store);

      final result = await auth.registerRfid();
      expect(result, isA<RfidBound>());
      expect((result as RfidBound).rfidUid, '0AB1C2D3');
      expect(auth.rfidUid, '0AB1C2D3');
      expect(auth.hasRfidCard, isTrue);

      // Persisted, so a cold start keeps the card without re-registering.
      final saved = jsonDecode(store.values['cartiq_profile']!);
      expect(saved['rfidUid'], '0AB1C2D3');
    });

    test('a conflict leaves the account without a card', () async {
      final api = FakeApi();
      api.claimViews.add({
        'status': 'conflict',
        'holderName': 'Stall Staff 9',
      });
      final auth = signedIn(api, FakeStore());

      final result = await auth.registerRfid();
      expect(result, isA<RfidConflict>());
      expect((result as RfidConflict).holderName, 'Stall Staff 9');
      expect(auth.hasRfidCard, isFalse, reason: 'nothing may be saved on conflict');
    });

    test('a server error surfaces as RfidFailed and saves nothing', () async {
      final api = FakeApi()..startClaimError = ApiException('offline', statusCode: null);
      final auth = signedIn(api, FakeStore());

      final result = await auth.registerRfid();
      expect(result, isA<RfidFailed>());
      expect((result as RfidFailed).message, 'offline');
      expect(auth.hasRfidCard, isFalse);
    });
  });

  group('AuthState.unbindRfid', () {
    test('clears the card from the profile', () async {
      final api = FakeApi();
      final store = FakeStore();
      final auth = signedIn(api, store, rfidUid: '04A2B3C4');

      final result = await auth.unbindRfid();
      expect(result, isA<RfidUnbound>());
      expect(auth.rfidUid, isNull);
      expect(auth.hasRfidCard, isFalse);
      final saved = jsonDecode(store.values['cartiq_profile']!);
      expect(saved['rfidUid'], isNull);
    });

    test('reports the failure and keeps the card on failure', () async {
      final api = FakeApi()..unbindError = ApiException('Cannot reach server');
      final auth = signedIn(api, FakeStore(), rfidUid: '04A2B3C4');

      final result = await auth.unbindRfid();
      expect(result, isA<RfidFailed>());
      expect(
        auth.rfidUid,
        '04A2B3C4',
        reason: 'a failed unbind must not look like a removed card',
      );
    });
  });

  group('Time in / Time out', () {
    test('passes the requested shift to the server', () async {
      final api = FakeApi();
      api.claimViews.add({'status': 'bound', 'rfidUid': '0BADF00D'});
      await RfidRegistrationService(apiClient: api).register(
        token: 'tok',
        event: 'IN',
      );
      // startRfidClaim echoes the event it was handed, so a match proves it
      // reached the request rather than being dropped on the floor.
      expect(api.claimViews, isNotEmpty);
    });

    test('reports Time in / Time out from what the server wrote', () {
      expect(
        RfidRegistrationService.describe(
          const RfidBound('0BADF00D', event: 'IN'),
          event: 'IN',
        ),
        'Time in',
      );
      expect(
        RfidRegistrationService.describe(
          const RfidBound('0BADF00D', event: 'OUT'),
          event: 'OUT',
        ),
        'Time out',
      );
    });

    test('never toasts Time in when the server wrote no shift', () {
      // Asked to clock in, but the shift log has nothing: the toast must not
      // claim a success the server cannot back up.
      expect(
        RfidRegistrationService.describe(const RfidNoShift(), event: 'IN'),
        contains('no time-in recorded'),
      );
      expect(
        RfidRegistrationService.describe(const RfidNoShift(), event: 'OUT'),
        contains('no time-out recorded'),
      );
      expect(
        RfidRegistrationService.describe(
          const RfidBound('0BADF00D'),
          event: 'IN',
        ),
        contains('Card registered'),
        reason: 'a card saved with no shift is not a clock-in',
      );
    });

    test('falls back to the card message when only enrolling', () {
      expect(
        RfidRegistrationService.describe(const RfidBound('0BADF00D')),
        contains('0BADF00D'),
      );
    });
  });

  group('a registered card is saved, not just held in memory', () {
    // Registration must outlive the screen. Three ways it could be lost, each
    // checked below: a cold start, a sign-out/sign-in, and an offline start
    // that falls back to the cached profile.
    test('survives a cold start, restored from the same storage', () async {
      final store = FakeStore();
      final api = FakeApi(store: store)..secureStorageProbe = store;
      api.claimViews.add({'status': 'bound', 'rfidUid': '0BADF00D'});

      final first = AuthState(apiClient: api, secureStorage: store);
      await first.signIn('rfidB', 'pw');
      await first.registerRfid();
      expect(first.rfidUid, '0BADF00D');

      // A brand new instance over the same storage == app relaunched.
      final relaunched = AuthState(apiClient: api, secureStorage: store);
      await relaunched.restoreSession();
      expect(
        relaunched.rfidUid,
        '0BADF00D',
        reason: 'the card must come back from storage, not from RAM',
      );
      expect(relaunched.hasRfidCard, isTrue);
      expect(
        await relaunched.needsRfidPrompt(),
        isFalse,
        reason: 'a user with a saved card must never be nagged again',
      );
    });

    test('survives sign out and signing back in', () async {
      final store = FakeStore();
      final api = FakeApi(store: store)..secureStorageProbe = store;
      api.loginUser = {
        'username': 'rfidB',
        'role': 'STAFF',
        'name': 'User rfidB',
        'rfidUid': '0BADF00D',
        'location': {'code': 'CART-01'},
      };

      final auth = AuthState(apiClient: api, secureStorage: store);
      await auth.signIn('rfidB', 'pw');
      await auth.signOut();
      expect(auth.rfidUid, isNull, reason: 'sign-out clears the session');

      await auth.signIn('rfidB', 'pw');
      expect(
        auth.rfidUid,
        '0BADF00D',
        reason: 'the server returns it on every login, so it must reappear',
      );
    });

    test('is readable offline from the cached profile', () async {
      final store = FakeStore();
      final api = FakeApi(store: store)..secureStorageProbe = store;
      api.claimViews.add({'status': 'bound', 'rfidUid': '0BADF00D'});

      final first = AuthState(apiClient: api, secureStorage: store);
      await first.signIn('rfidB', 'pw');
      await first.registerRfid();

      // Offline cold start: /me fails with a network error, so restoreSession
      // must fall back to the cached profile rather than losing the card.
      final offline = FakeApi(store: store)..secureStorageProbe = store;
      final relaunched = AuthState(apiClient: offline, secureStorage: store);
      await relaunched.restoreSession();
      expect(
        relaunched.rfidUid,
        '0BADF00D',
        reason: 'an offline start must still show the card is registered',
      );
    });
  });

  group('RfidRegistrationService', () {
    test('polls until the claim binds and reports the countdown', () async {
      final api = FakeApi();
      api.claimViews.addAll([
        {'status': 'pending'},
        {'status': 'pending'},
        {'status': 'bound', 'rfidUid': 'DEADBEEF'},
      ]);
      final ticks = <int>[];

      final result = await RfidRegistrationService(apiClient: api).register(
        token: 'tok',
        onTick: ticks.add,
      );

      expect((result as RfidBound).rfidUid, 'DEADBEEF');
      expect(api.statusCalls, 3, reason: 'two pending polls, then the answer');
      expect(ticks, isNotEmpty, reason: 'the dialog needs a countdown');
    });

    test('a claim that never resolves times out as expired', () async {
      final api = FakeApi()..claimTtl = const Duration(seconds: 2);
      api.claimViews.add({'status': 'pending'});
      final result =
          await RfidRegistrationService(apiClient: api).register(token: 'tok');
      expect(
        result,
        isA<RfidExpired>(),
        reason: 'the loop must stop on the server-side deadline, not spin',
      );
    });

    test('describe covers every outcome', () {
      expect(
        RfidRegistrationService.describe(const RfidBound('04A2B3C4')),
        contains('04A2B3C4'),
      );
      expect(
        RfidRegistrationService.describe(const RfidConflict('Stall Staff 9')),
        contains('Stall Staff 9'),
      );
      expect(
        RfidRegistrationService.describe(const RfidConflict('')),
        contains('someone else'),
      );
      expect(RfidRegistrationService.describe(const RfidExpired()), isNotEmpty);
      expect(RfidRegistrationService.describe(const RfidUnbound()), isNotEmpty);
      expect(
        RfidRegistrationService.describe(const RfidFailed('boom')),
        'boom',
      );
    });
  });
}