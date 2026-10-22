// Regression guards for the filter chips on Sales History and Expenses.
//
// The chips filter the rows that are ALREADY LOADED, and the empty state
// replaced the paginated list - so it carried no scroll listener and no
// further page was ever requested. A match that lived on page 2 was
// unreachable, and the screen claimed "No sales recorded yet" while dozens
// of sales existed.
//
// These tests pin the behaviour: tapping a chip keeps paging in until the
// filter matches something or the server runs out of rows, and the empty
// state never lies about there being no records at all.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:provider/provider.dart';

import 'package:cartiq_mobile/screens/history_screen.dart';
import 'package:cartiq_mobile/services/api_client.dart';
import 'package:cartiq_mobile/services/auth_state.dart';

class _MemStore implements KeyValueStore {
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

Map<String, dynamic> _order(int id, String method, double total) => {
  'id': id,
  'status': 'PAID',
  'paymentMethod': method,
  'total': total,
  'createdAt': DateTime(2026, 10, 21, 10, id % 60).toIso8601String(),
  'items': [
    {'qty': 1, 'productName': 'Flavored Fries', 'flavor': null},
  ],
};

AuthState _auth(http.Client client) {
  final store = _MemStore();
  final auth = AuthState(
    apiClient: ApiClient(secureStorage: store, httpClient: client),
    secureStorage: store,
  );
  auth.token = 'tok';
  auth.user = {
    'name': 'S1',
    'username': 'staff01',
    'role': 'STAFF',
    'location': {'code': 'CART-01'},
  };
  return auth;
}

Widget _harness(AuthState auth) => ChangeNotifierProvider.value(
  value: auth,
  child: const MaterialApp(home: Scaffold(body: HistoryScreen())),
);

void main() {
  testWidgets('the GCash chip reaches a sale that only exists on page 2', (
    tester,
  ) async {
    final requested = <String>[];
    final client = MockClient((req) async {
      final url = req.url.toString();
      requested.add(url);
      final page = int.tryParse(
            Uri.parse(url).queryParameters['page'] ?? '1',
          ) ??
          1;
      if (page == 1) {
        // A full first page, all cash - the GCash sale is on the next one.
        return http.Response(
          jsonEncode({
            'data': List.generate(10, (i) => _order(i + 1, 'CASH', 100)),
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      }
      return http.Response(
        jsonEncode({
          'data': [_order(99, 'GCASH', 120)],
        }),
        200,
        headers: {'content-type': 'application/json'},
      );
    });

    await tester.pumpWidget(_harness(_auth(client)));
    await tester.pumpAndSettle();

    // Page 1 is loaded and shows cash sales only.
    expect(requested.any((u) => u.contains('page=1')), isTrue);

    await tester.tap(find.widgetWithText(FilterChip, 'GCash'));
    await tester.pumpAndSettle();

    expect(
      requested.any((u) => u.contains('page=2')),
      isTrue,
      reason:
          'tapping a filter must pull further pages in until it matches - '
          'otherwise a GCash sale on page 2 is unreachable forever',
    );
    expect(
      find.text('No sales recorded yet'),
      findsNothing,
      reason: 'a filter is on, so the screen must not claim there are no sales',
    );
  });

  testWidgets('a filter that matches nothing says so instead of claiming '
      'the history is empty', (tester) async {
    final client = MockClient((req) async {
      // One short page: the server has nothing more.
      return http.Response(
        jsonEncode({
          'data': [_order(1, 'CASH', 100)],
        }),
        200,
        headers: {'content-type': 'application/json'},
      );
    });

    await tester.pumpWidget(_harness(_auth(client)));
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(FilterChip, 'GCash'));
    await tester.pumpAndSettle();

    expect(find.text('No GCash sales yet'), findsOneWidget);
    expect(find.text('No sales recorded yet'), findsNothing);
  });

  testWidgets('the Voided chip reports the voided count, not "0 sales" with '
      'a peso total', (tester) async {
    final client = MockClient((req) async {
      return http.Response(
        jsonEncode({
          'data': [
            {
              'id': 5,
              'status': 'VOID',
              'paymentMethod': 'CASH',
              'total': 120,
              'voidReason': 'Wrong item punched',
              'createdAt': DateTime(2026, 10, 21, 9).toIso8601String(),
              'items': [
                {'qty': 1, 'productName': 'Flavored Fries', 'flavor': null},
              ],
            },
          ],
        }),
        200,
        headers: {'content-type': 'application/json'},
      );
    });

    await tester.pumpWidget(_harness(_auth(client)));
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(FilterChip, 'Voided'));
    await tester.pumpAndSettle();

    expect(find.text('1 voided'), findsOneWidget);
    expect(find.text('0 sales   1 voided'), findsNothing);
    expect(find.text('₱0'), findsNothing);
  });

  testWidgets('searching by a peso amount still matches', (tester) async {
    final client = MockClient((req) async {
      return http.Response(
        jsonEncode({
          'data': [_order(1, 'CASH', 150)],
        }),
        200,
        headers: {'content-type': 'application/json'},
      );
    });

    await tester.pumpWidget(_harness(_auth(client)));
    await tester.pumpAndSettle();

    // The search box only exists once the magnifier is tapped.
    await tester.tap(find.byTooltip('Search sales'));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField).first, '₱150');
    await tester.pumpAndSettle();

    expect(find.text('No sales match "₱150"'), findsNothing);
  });
}
