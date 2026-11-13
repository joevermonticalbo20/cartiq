import 'dart:async';
import 'dart:typed_data';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

/// The data-only push the server sends when the MENU changed (product
/// archived, price or recipe edited, stock adjusted).
///
/// The app reloads its catalog on it - silently. No notification: a popup
/// for every menu tweak would train the vendor to dismiss them.
const String catalogChangedPushType = 'CATALOG_CHANGED';

/// True when this message is the "the menu changed" signal.
bool isCatalogChanged(Map<String, dynamic> data) =>
    (data['type'] ?? '').toString().toUpperCase() == catalogChangedPushType;

/// The data-only push the server sends when a card was tapped on the reader.
const String shiftPushType = 'SHIFT';

/// True when this message is a recorded card tap.
bool isShiftEvent(Map<String, dynamic> data) =>
    (data['type'] ?? '').toString().toUpperCase() == shiftPushType;

/// What the server did with the tap.
///
/// "recorded" - the shift is written, the app refreshes the attendance.
/// "unregistered" - the card belongs to nobody yet.
/// "refused" - the server would not log it (outside the clock window).
///
/// Every outcome is pushed, not just the happy one: a tap that silently does
/// nothing looks like broken hardware.
const String shiftRecorded = 'recorded';
const String shiftUnregistered = 'unregistered';
const String shiftRefused = 'refused';

/// The outcome of a tap push, defaulting to "recorded" (the old behaviour).
String shiftStatusOf(Map<String, dynamic> data) {
  final status = (data['status'] ?? '').toString().toLowerCase();
  if (status == shiftUnregistered || status == shiftRefused) return status;
  return shiftRecorded;
}

/// The human reason the server gave for refusing a tap (empty when none).
String shiftReasonOf(Map<String, dynamic> data) =>
    (data['reason'] ?? '').toString().trim();

/// The push an OWNER gets when something happens at a cart: a staff member
/// timed in or out, or a card was registered.
///
/// Unlike the staff-side signals this one already carries the sentence to show
/// ("Stall Staff 1 timed in at CART-01"), so the app does not have to rebuild
/// it from ids.
const String ownerNoticePushType = 'OWNER_NOTICE';

/// True when this message is a notice for the owner/admin account.
bool isOwnerNotice(Map<String, dynamic> data) =>
    (data['type'] ?? '').toString().toUpperCase() == ownerNoticePushType;

/// The sentence an owner notice should say, e.g. "Stall Staff 1 timed in at
/// CART-01". Empty when the push carried none.
String ownerNoticeMessage(Map<String, dynamic> data) {
  final body = (data['body'] ?? '').toString().trim();
  if (body.isNotEmpty) return body;
  return (data['message'] ?? '').toString().trim();
}

/// Server-side FCM metadata for one CartIQ alert. The backend stores the
/// same values in the targeted-alert payload so a tap can refresh the list,
/// not merely acknowledge a local notification.
class CartIQPushPayload {
  const CartIQPushPayload({
    required this.alertId,
    required this.type,
    required this.title,
    required this.body,
  });

  final int? alertId;
  final String type;
  final String title;
  final String body;
}

/// The only Firebase-touching class in the app. It owns:
/// 1. `Firebase.initializeApp()` (best-effort — the POS must boot offline).
/// 2. FCM token acquisition/rotation and forwarding a token to the API.
/// 3. Foreground messages, shown as local notifications on the
///    `cartiq_alerts` channel.
/// 4. Taps on FCM or local notifications, which just refresh alerts.
///
/// Background/terminated messages use FCM notification payloads so Android
/// displays them directly. The Dart background handler returns for those and
/// only handles data-only fallbacks with the same alert id/tag.
class CartIQPushService {
  CartIQPushService({
    FirebaseMessaging? messaging,
    FlutterLocalNotificationsPlugin? localNotifications,
  })  : _messagingOverride = messaging,
        _notifications = localNotifications ?? FlutterLocalNotificationsPlugin();

  static const channelId = 'cartiq_alerts';

  /// Injected for tests; the production path lazily uses
  /// [FirebaseMessaging.instance] only after Firebase.initializeApp succeeds.
  FirebaseMessaging? _messagingOverride;
  FirebaseMessaging get _messaging =>
      _messagingOverride ??= FirebaseMessaging.instance;

  final FlutterLocalNotificationsPlugin _notifications;

  /// Invoked when the user taps a notification shown by FCM or local
  /// notifications, with the alert id/type parsed from the payload.
  Future<void> Function(String type, int? alertId)? onNotificationOpened;

  /// Invoked when the server says the menu changed (a product was archived,
  /// a price or recipe edited, stock adjusted). The app reloads its catalog:
  /// the vendor must stop selling a product the owner just pulled.
  Future<void> Function()? onCatalogChanged;

