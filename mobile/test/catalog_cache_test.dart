import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:cartiq_mobile/services/api_client.dart';

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

void main() {
  const body = '{"products":[],"locations":[]}';

  ApiClient clientWith({
    required http.Client httpClient,
    KeyValueStore? store,
  }) =>
      ApiClient(
        secureStorage: store ?? _FakeStore(),
        httpClient: httpClient,
      );

  group('catalog cache', () {
    test('second call within TTL serves cache without HTTP', () async {
      var calls = 0;
      final store = _FakeStore();
      final client = clientWith(
        store: store,
        httpClient: MockClient((_) async {
          calls++;
          return http.Response(body, 200);
        }),
      );

      final first = await client.catalog('tok');
      final second = await client.catalog('tok');
      expect(first['products'], isEmpty);
      expect(second['products'], isEmpty);
      expect(calls, 1);
    });

    test('forceRefresh bypasses cache', () async {
      var calls = 0;
      final client = clientWith(
        httpClient: MockClient((_) async {
          calls++;
          return http.Response(body, 200);
        }),
      );

      await client.catalog('tok');
      await client.catalog('tok', forceRefresh: true);
      expect(calls, 2);
    });

    test('offline falls back to stale cache instead of throwing', () async {
      final store = _FakeStore();
      final online = clientWith(
        store: store,
        httpClient: MockClient((_) async => http.Response(body, 200)),
      );
      await online.catalog('tok', forceRefresh: true);

      final offline = clientWith(
        store: store,
        httpClient: MockClient((_) async {
          throw const SocketExceptionClosed();
        }),
      );
      final data = await offline.catalog('tok');
      expect(data['products'], isEmpty);
    });

    test('offline with empty cache still throws', () async {
      final client = clientWith(
        httpClient: MockClient((_) async {
          throw const SocketExceptionClosed();
        }),
      );
      expect(
        () => client.catalog('tok'),
        throwsA(isA<ApiException>()),
      );
    });

    test('401 still throws (no stale fallback on auth errors)', () async {
      final store = _FakeStore();
      final seed = clientWith(
        store: store,
        httpClient: MockClient((_) async => http.Response(body, 200)),
      );
      await seed.catalog('tok', forceRefresh: true);

      final authed = clientWith(
        store: store,
        httpClient: MockClient(
          (_) async => http.Response('{"error":"x"}', 401),
        ),
      );
      expect(
        () => authed.catalog('tok', forceRefresh: true),
        throwsA(
          isA<ApiException>().having((e) => e.statusCode, 'status', 401),
        ),
      );
    });
  });
}

class SocketExceptionClosed implements Exception {
  const SocketExceptionClosed();

  @override
  String toString() => 'SocketException: Connection closed';
}
