// The owner can pull a product from the menu while the vendor is selling it.
// The server answers with a silent push ("CATALOG_CHANGED") and the app must
// reload its catalog instead of showing a notification the vendor has to
// dismiss.
//
// The push is the fast path (a second or two); the 30-second catalog-version
// poll stays as the fallback for a phone that was offline.
import 'package:flutter_test/flutter_test.dart';
import 'package:firebase_messaging/firebase_messaging.dart';

import 'package:cartiq_mobile/services/push_notification_service.dart';
import 'package:cartiq_mobile/services/data_refresh.dart';
import 'package:cartiq_mobile/services/api_client.dart';
import 'package:cartiq_mobile/services/auth_state.dart';

/// Minimal in-memory key/value store (the app keeps its session in one).
class FakeStore implements KeyValueStore {
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

/// The app never talks to a server in this test.
class FakeApi extends ApiClient {
  FakeApi({KeyValueStore? store}) : super(secureStorage: store ?? FakeStore());
}

void main() {
  group('menu-changed push', () {
    test('recognises only the menu-changed signal', () {
      expect(isCatalogChanged({'type': 'CATALOG_CHANGED'}), isTrue);
      expect(isCatalogChanged({'type': 'catalog_changed'}), isTrue);
      expect(isCatalogChanged({'type': 'VOID_DECISION'}), isFalse);
      expect(isCatalogChanged({'type': 'RESTOCK_UPDATE'}), isFalse);
      expect(isCatalogChanged(<String, dynamic>{}), isFalse);
    });

    test('reloads the catalog instead of posting a notification', () async {
      final service = CartIQPushService();
      var reloads = 0;
      final shown = <CartIQPushPayload>[];
      service.onCatalogChanged = () async {
        reloads++;
      };
      service.notificationSink = (payload) async {
        shown.add(payload);
      };

      await service.handleForegroundMessage(
        const RemoteMessage(
          data: {'type': 'CATALOG_CHANGED', 'scope': 'product'},
        ),
      );

      expect(reloads, 1, reason: 'the POS must refresh its menu');
      expect(
        shown,
        isEmpty,
        reason: 'a menu change must stay silent',
      );
    });

    test('still shows a normal alert as a notification', () async {
      final service = CartIQPushService();
      var reloads = 0;
      final shown = <CartIQPushPayload>[];
      service.onCatalogChanged = () async {
        reloads++;
      };
      service.notificationSink = (payload) async {
        shown.add(payload);
      };

      await service.handleForegroundMessage(
        const RemoteMessage(
          data: {
            'type': 'VOID_DECISION',
            'alertId': '42',
            'title': 'Void approved',
            'body': 'Order #123 voided.',
          },
        ),
      );

      expect(reloads, 0, reason: 'an alert is not a menu change');
      expect(shown, hasLength(1));
      expect(shown.first.title, 'Void approved');
    });

    test('the app turns the push into a catalog refresh for the screens', () async {
      // The bus is what the POS screen listens to; the reason tells it that
      // the catalog - not the sales history - changed. This is the real
      // wiring the app installs at startup (AuthState).
      final bus = DataRefresh();
      final auth = AuthState(
        apiClient: FakeApi(),
        secureStorage: FakeStore(),
        dataRefresh: bus,
      );

      var reason = bus.lastReason;
      bus.addListener(() {
        reason = bus.lastReason;
      });

      // The push arrives: the push service calls onCatalogChanged.
      await auth.push.onCatalogChanged?.call();

      expect(reason, 'catalog');
      expect(bus.version, 1);
    });
  });
}