  /// Invoked when an OWNER notice arrives: a staff member timed in or out at a
  /// cart, or a card was registered. The app says it out loud - the owner is
  /// usually not looking at the dashboard.
  Future<void> Function(String message)? onOwnerNotice;

  /// Invoked when a card was tapped on the reader. The app reflects the tap
  /// right away - the tap is the whole point of the reader, so it must show
  /// up at once.
  ///
  /// The payload says what the server did with the tap: a recorded shift
  /// (refresh the attendance), an unregistered card, or a refusal with a
  /// reason. A tap that silently does nothing looks like broken hardware.
  Future<void> Function(Map<String, dynamic> data)? onShiftEvent;

  /// Test seam: when set, the local notification goes here instead of the
  /// notification plugin, so a test can prove that a message stays silent.
  @visibleForTesting
  Future<void> Function(CartIQPushPayload payload)? notificationSink;

  bool _ready = false;
  Future<bool>? _registrationFuture;
  StreamSubscription<RemoteMessage>? _foregroundSubscription;
  StreamSubscription<RemoteMessage>? _openedSubscription;
  StreamSubscription<String>? _tokenSubscription;
  String? _registeredToken;

  /// True once Firebase and the local-notification channel are ready.
  bool get ready => _ready;

  /// Request notification permission (Android 13+), cache the FCM token and
  /// invoke [onToken] with it so [AuthState] can register it with the API.
  /// Never throws — push is an enhancement, never a login blocker.
  Future<bool> initializeAndRegister({
    required Future<void> Function(String token) onToken,
  }) {
    final inFlight = _registrationFuture;
    if (inFlight != null) return inFlight;
    final future = _initializeAndRegister(onToken: onToken);
    _registrationFuture = future;
    future.whenComplete(() {
      if (identical(_registrationFuture, future)) _registrationFuture = null;
    });
    return future;
  }

