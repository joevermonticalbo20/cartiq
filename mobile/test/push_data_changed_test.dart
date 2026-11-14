// The owner changes something in the dashboard (a cart, a reader, a staff
// account, an expense, an alert) and the phone has to show it - without a
// refresh and without a popup the vendor has to dismiss.
//
// The server answers with a silent push ("DATA_CHANGED" + the kind); the app
// re-reads what that kind means for it.
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
  group('owner-change push', () {
    test('recognises only the owner-change signal', () {
      expect(isDataChanged({'type': 'DATA_CHANGED'}), isTrue);
      expect(isDataChanged({'type': 'data_changed'}), isTrue);
      expect(isDataChanged({'type': 'CATALOG_CHANGED'}), isFalse);
      expect(isDataChanged({'type': 'SHIFT'}), isFalse);
      expect(isDataChanged(<String, dynamic>{}), isFalse);
    });

    test('says what changed', () {
      expect(DataChange.kindOf({'kind': 'locations'}), 'locations');
      expect(DataChange.kindOf({'kind': 'EXPENSES'}), 'expenses');
      expect(DataChange.kindOf(<String, dynamic>{}), '');
    });

    test('re-reads instead of posting a notification', () async {
      final service = CartIQPushService();
      final kinds = <String>[];
      final shown = <CartIQPushPayload>[];
      service.onDataChanged = (kind) async {
        kinds.add(kind);
      };
      service.notificationSink = (payload) async {
        shown.add(payload);
      };

      await service.handleForegroundMessage(
        const RemoteMessage(
          data: {'type': 'DATA_CHANGED', 'kind': 'locations'},
        ),
      );

      expect(kinds, ['locations'], reason: 'the app must learn what changed');
      expect(
        shown,
        isEmpty,
        reason: 'an owner change must stay silent',
      );
    });

    test('a push with no kind is ignored', () async {
      final service = CartIQPushService();
      final kinds = <String>[];
      service.onDataChanged = (kind) async {
        kinds.add(kind);
      };

      await service.handleForegroundMessage(
        const RemoteMessage(data: {'type': 'DATA_CHANGED'}),
      );

      expect(kinds, isEmpty);
    });

    test('the app turns the push into the right refresh', () async {
      // The bus is what the screens listen to; the reason tells them what
      // changed. This is the real wiring the app installs at startup.
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

      // The carts moved: the catalog carries them, so the POS reloads it.
      await auth.push.onDataChanged?.call(DataChange.locations);
      expect(reason, 'catalog');
      expect(bus.version, 1);

      // A receipt was filed: the receipt list reloads.
      await auth.push.onDataChanged?.call(DataChange.expenses);
      expect(reason, 'expenses');
      expect(bus.version, 2);

      // A reader changed: the app shows no readers, so nothing happens.
      final before = bus.version;
      await auth.push.onDataChanged?.call(DataChange.devices);
      expect(bus.version, before);
    });
  });
}
