import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/services/api_client.dart';
import 'package:cartiq_mobile/services/auth_state.dart';
import 'package:cartiq_mobile/services/offline_queue.dart';
import 'package:cartiq_mobile/services/sync_service.dart';

class _FakeApi extends ApiClient {
  _FakeApi() : super();

  bool healthy = true;
  final List<Object?> script = [];
  int calls = 0;

  @override
  Future<bool> health() async => healthy;

  @override
  Future<Map<String, dynamic>> submitOrder(
    Map<String, dynamic> payload,
    String token,
  ) async {
    final outcome = calls < script.length ? script[calls] : null;
    calls++;
    if (outcome is ApiException) throw outcome;
    if (outcome is Exception) throw outcome;
    return {'ok': true};
  }
}

class _FakeAuth extends AuthState {
  _FakeAuth({required ApiClient super.apiClient});

  bool refreshResult = false;
  int refreshCalls = 0;

  @override
  Future<bool> refreshSession() async {
    refreshCalls++;
    if (refreshResult) token = 'fresh-token';
    return refreshResult;
  }
}

class _FakeQueue implements OfflineQueue {
  final List<QueuedRecord> items = [];

  @override
  Stream<int> get changes => const Stream<int>.empty();

  @override
  Future<void> enqueue(QueuedRecord record) async {
    items.add(record);
  }

  @override
  Future<List<QueuedRecord>> pending() async => List.of(items);

  @override
  Future<void> remove(String id) async {
    items.removeWhere((r) => r.id == id);
  }

  @override
  Future<int> get count async => items.length;
}

QueuedRecord _order(String id) => QueuedRecord(
      id: id,
      kind: 'order',
      payload: {
        'clientRef': id,
        'locationCode': 'CART-01',
        'items': [
          {'productName': 'Flavored Fries', 'qty': 1, 'unitPrice': 40},
        ],
      },
    );

QueuedRecord _orderMissingLocation(String id) => QueuedRecord(
      id: id,
      kind: 'order',
      payload: {
        'clientRef': id,
        'items': [
          {'productName': 'Flavored Fries', 'qty': 1, 'unitPrice': 40},
        ],
      },
    );

void main() {
  late _FakeApi api;
  late _FakeAuth auth;
  late _FakeQueue queue;
  late SyncService sync;

  setUp(() {
    api = _FakeApi();
    auth = _FakeAuth(apiClient: api);
    auth.token = 'expired-token';
    queue = _FakeQueue();
    sync = SyncService(api: api, auth: auth, queue: queue);
  });

  group('SyncService drain', () {
    test('401 recovers via refresh and uploads the record', () async {
      await queue.enqueue(_order('a'));
      api.script.addAll([
        ApiException('expired', statusCode: 401),
        null, // retry after refresh succeeds
      ]);
      auth.refreshResult = true;

      final result = await sync.syncAll();

      expect(auth.refreshCalls, 1);
      expect(result.synced, 1);
      expect(result.remaining, 0);
      expect(await queue.count, 0);
    });

    test('401 with dead refresh keeps the record for later', () async {
      await queue.enqueue(_order('a'));
      api.script.add(ApiException('expired', statusCode: 401));
      auth.refreshResult = false;

      final result = await sync.syncAll();

      expect(auth.refreshCalls, 1);
      expect(result.synced, 0);
      expect(result.remaining, 1);
      expect(await queue.count, 1);
    });

    test('poison 400 is dropped with reason and the rest still drains',
        () async {
      await queue.enqueue(_order('poison'));
      await queue.enqueue(_order('good'));
      api.script.addAll([
        ApiException('bad payload', statusCode: 400),
        null, // good record uploads
      ]);

      final result = await sync.syncAll();

      expect(result.synced, 1);
      expect(result.remaining, 0);
      expect(await queue.count, 0);
      expect(result.dropped, hasLength(1));
      expect(result.dropped.single.id, 'poison');
      expect(result.dropped.single.reason, 'SERVER_REJECTED_400');
      expect(result.fullySynced, isFalse);
    });

    test('missing location is dropped, never synced, never retried',
        () async {
      await queue.enqueue(_orderMissingLocation('noloc'));

      final result = await sync.syncAll();

      expect(result.synced, 0);
      expect(result.remaining, 0);
      expect(await queue.count, 0);
      expect(api.calls, 0);
      expect(result.dropped, hasLength(1));
      expect(result.dropped.single.reason, 'MISSING_LOCATION_CODE');
      expect(result.fullySynced, isFalse);
      expect(result.allDone, isTrue); // queue empty, but not a success
    });

    test('409 duplicate counts as synced', () async {
      await queue.enqueue(_order('a'));
      api.script.add(ApiException('already exists', statusCode: 409));

      final result = await sync.syncAll();

      expect(result.synced, 1);
      expect(result.remaining, 0);
      expect(result.dropped, isEmpty);
      expect(result.fullySynced, isTrue);
    });

    test('429 rate-limit keeps the record for later', () async {
      await queue.enqueue(_order('a'));
      api.script.add(ApiException('slow down', statusCode: 429));

      final result = await sync.syncAll();

      expect(result.synced, 0);
      expect(result.remaining, 1);
      expect(result.dropped, isEmpty);
      expect(api.calls, 1);
    });

    test('500 stops the round and keeps every record', () async {
      await queue.enqueue(_order('a'));
      await queue.enqueue(_order('b'));
      api.script.add(ApiException('boom', statusCode: 500));

      final result = await sync.syncAll();

      expect(result.synced, 0);
      expect(result.remaining, 2);
      expect(api.calls, 1);
    });

    test('missing token reports offline and keeps every record', () async {
      await queue.enqueue(_order('a'));
      auth.token = null;

      final result = await sync.syncAll();

      expect(result.online, isFalse);
      expect(result.allDone, isFalse);
      expect(result.synced, 0);
      expect(result.remaining, 1);
      expect(api.calls, 0);
    });

    test('unreachable server reports offline without attempting upload',
        () async {
      await queue.enqueue(_order('a'));
      api.healthy = false;

      final result = await sync.syncAll();

      expect(result.online, isFalse);
      expect(result.synced, 0);
      expect(result.remaining, 1);
      expect(api.calls, 0);
    });
  });
}