  Future<bool> _initializeAndRegister({
    required Future<void> Function(String token) onToken,
  }) async {
    if (_ready) {
      await _forwardToken(onToken);
      return true;
    }
    try {
      await _ensureLocalNotifications();

      final authorization = await _messaging.requestPermission();
      if (authorization.authorizationStatus != AuthorizationStatus.authorized &&
          authorization.authorizationStatus != AuthorizationStatus.provisional) {
        return false;
      }

      FirebaseMessaging.onBackgroundMessage(_backgroundMessageHandler);

      _foregroundSubscription ??= FirebaseMessaging.onMessage.listen((message) {
        handleForegroundMessage(message);
      });
      _openedSubscription ??= FirebaseMessaging.onMessageOpenedApp.listen((message) {
        _handleOpened(message);
      });
      // ignore: deprecated_member_use
      _tokenSubscription ??= _messaging.onTokenRefresh.listen((token) {
        _forwardToken(onToken, token: token);
      });

      final initialMessage = await _messaging.getInitialMessage();
      if (initialMessage != null) _handleOpened(initialMessage);

      _ready = true;
      await _forwardToken(onToken);
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<void> _forwardToken(
    Future<void> Function(String token) onToken, {
    String? token,
  }) async {
    try {
      // ignore: deprecated_member_use
      final current = token ?? await _messaging.getToken();
      if (current == null || current.isEmpty) return;
      if (current == _registeredToken) return;
      await onToken(current);
      _registeredToken = current;
    } catch (_) {
      // Best-effort: the API layer may be offline or FCM may be unavailable.
    }
  }

  Future<void> _ensureLocalNotifications() async {
    const android = AndroidInitializationSettings('@mipmap/ic_launcher');
    await _notifications.initialize(
      settings: const InitializationSettings(android: android),
      onDidReceiveNotificationResponse: (response) {
        final parts = (response.payload ?? '').split('|');
        final alertId = parts.length > 1 ? int.tryParse(parts[1]) : null;
        final type = parts.isNotEmpty ? parts.first : 'ALERT';
        onNotificationOpened?.call(type, alertId);
      },
    );
    await _notifications
        .resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()
        ?.createNotificationChannel(
          const AndroidNotificationChannel(
            channelId,
            'CartIQ Alerts',
            description: 'Void decisions and restock updates',
            importance: Importance.max,
          ),
        );
  }

  /// Handle one incoming message.
  ///
  /// Split out of the Firebase listener so it can be tested without Firebase
  /// (the listener itself needs the Firebase plugin).
  ///
  /// A menu change is a silent signal, not an alert: the app reloads the
  /// catalog instead of showing a notification the vendor has to dismiss.
  @visibleForTesting
  Future<void> handleForegroundMessage(RemoteMessage message) async {
    if (isCatalogChanged(message.data)) {
      await onCatalogChanged?.call();
      return;
    }
    if (isShiftEvent(message.data)) {
      await onShiftEvent?.call(message.data);
      return;
    }
    if (isOwnerNotice(message.data)) {
      // The owner sees this while the app is open: say it. No extra local
      // notification on top - the toast is already the news, and the push's
      // own notification block covers the app being closed.
      final text = ownerNoticeMessage(message.data);
      if (text.isNotEmpty) await onOwnerNotice?.call(text);
      return;
    }
    await _showForeground(message);
  }

  Future<void> _showForeground(RemoteMessage message) async {
    final payload = _payloadFor(message);
    final sink = notificationSink;
    if (sink != null) {
      await sink(payload);
      return;
    }
    try {
      final androidDetails = AndroidNotificationDetails(
        channelId,
        'CartIQ Alerts',
        channelDescription: 'Void decisions and restock updates',
        importance: Importance.max,
        priority: Priority.max,
        icon: '@mipmap/ic_launcher',
        // Short, double-buzz on every targeted alert so the counter
        // notices it even on mute-adjacent devices.
        vibrationPattern: Int64List.fromList([0, 180, 80, 180]),
        tag: payload.alertId?.toString(),
      );
      final notificationDetails = NotificationDetails(android: androidDetails);
      await _notifications.show(
        id: payload.alertId ?? 0,
        title: payload.title,
        body: payload.body,
        notificationDetails: notificationDetails,
        payload: '${payload.type}|${payload.alertId ?? ''}',
      );
    } catch (_) {}
  }

  Future<void> _handleOpened(RemoteMessage message) async {
    final payload = _payloadFor(message);
    try {
      await onNotificationOpened?.call(payload.type, payload.alertId);
    } catch (_) {}
  }

  CartIQPushPayload _payloadFor(RemoteMessage message) {
    final data = message.data;
    final alertId = int.tryParse((data['alertId'] ?? data['id'] ?? '').toString());
    final title = (message.notification?.title ?? data['title'] ?? 'CartIQ').toString();
    final body = (message.notification?.body ?? data['body'] ?? data['message'] ?? '').toString();
    return CartIQPushPayload(
      alertId: alertId,
      type: (data['type'] ?? data['alertType'] ?? 'ALERT').toString(),
      title: title,
      body: body,
    );
  }

  /// The last FCM token registered with the API (or null).
  Future<String?> currentRegisteredToken() async {
    if (_registeredToken != null) return _registeredToken;
    try {
      // ignore: deprecated_member_use
      return await _messaging.getToken();
    } catch (_) {
      return null;
    }
  }

  /// Delete the server-side registration and the local FCM token (sign-out,
  /// account switch). Best-effort; callers keep cached alerts and queue.
  Future<void> unregister({Future<void> Function()? removeFromApi}) async {
    try {
      await removeFromApi?.call();
    } catch (_) {}
    try {
      // ignore: deprecated_member_use
      await _messaging.deleteToken();
    } catch (_) {}
    _registeredToken = null;
  }

  Future<void> dispose() async {
    await _foregroundSubscription?.cancel();
    await _openedSubscription?.cancel();
    await _tokenSubscription?.cancel();
  }
}

/// Top-level background handler. The server sends notification payloads, so
/// this is a fallback for data-only messages only; it posts on the same
/// channel and must never double-post a notification-payload message.
@pragma('vm:entry-point')
Future<void> _backgroundMessageHandler(RemoteMessage message) async {
  try {
    // The server's CartIQ data-only payload is the single source for title
    // and body; a bare notification payload is handled by FCM itself.
    if (message.notification != null) return;
    // A menu change stays silent: the POS reloads the catalog when the app
    // comes back to the foreground.
    if (isCatalogChanged(message.data)) return;
    final title = (message.data['title'] ?? '').toString().trim();
    final body = (message.data['body'] ?? '').toString().trim();
    if (title.isEmpty && body.isEmpty) return;
    final alertId = int.tryParse((message.data['alertId'] ?? '').toString());
    await Firebase.initializeApp();
    final plugin = FlutterLocalNotificationsPlugin();
    await plugin.initialize(
      settings: const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
      ),
    );
    final androidDetails = AndroidNotificationDetails(
      CartIQPushService.channelId,
      'CartIQ Alerts',
      importance: Importance.max,
      priority: Priority.max,
      icon: '@mipmap/ic_launcher',
      vibrationPattern: Int64List.fromList([0, 180, 80, 180]),
      tag: alertId?.toString(),
    );
    await plugin.show(
      id: alertId ?? 0,
      title: title.isEmpty ? 'CartIQ update' : title,
      body: body,
      notificationDetails: NotificationDetails(android: androidDetails),
    );
  } catch (_) {}
}
