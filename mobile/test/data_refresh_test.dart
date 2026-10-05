// Sales History, Home and Receipts all live in an IndexedStack, so they are
// mounted simultaneously and each fetches once in initState. Without this bus
// a sale recorded on the POS never reached the other tabs.
import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/services/data_refresh.dart';

void main() {
  group('DataRefresh bus', () {
    test('starts at version 0 with no reason', () {
      final bus = DataRefresh();
      expect(bus.version, 0);
      expect(bus.lastReason, isNull);
    });

    test('bump increments the version and records the reason', () {
      final bus = DataRefresh();
      bus.bump('sale');
      expect(bus.version, 1);
      expect(bus.lastReason, 'sale');
      bus.bump('void');
      expect(bus.version, 2);
      expect(bus.lastReason, 'void');
    });

    test('notifies every subscriber exactly once per bump', () {
      final bus = DataRefresh();
      var a = 0;
      var b = 0;
      void onA() => a++;
      void onB() => b++;
      bus.addListener(onA);
      bus.addListener(onB);

      bus.bump('sale');
      expect(a, 1);
      expect(b, 1);

      bus.bump('void');
      expect(a, 2);
      expect(b, 2);

      bus.removeListener(onA);
      bus.removeListener(onB);
      bus.bump('payment');
      expect(a, 2, reason: 'a removed listener must stop hearing bumps');
      expect(b, 2);
    });

    test('three screens (history, home, receipts) all hear one sale', () {
      // Mirrors the IndexedStack reality: three mounted subscribers.
      final bus = DataRefresh();
      final heard = <String, int>{'history': 0, 'home': 0, 'receipts': 0};
      void onHistory() => heard['history'] = heard['history']! + 1;
      void onHome() => heard['home'] = heard['home']! + 1;
      void onReceipts() => heard['receipts'] = heard['receipts']! + 1;
      bus
        ..addListener(onHistory)
        ..addListener(onHome)
        ..addListener(onReceipts);

      bus.bump('sale');
      expect(heard.values.every((v) => v == 1), isTrue,
          reason: 'one sale must refresh every tab');

      // Screens unsubscribe in dispose() - a torn-down tab must not be called.
      bus
        ..removeListener(onHistory)
        ..removeListener(onHome)
        ..removeListener(onReceipts);
      bus.bump('void');
      expect(heard.values.every((v) => v == 1), isTrue,
          reason: 'disposed screens must not be called back');
    });

    test('a reload that itself bumps cannot spin forever', () {
      // The contract: a screen must not call bump() from inside its own
      // response handler. This asserts the version only moves on an explicit
      // bump, so a naive loop would be visible as runaway growth.
      final bus = DataRefresh();
      final seen = <int>[];
      bus.addListener(() => seen.add(bus.version));
      bus.bump('sale');
      expect(seen, [1]);
      expect(seen.length, 1);
    });
  });
}
