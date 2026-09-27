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
    ApiClient(
      secureStorage: _FakeStore(),
      httpClient: MockClient(handler),
    );

void main() {
  group('forgotPassword', () {
    test('posts email and returns the generic message', () async {
      http.Request? seen;
      final client = _clientWith((req) async {
        seen = req;
        return http.Response(
            '{"success":true,"message":"If an account exists for this email, a reset code was sent."}',
            200);
      });
      final data = await client.forgotPassword('staff@gmail.com');
      expect(seen!.url.path, endsWith('/auth/forgot-password'));
      expect(data['success'], isTrue);
    });

    test('server 400 surfaces the error message', () async {
      final client = _clientWith((_) async =>
          http.Response('{"error":"A valid email address is required"}', 400));
      expect(
        () => client.forgotPassword('nope'),
        throwsA(isA<ApiException>().having(
            (e) => e.message, 'message', 'A valid email address is required')),
      );
    });
  });

  group('resetPassword', () {
    test('posts email, code and new password', () async {
      http.Request? seen;
      final client = _clientWith((req) async {
        seen = req;
        return http.Response(
            '{"updated":true,"sessionsRevoked":true}', 200);
      });
      final data = await client.resetPassword(
          email: 's@gmail.com', code: '482916', newPassword: 'newpass12');
      expect(seen!.url.path, endsWith('/auth/reset-password'));
      expect(data['updated'], isTrue);
    });

    test('invalid code surfaces the generic server message', () async {
      final client = _clientWith((_) async =>
          http.Response('{"error":"Invalid or expired code."}', 400));
      expect(
        () => client.resetPassword(
            email: 's@gmail.com', code: '000000', newPassword: 'newpass12'),
        throwsA(isA<ApiException>().having(
            (e) => e.message, 'message', 'Invalid or expired code.')),
      );
    });
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
      expect(() => normalizeApiBaseUrl('http://'), throwsA(isA<ApiException>()));
    });
  });
}
