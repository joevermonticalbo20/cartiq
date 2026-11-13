// A card was tapped on the reader. The server records the shift and pushes it
// to the devices ("SHIFT", data only). The app must reflect the tap right
// away: the attendance refreshes, and the Home screen reloads.
//
// The push is the fast path (a second or two); the app's own polls stay as
// the fallback for a phone that was offline.
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
  group('card-tap push', () {
    test('recognises only the shift signal', () {
      expect(isShiftEvent({'type': 'SHIFT'}), isTrue);
      expect(isShiftEvent({'type': 'shift'}), isTrue);
      expect(isShiftEvent({'type': 'CATALOG_CHANGED'}), isFalse);
      expect(isShiftEvent({'type': 'VOID_DECISION'}), isFalse);
      expect(isShiftEvent(<String, dynamic>{}), isFalse);
    });

    test('reads what the server did with the tap', () {
      expect(shiftStatusOf({'type': 'SHIFT'}), 'recorded');
      expect(shiftStatusOf({'type': 'SHIFT', 'status': 'recorded'}), 'recorded');
      expect(shiftStatusOf({'type': 'SHIFT', 'status': 'unregistered'}),
          'unregistered');
      expect(shiftStatusOf({'type': 'SHIFT', 'status': 'refused'}), 'refused');
      expect(shiftReasonOf({'reason': 'outside the window'}), 'outside the window');
      expect(shiftReasonOf(<String, dynamic>{}), '');
    });

    test('a shift message refreshes the app instead of popping a notification',
        () async {
      final service = CartIQPushService();
      var refreshes = 0;
      var notifications = 0;
      service.onShiftEvent = (_) async {
        refreshes++;
      };
      service.notificationSink = (_) async {
        notifications++;
      };

      await service.handleForegroundMessage(
        const RemoteMessage(
          data: {
            'type': 'SHIFT',
            'event': 'IN',
            'staffUid': '5A436083',
            'staffName': 'Stall Staff 1',
            'locationCode': 'CART-01',
          },
        ),
      );

      expect(refreshes, 1, reason: 'the tap must refresh the app at once');
      expect(notifications, 0, reason: 'no popup for a tap');
    });

    test('the app turns the tap into a refresh for the screens', () async {
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

      await auth.push.onShiftEvent?.call({
        'type': 'SHIFT',
        'status': 'recorded',
        'event': 'IN',
      });

      expect(reason, 'shift');
      expect(bus.version, 1);
    });

    test('a refused tap says why instead of looking like nothing happened',
        () async {
      final bus = DataRefresh();
      final auth = AuthState(
        apiClient: FakeApi(),
        secureStorage: FakeStore(),
        dataRefresh: bus,
      );

      await auth.push.onShiftEvent?.call({
        'type': 'SHIFT',
        'status': 'refused',
        'event': 'OUT',
        'reason': 'Time out is only open 16:30-16:40 (Manila time).',
      });

      expect(bus.lastReason, 'shift');
      expect(bus.lastMessage, contains('16:30-16:40'));
    });

    test('a tap after the person already timed in says why', () async {
      final bus = DataRefresh();
      final auth = AuthState(
        apiClient: FakeApi(),
        secureStorage: FakeStore(),
        dataRefresh: bus,
      );

      await auth.push.onShiftEvent?.call({
        'type': 'SHIFT',
        'status': 'refused',
        'event': 'IN',
        'reason': 'You already timed in today at 5:23 PM.',
      });

      expect(bus.lastMessage, 'You already timed in today at 5:23 PM.');
    });

    test('recognises the owner notice', () {
      expect(isOwnerNotice({'type': 'OWNER_NOTICE'}), isTrue);
      expect(isOwnerNotice({'type': 'owner_notice'}), isTrue);
      expect(isOwnerNotice({'type': 'SHIFT'}), isFalse);
      expect(
        ownerNoticeMessage({
          'type': 'OWNER_NOTICE',
          'body': 'Stall Staff 1 timed in at CART-01',
        }),
        'Stall Staff 1 timed in at CART-01',
      );
    });

    test('an owner notice is said out loud', () async {
      final service = CartIQPushService();
      final said = <String>[];
      service.onOwnerNotice = (message) async {
        said.add(message);
      };

      await service.handleForegroundMessage(
        const RemoteMessage(
          data: {
            'type': 'OWNER_NOTICE',
            'title': 'Time in',
            'body': 'Stall Staff 1 timed in at CART-01',
          },
        ),
      );

      expect(said, ['Stall Staff 1 timed in at CART-01']);
    });

    test('an owner notice reaches the screens', () async {
      final bus = DataRefresh();
      final auth = AuthState(
        apiClient: FakeApi(),
        secureStorage: FakeStore(),
        dataRefresh: bus,
      );

      await auth.push.onOwnerNotice?.call('Stall Staff 1 timed in at CART-01');

      expect(bus.lastReason, 'notice');
      expect(bus.lastMessage, 'Stall Staff 1 timed in at CART-01');
      expect(bus.lastMessageIsSuccess, isTrue);
    });

    test('a tap on an unregistered card is silent', () async {
      final bus = DataRefresh();
      final auth = AuthState(
        apiClient: FakeApi(),
        secureStorage: FakeStore(),
        dataRefresh: bus,
      );

      await auth.push.onShiftEvent?.call({
        'type': 'SHIFT',
        'status': 'unregistered',
        'event': 'IN',
      });

      // That tap is not about this phone - it may be anybody's card. A toast
      // about it would be noise on every device.
      expect(bus.lastMessage, isNull);
      expect(bus.version, 0, reason: 'nothing to refresh either');
    });
  });
}
