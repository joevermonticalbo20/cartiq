import 'package:flutter_test/flutter_test.dart';

import 'package:cartiq_mobile/services/deep_link.dart';

void main() {
  group('resolveDeepLink', () {
    test('void decisions open History at the order sheet', () {
      final t = resolveDeepLink(const {'type': 'VOID_DECISION', 'alertId': 9, 'orderId': 421});
      expect(t.tabIndex, 3);
      expect(t.orderId, 421);
      expect(t.openNotifications, isFalse);
    });

    test('gcash confirm and decision both deep-link the order', () {
      for (final type in ['GCASH_DECISION', 'GCASH_CONFIRM']) {
        final t = resolveDeepLink({'type': type, 'orderId': '77'});
        expect(t.tabIndex, 3);
        expect(t.orderId, 77);
      }
    });

    test('a void decision without an order id still opens History', () {
      final t = resolveDeepLink(const {'type': 'VOID_DECISION'});
      expect(t.tabIndex, 3);
      expect(t.orderId, isNull);
    });

    test('restock and low-stock pushes open Live Stock', () {
      for (final type in ['RESTOCK_UPDATE', 'LOW_STOCK_NOTIFY']) {
        final t = resolveDeepLink({'type': type});
        expect(t.openLiveStock, isTrue);
      }
    });

    test('attendance-related pushes land on Settings', () {
      for (final type in ['TIMECLOCK_WINDOW', 'SHIFT', 'ABSENCE']) {
        final t = resolveDeepLink({'type': type});
        expect(t.tabIndex, 4);
        expect(t.openLiveStock, isFalse);
      }
    });

    test('the server link override wins over the type mapping', () {
      final t = resolveDeepLink(const {'type': 'OWNER_NOTICE', 'link': 'attendance'});
      expect(t.tabIndex, 4);
    });

    test('unknown types fall back to Home with the notifications sheet', () {
      for (final type in ['SALE', 'OWNER_NOTICE', 'ALERT', 'SOMETHING_NEW']) {
        final t = resolveDeepLink({'type': type});
        expect(t.tabIndex, 2);
        expect(t.openNotifications, isTrue);
      }
    });

    test('a junk orderId parses as absent rather than crashing', () {
      final t = resolveDeepLink(const {'type': 'GCASH_DECISION', 'orderId': 'not-a-number'});
      expect(t.tabIndex, 3);
      expect(t.orderId, isNull);
    });
  });
}
