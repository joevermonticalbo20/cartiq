// Guards for the void / payment-method paths in Sales History.
//
// Both actions previously showed a success toast WITHOUT ever issuing a
// request - "Order voided successfully. Inventory reverted." and "Payment
// method updated successfully." - so voiding did nothing at all. The first
// two tests here assert the request is actually made, with the right verb,
// path and body, so a fake success cannot be reintroduced silently.
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:cartiq_mobile/services/api_client.dart';

class _MemStore implements KeyValueStore {
  final Map<String, String?> values = {};
  @override
  Future<String?> read({required String key}) async => values[key];
  @override
  Future<void> write({required String key, required String? value}) async {
    values[key] = value;
  }

  @override
  Future<void> delete({required String key}) async => values.remove(key);
}

void main() {
  group('voidOrder really issues PATCH /orders/:id', () {
    test('sends the correct verb, path and body', () async {
      final seen = <http.Request>[];
      final client = MockClient((req) async {
        seen.add(req);
        return http.Response(
          jsonEncode({
            'order': {'id': 7, 'status': 'VOID'},
            'restored': [
              {'item': 'Potato Pouch', 'restored': 2, 'stock': 12},
            ],
            'warnings': <String>[],
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      });
      final api = ApiClient(secureStorage: _MemStore(), httpClient: client);

      final res = await api.voidOrder('tok', 7, reason: 'Wrong item punched');

      expect(seen, hasLength(1), reason: 'a request must actually be sent');
      expect(seen.single.method, 'PATCH');
      expect(seen.single.url.path, endsWith('/orders/7'));
      final body = jsonDecode(seen.single.body) as Map<String, dynamic>;
      expect(body['status'], 'VOID');
      expect(body['reason'], 'Wrong item punched');
      // And the payload is the one the UI needs to stay honest.
      expect(res['restored'], isA<List>());
      expect(res['warnings'], isA<List>());
    });

    test('omits an empty reason rather than sending ""', () async {
      final seen = <http.Request>[];
      final client = MockClient((req) async {
        seen.add(req);
        return http.Response(jsonEncode({'order': {}, 'restored': [], 'warnings': []}), 200);
      });
      final api = ApiClient(secureStorage: _MemStore(), httpClient: client);

      await api.voidOrder('tok', 7, reason: '');
      final body = jsonDecode(seen.single.body) as Map<String, dynamic>;
      expect(body.containsKey('reason'), isFalse);
      expect(body['status'], 'VOID');
    });

    test('a server error surfaces as ApiException with the server message', () async {
      final client = MockClient((_) async => http.Response(
            jsonEncode({'error': 'Order is already void'}),
            400,
            headers: {'content-type': 'application/json'},
          ));
      final api = ApiClient(secureStorage: _MemStore(), httpClient: client);

      // This is what stops the toast claiming success on a rejected void.
      await expectLater(
        api.voidOrder('tok', 7),
        throwsA(
          isA<ApiException>().having((e) => e.message, 'message', contains('already void')),
        ),
      );
    });
  });

  group('updateOrderPayment really issues PATCH /orders/:id', () {
    test('sends only paymentMethod, never a status', () async {
      final seen = <http.Request>[];
      final client = MockClient((req) async {
        seen.add(req);
        return http.Response(jsonEncode({'order': {'paymentMethod': 'GCASH'}}), 200);
      });
      final api = ApiClient(secureStorage: _MemStore(), httpClient: client);

      await api.updateOrderPayment('tok', 7, 'GCASH');

      expect(seen.single.method, 'PATCH');
      expect(seen.single.url.path, endsWith('/orders/7'));
      final body = jsonDecode(seen.single.body) as Map<String, dynamic>;
      expect(body['paymentMethod'], 'GCASH');
      expect(body.containsKey('status'), isFalse,
          reason: 'payment correction must not touch order status');
    });
  });

  group('voided sales are excluded from day totals', () {
    // Mirrors the grouping math in history_screen.dart.
    double dayTotal(Iterable<Map<String, dynamic>> rows) {
      final payable =
          rows.where((o) => (o['status'] ?? 'PAID').toString() != 'VOID');
      return payable.fold<double>(
        0,
        (s, o) => s + ((o['total'] ?? 0) as num).toDouble(),
      );
    }

    Map<String, dynamic> o(String name, double total, [String? status]) => {
          'productName': name,
          'total': total,
          'status': ?status,
        };

    test('a voided sale does not inflate the total', () {
      final rows = [o('Cheese Fries', 118, 'PAID'), o('BBQ Fries', 100, 'VOID'), o('Sour Cream', 128, 'PAID')];
      expect(dayTotal(rows), 246, reason: 'the voided 100 must not be counted');
    });

    test('a whole day of voids totals zero', () {
      final rows = [o('A', 59, 'VOID'), o('B', 59, 'VOID')];
      expect(dayTotal(rows), 0);
    });

    test('a missing status defaults to PAID and still counts', () {
      expect(dayTotal([o('A', 59)]), 59);
    });

    test('voiding one sale moves the total by exactly that amount', () {
      final before = [o('A', 118, 'PAID'), o('B', 100, 'PAID')];
      expect(dayTotal(before), 218);
      final after = [o('A', 118, 'PAID'), o('B', 100, 'VOID')];
      expect(dayTotal(after), 118);
      expect(dayTotal(before) - dayTotal(after), 100);
    });

    test('voided rows still feed the "· N voided" tally', () {
      final rows = [o('A', 10, 'PAID'), o('B', 10, 'VOID'), o('C', 10, 'VOID')];
      final payable = rows
          .where((r) => (r['status'] ?? 'PAID').toString() != 'VOID')
          .length;
      expect(rows.length - payable, 2, reason: 'header shows "1 sale · 2 voided"');
    });
  });

  group('void warnings must be surfaced, not swallowed', () {
    List<String> unrestored(List<String> warnings) => warnings
        .where((w) =>
            w.contains('no recipe matched') || w.contains('generic recipe'))
        .toList();

    test('an orphaned recipe is detected', () {
      const warnings = [
        'no recipe matched "Cheese Fries / Cheese" at void — stock NOT restored '
            '(product or flavor was renamed after this sale)',
      ];
      expect(unrestored(warnings), isNotEmpty,
          reason: 'dropping this is how stock silently drifted before');
    });

    test('flavour drift is detected', () {
      const warnings = [
        'only the generic recipe matched "X / Y" at void — stock restored at '
            'the generic amount, not the flavour amount',
      ];
      expect(unrestored(warnings), isNotEmpty);
    });

    test('a clean void produces no unrestored warnings', () {
      expect(unrestored(const []), isEmpty);
    });
  });
}
