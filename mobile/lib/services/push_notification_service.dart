import 'dart:async';
import 'dart:typed_data';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

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
        _showForeground(message);
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

  Future<void> _showForeground(RemoteMessage message) async {
    final payload = _payloadFor(message);
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
