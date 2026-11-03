import 'dart:async';
import 'dart:io';
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

ApiClient _clientWith(Future<http.Response> Function(http.Request) handler) =>
    ApiClient(secureStorage: _FakeStore(), httpClient: MockClient(handler));

void main() {
  group('user-friendly request errors', () {
    test('timeout maps to a recovery message', () async {
      final client = _clientWith(
        (_) async => throw TimeoutException('request timed out'),
      );

      await expectLater(
        client.submitOrder({'items': []}, 'token'),
        throwsA(
          isA<ApiException>().having(
            (error) => error.message,
            'message',
            ApiClient.timeoutMessage,
          ),
        ),
      );
    });

    test('socket failure maps to offline-safe message', () async {
      final client = _clientWith(
        (_) async => throw const SocketException('connection refused'),
      );

      await expectLater(
        client.submitOrder({'items': []}, 'token'),
        throwsA(
          isA<ApiException>().having(
            (error) => error.message,
            'message',
            ApiClient.noInternetMessage,
          ),
        ),
      );
    });

    test('insufficient stock 409 includes the flavor name', () async {
      final client = _clientWith(
        (_) async => http.Response(
          '{"error":"INSUFFICIENT_STOCK","flavorName":"Cheese"}',
          409,
        ),
      );

      await expectLater(
        client.submitOrder({'items': []}, 'token'),
        throwsA(
          isA<ApiException>()
              .having((error) => error.code, 'code', 'INSUFFICIENT_STOCK')
              .having(
                (error) => error.message,
                'message',
                'Stock for Cheese just ran out. Please update your cart before checking out.',
              ),
        ),
      );
    });

    test('server unavailable status maps to safe retry message', () async {
      final client = _clientWith(
        (_) async => http.Response('{"error":"database unavailable"}', 503),
      );

      await expectLater(
        client.submitOrder({'items': []}, 'token'),
        throwsA(
          isA<ApiException>().having(
            (error) => error.message,
            'message',
            ApiClient.unavailableMessage,
          ),
        ),
      );
    });

    test('unauthorized requests map to session recovery message', () async {
      final client = _clientWith(
        (_) async => http.Response('{"error":"Unauthorized"}', 401),
      );

      await expectLater(
        client.submitOrder({'items': []}, 'token'),
        throwsA(
          isA<ApiException>().having(
            (error) => error.message,
            'message',
            ApiClient.sessionExpiredMessage,
          ),
        ),
      );
    });
  });

  group('forgotPassword', () {
    test('posts email and returns the generic message', () async {
      http.Request? seen;
      final client = _clientWith((req) async {
        seen = req;
        return http.Response(
          '{"success":true,"message":"If an account exists for this email, a reset code was sent."}',
          200,
        );
      });
      final data = await client.forgotPassword('staff@gmail.com');
      expect(seen!.url.path, endsWith('/auth/forgot-password'));
      expect(data['success'], isTrue);
    });

    test('server 400 surfaces the error message', () async {
      final client = _clientWith(
        (_) async =>
            http.Response('{"error":"A valid email address is required"}', 400),
      );
      expect(
        () => client.forgotPassword('nope'),
        throwsA(
          isA<ApiException>().having(
            (e) => e.message,
            'message',
            'A valid email address is required',
          ),
        ),
      );
    });
  });

  group('resetPassword', () {
    test('posts email, code and new password', () async {
      http.Request? seen;
      final client = _clientWith((req) async {
        seen = req;
        return http.Response('{"updated":true,"sessionsRevoked":true}', 200);
      });
      final data = await client.resetPassword(
        email: 's@gmail.com',
        code: '482916',
        newPassword: 'newpass12',
      );
      expect(seen!.url.path, endsWith('/auth/reset-password'));
      expect(data['updated'], isTrue);
    });

    group('restock requests', () {
      test('loads requests scoped to a cart', () async {
        http.Request? seen;
        final client = _clientWith((req) async {
          seen = req;
          return http.Response(
            '{"data":[{"id":7,"ingredientId":42,"status":"pending"}]}',
            200,
          );
        });

        final requests = await client.restockRequests(
          'access-token',
          locationCode: 'CART 01',
        );

        expect(seen!.url.path, endsWith('/inventory/restock-requests'));
        expect(seen!.url.queryParameters['code'], 'CART 01');
        expect(seen!.headers['authorization'], 'Bearer access-token');
        expect(requests.single['ingredientId'], 42);
      });

      test('posts one restock request with urgency and note', () async {
        http.Request? seen;
        final client = _clientWith((req) async {
          seen = req;
          return http.Response(
            '{"data":[{"id":7,"ingredientId":42,"status":"pending"}]}',
            201,
          );
        });

        final result = await client.createRestockRequest('access-token', {
          'ingredientId': 42,
          'urgency': 'urgent',
          'notes': 'Need more stock',
        });

        expect(seen!.url.path, endsWith('/inventory/restock-request'));
        expect(jsonDecode(seen!.body), {
          'ingredientId': 42,
          'urgency': 'urgent',
          'notes': 'Need more stock',
        });
        expect(result['data'], isA<List<dynamic>>());
      });
    });

    test(
      'login 429 keeps the lockout message and countdown metadata',
      () async {
        final client = _clientWith(
          (_) async => http.Response(
            '{"error":"Too many failed attempts. Wait 5:00 and try again.",'
            '"code":"LOGIN_LOCKED","retryAfterSeconds":300,'
            '"lockedUntil":"2026-11-02T12:05:00Z"}',
            429,
          ),
        );

        await expectLater(
          client.login('owner', 'wrong-password'),
          throwsA(
            isA<ApiException>()
                .having((e) => e.statusCode, 'status', 429)
                .having((e) => e.message, 'message', contains('Wait 5:00'))
                .having((e) => e.retryAfterSeconds, 'retryAfterSeconds', 300)
                .having((e) => e.lockedUntil, 'lockedUntil', isNotNull),
          ),
        );
      },
    );

    test('invalid code surfaces the generic server message', () async {
      final client = _clientWith(
        (_) async => http.Response('{"error":"Invalid or expired code."}', 400),
      );
      expect(
        () => client.resetPassword(
          email: 's@gmail.com',
          code: '000000',
          newPassword: 'newpass12',
        ),
        throwsA(
          isA<ApiException>().having(
            (e) => e.message,
            'message',
            'Invalid or expired code.',
          ),
        ),
      );
    });
  });

  group('email OTP account flows', () {
    test(
      'verifyResetCode posts the address and code before the password step',
      () async {
        http.Request? seen;
        final client = _clientWith((req) async {
          seen = req;
          return http.Response('{"valid":true}', 200);
        });
        final data = await client.verifyResetCode(
          email: 's@gmail.com',
          code: '482916',
        );
        expect(seen!.method, 'POST');
        expect(seen!.url.path, endsWith('/auth/verify-reset-code'));
        expect(jsonDecode(seen!.body), {
          'email': 's@gmail.com',
          'code': '482916',
        });
        expect(data['valid'], isTrue);
      },
    );

    test('requestChangePasswordCode uses the bearer session', () async {
      http.Request? seen;
      final client = _clientWith((req) async {
        seen = req;
        return http.Response(
          '{"sent":true,"email":"s***@gmail.com","expiresInMinutes":10}',
          200,
        );
      });
      final data = await client.requestChangePasswordCode('access-token');
      expect(seen!.method, 'POST');
      expect(seen!.url.path, endsWith('/auth/change-password/otp'));
      expect(seen!.headers['authorization'], 'Bearer access-token');
      expect(data['sent'], isTrue);
    });

    test('changePassword sends current, new, and the email code', () async {
      http.Request? seen;
      final client = _clientWith((req) async {
        seen = req;
        return http.Response('{"updated":true,"sessionsRevoked":true}', 200);
      });
      await client.changePassword(
        'access-token',
        currentPassword: 'oldpass1',
        newPassword: 'newpass12',
        code: '482916',
      );
      expect(seen!.url.path, endsWith('/auth/change-password'));
      expect(jsonDecode(seen!.body), {
        'currentPassword': 'oldpass1',
        'newPassword': 'newpass12',
        'code': '482916',
      });
    });

    test(
      'updateProfile PATCHes the recovery email with the password',
      () async {
        http.Request? seen;
        final client = _clientWith((req) async {
          seen = req;
          return http.Response(
            '{"user":{"id":2,"username":"staff01","email":"new@example.com"}}',
            200,
          );
        });
        final data = await client.updateProfile(
          'access-token',
          email: 'new@example.com',
          currentPassword: 'oldpass1',
        );
        expect(seen!.method, 'PATCH');
        expect(seen!.url.path, endsWith('/auth/me'));
        expect(jsonDecode(seen!.body), {
          'email': 'new@example.com',
          'currentPassword': 'oldpass1',
        });
        expect((data['user'] as Map)['email'], 'new@example.com');
      },
    );
  });

  group('normalizeApiBaseUrl', () {
    test('bare LAN IP gets http scheme and /api suffix', () {
      expect(normalizeApiBaseUrl('192.168.1.5'), 'http://192.168.1.5/api');
    });

    test('host with port gets http scheme and /api suffix', () {
      expect(normalizeApiBaseUrl('myserver:4000'), 'http://myserver:4000/api');
    });

    test('trailing slash is trimmed before suffix check', () {
      expect(
        normalizeApiBaseUrl('http://192.168.1.5:4000/'),
        'http://192.168.1.5:4000/api',
      );
    });

    test('existing /api suffix is kept as-is', () {
      expect(
        normalizeApiBaseUrl('http://192.168.1.5:4000/api'),
        'http://192.168.1.5:4000/api',
      );
    });

    test('explicit http URL without /api gets suffix', () {
      expect(
        normalizeApiBaseUrl('http://10.0.2.2:4000'),
        'http://10.0.2.2:4000/api',
      );
    });

    test('empty input throws ApiException', () {
      expect(() => normalizeApiBaseUrl('   '), throwsA(isA<ApiException>()));
    });

    test('scheme-only input throws ApiException', () {
      expect(
        () => normalizeApiBaseUrl('http://'),
        throwsA(isA<ApiException>()),
      );
    });
  });

  // GCash receipts, staff void requests and the menu-change probe.
  group('order receipts + void requests + catalog version', () {
    test('requestVoidOrder POSTs to /orders/:id/void-request', () async {
      late http.Request captured;
      final client = _clientWith((req) async {
        captured = req;
        return http.Response('{"order":{"id":7,"voidRequest":{"status":"pending"}}}', 201);
      });

      final res = await client.requestVoidOrder(
        'tok',
        7,
        reason: 'Wrong item punched',
      );

      expect(captured.method, 'POST');
      expect(captured.url.path, endsWith('/orders/7/void-request'));
      expect(jsonDecode(captured.body), {'reason': 'Wrong item punched'});
      expect(res['order']['voidRequest']['status'], 'pending');
    });

    test('uploadOrderReceipt POSTs mime + base64 data', () async {
      late http.Request captured;
      final client = _clientWith((req) async {
        captured = req;
        return http.Response('{"receipt":{"bytes":8}}', 200);
      });

      await client.uploadOrderReceipt(
        'tok',
        9,
        mime: 'image/jpeg',
        data: '/9j/AAAA',
      );

      expect(captured.method, 'POST');
      expect(captured.url.path, endsWith('/orders/9/receipt'));
      final body = jsonDecode(captured.body) as Map<String, dynamic>;
      expect(body['mime'], 'image/jpeg');
      expect(body['data'], '/9j/AAAA');
    });

    test('fetchOrderReceipt returns the raw bytes', () async {
      final client = _clientWith(
        (_) async => http.Response.bytes([1, 2, 3], 200),
      );
      expect(await client.fetchOrderReceipt('tok', 9), [1, 2, 3]);
    });

    test('catalogVersion reads the one-document probe', () async {
      late http.Request captured;
      final client = _clientWith((req) async {
        captured = req;
        return http.Response('{"version":42}', 200);
      });

      expect(await client.catalogVersion('tok'), 42);
      expect(captured.url.path, endsWith('/catalog/version'));
    });
  });
}
