import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/services/api_client.dart';

void main() {
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
