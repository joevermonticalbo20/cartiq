import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import '../config.dart';
import 'kv_store.dart';

export 'kv_store.dart' show KeyValueStore;

class ApiException implements Exception {
  final String message;
  final int? statusCode;
  final String? code;
  final String? flavorName;
  // Login lockout metadata from the API. Null on every other error.
  final int? retryAfterSeconds;
  final DateTime? lockedUntil;
  final int? attemptsRemaining;
  const ApiException(
    this.message, {
    this.statusCode,
    this.code,
    this.flavorName,
    this.retryAfterSeconds,
    this.lockedUntil,
    this.attemptsRemaining,
  });

  @override
  String toString() => message;
}

/// Normalizes free-typed server input ("192.168.1.5", "http://host:4000/",
/// "host:4000/api") into a full API base URL.
String normalizeApiBaseUrl(String input) {
  var v = input.trim();
  if (v.isEmpty) throw ApiException('Enter a server address');
  if (!v.contains('://')) v = 'http://$v';
  v = v.replaceAll(RegExp(r'/+$'), '');
  if (!v.endsWith('/api')) v = '$v/api';
  final uri = Uri.tryParse(v);
  if (uri == null || uri.host.isEmpty) {
    throw ApiException('Invalid server address "$input"');
  }
  return v;
}

/// Thin HTTP client for the local CartIQ REST API.
class ApiClient {
  static const noInternetMessage =
      'No internet connection. Your orders are safely saved offline and will sync automatically when you reconnect.';
  static const timeoutMessage =
      'The server is taking too long to respond due to a slow connection. Please check your signal and try again.';
  static const unavailableMessage =
      'The server is temporarily unavailable. Your local POS transactions are safe—please try again shortly.';
  static const sessionExpiredMessage =
      'Your session has expired. Please log in again or use your Offline PIN to continue.';
  static const permissionDeniedMessage =
      'You do not have permission to do that. Check your assigned cart or ask a manager.';
  static const rateLimitedMessage =
      'The server is busy right now. Please wait a moment and try again.';
  static const conflictMessage =
      'The information changed on the server. Refresh and try again.';

  static const _manualKey = 'cartiq_api_url';
  static const _catalogKey = 'cartiq_catalog_json';
  static const _catalogTsKey = 'cartiq_catalog_ts';
  static const _lanKey = 'cartiq_lan_discovery';

  /// Fresh-enough catalog is shown instantly without a network round trip.
  static const catalogCacheTtl = Duration(minutes: 15);

  final http.Client _http;
  final KeyValueStore storage;
  String? _resolvedBaseUrl;
  bool _isManual = false;

  ApiClient({KeyValueStore? secureStorage, http.Client? httpClient})
    : storage =
          secureStorage ?? const SecureStoreAdapter(FlutterSecureStorage()),
      _http = httpClient ?? http.Client();

  Future<void> ensureResolved() async {
    if (_resolvedBaseUrl != null) return;
    try {
      final manual = await storage.read(key: _manualKey);
      if (manual != null && manual.isNotEmpty) {
        // Migration: pinned *.onrender.com URLs are unreachable on networks
        // that block Render (e.g. PLDT). Drop them so the fresh install
        // default (Supabase, same database) takes over instead of failing
        // forever against a stored dead host.
        if (manual.contains('onrender.com')) {
          try {
            await storage.delete(key: _manualKey);
          } catch (_) {}
        } else {
          _resolvedBaseUrl = manual;
          _isManual = true;
          return;
        }
      }
    } catch (_) {
      // Secure storage unavailable - fall through to discovery.
    }
    _resolvedBaseUrl ??= await AppConfig.resolveApiUrl(
      enableLan: await getLanDiscovery(),
    );
  }

  /// Skip discovery and use the built-in fallback URL.
  void useFallback() {
    _resolvedBaseUrl ??= AppConfig.apiBaseUrl;
  }

  /// Forget any manual URL and re-run subnet discovery.
  Future<String> rescan() async {
    try {
      await storage.delete(key: _manualKey);
    } catch (_) {}
    _isManual = false;
    _resolvedBaseUrl = await AppConfig.resolveApiUrl(
      enableLan: await getLanDiscovery(),
    );
    return _resolvedBaseUrl!;
  }

  /// Forget manual + discovered URLs and return to the built-in default.
  Future<String> resetServerToDefault() async {
    try {
      await storage.delete(key: _manualKey);
    } catch (_) {}
    _isManual = false;
    _resolvedBaseUrl = AppConfig.apiBaseUrl;
    return _resolvedBaseUrl!;
  }

  /// Offline LAN pilot switch (default OFF). When ON, boot/rescan may attach
  /// to a same-Wi-Fi dev server instead of the shared production database.
  Future<bool> getLanDiscovery() async {
    try {
      return (await storage.read(key: _lanKey)) == '1';
    } catch (_) {
      return false;
    }
  }

  Future<void> setLanDiscovery(bool enabled) async {
    try {
      await storage.write(key: _lanKey, value: enabled ? '1' : '0');
    } catch (_) {}
  }

  /// When the cached catalog was last refreshed (null = never).
  Future<DateTime?> catalogUpdatedAt() async {
    try {
      final ts = await storage.read(key: _catalogTsKey);
      return ts == null ? null : DateTime.tryParse(ts);
    } catch (_) {
      return null;
    }
  }

  /// The persisted catalog regardless of age, or null when nothing is cached.
  /// Used when a signed-out/offline device has no session to fetch with —
  /// losing the cached menu is worse than showing a stale one.
  Future<Map<String, dynamic>?> catalogCache() => _readCatalogCache();

  /// Drop the cached catalog (next POS open refetches).
  Future<void> clearCatalogCache() async {
    try {
      await storage.delete(key: _catalogKey);
    } catch (_) {}
    try {
      await storage.delete(key: _catalogTsKey);
    } catch (_) {}
  }

  /// Pin a manual server URL (persisted across restarts).
  Future<String> setManualBaseUrl(String input) async {
    final normalized = normalizeApiBaseUrl(input);
    _resolvedBaseUrl = normalized;
    _isManual = true;
    try {
      await storage.write(key: _manualKey, value: normalized);
    } catch (_) {}
    return normalized;
  }

  /// The base URL actually in use (resolved, manual, or fallback).
  String get currentBaseUrl => _resolvedBaseUrl ?? AppConfig.apiBaseUrl;

  /// True when talking over plain HTTP (LAN dev). Shown in UI as a
  /// subtle warning — never use public WiFi with an http:// server.
  bool get isInsecureUrl => currentBaseUrl.startsWith('http://');

  /// True when the URL was typed by the user rather than discovered.
  bool get isManualUrl => _isManual;

  /// Quick reachability probe used by the login server row and boot splash.
  Future<bool> testConnection() => health();

  Uri _uri(String path) =>
      Uri.parse('${_resolvedBaseUrl ?? AppConfig.apiBaseUrl}$path');

  Map<String, String> _headers({String? token}) => {
    'Content-Type': 'application/json',
    if (token != null) 'Authorization': 'Bearer $token',
  };

  Future<http.Response> _send(
    Future<http.Response> Function() action, {
    bool preserveUnauthorizedMessage = false,
    bool preserveRateLimitMessage = false,
  }) async {
    try {
      final res = await action().timeout(const Duration(seconds: 15));
      if (res.statusCode >= 400) {
        Map<String, dynamic>? body;
        try {
          final decoded = jsonDecode(res.body);
          if (decoded is Map<String, dynamic>) body = decoded;
        } catch (_) {
          // A gateway may return HTML instead of the API's JSON error shape.
        }
        final rawError = body?['error'];
        final rawMessage = body?['message'];
        final details = body?['details'] is Map<String, dynamic>
            ? body!['details'] as Map<String, dynamic>
            : const <String, dynamic>{};
        final errorObject = rawError is Map<String, dynamic>
            ? rawError
            : const <String, dynamic>{};
        final serverMessage = rawError is String
            ? rawError
            : errorObject['message'] is String
            ? errorObject['message'] as String
            : rawMessage is String
            ? rawMessage
            : 'Request failed (${res.statusCode})';
        final codeValue =
            body?['code'] ??
            body?['errorCode'] ??
            errorObject['code'] ??
            details['code'];
        final code = codeValue is String
            ? codeValue
            : rawError is String &&
                  RegExp(r'^[A-Z][A-Z0-9_]+$').hasMatch(rawError)
            ? rawError
            : null;
        final flavorValue =
            body?['flavorName'] ??
            body?['flavor'] ??
            body?['itemName'] ??
            errorObject['flavorName'] ??
            errorObject['flavor'] ??
            details['flavorName'] ??
            details['flavor'];
        final flavorName = flavorValue is String && flavorValue.isNotEmpty
            ? flavorValue
            : null;
        final retryValue = body?['retryAfterSeconds'];
        final retryAfterSeconds = retryValue is num ? retryValue.ceil() : null;
        final lockedUntilValue = body?['lockedUntil'];
        final lockedUntil = lockedUntilValue is String
            ? DateTime.tryParse(lockedUntilValue)
            : null;
        final attemptsValue = body?['attemptsRemaining'];
        final attemptsRemaining = attemptsValue is num
            ? attemptsValue.toInt()
            : null;

        if (res.statusCode == 401 && !preserveUnauthorizedMessage) {
          throw ApiException(
            sessionExpiredMessage,
            statusCode: 401,
            code: code,
          );
        }
        if (res.statusCode == 409 &&
            (code == 'INSUFFICIENT_STOCK' ||
                serverMessage.contains('INSUFFICIENT_STOCK'))) {
          final flavor = flavorName ?? 'selected flavor';
          throw ApiException(
            'Stock for $flavor just ran out. Please update your cart before checking out.',
            statusCode: 409,
            code: 'INSUFFICIENT_STOCK',
            flavorName: flavorName,
          );
        }
        if (res.statusCode == 403) {
          throw ApiException(permissionDeniedMessage, statusCode: 403);
        }
        if (res.statusCode == 409) {
          throw ApiException(conflictMessage, statusCode: 409, code: code);
        }
        if (res.statusCode == 429) {
          throw ApiException(
            preserveRateLimitMessage ? serverMessage : rateLimitedMessage,
            statusCode: 429,
            code: code,
            retryAfterSeconds: retryAfterSeconds,
            lockedUntil: lockedUntil,
            attemptsRemaining: attemptsRemaining,
          );
        }
        if (res.statusCode == 500 ||
            res.statusCode == 502 ||
            res.statusCode == 503) {
          throw ApiException(unavailableMessage, statusCode: res.statusCode);
        }
        throw ApiException(
          serverMessage,
          statusCode: res.statusCode,
          code: code,
          retryAfterSeconds: retryAfterSeconds,
          lockedUntil: lockedUntil,
          attemptsRemaining: attemptsRemaining,
        );
      }
      return res;
    } on TimeoutException {
      throw ApiException(timeoutMessage);
    } on SocketException {
      throw ApiException(noInternetMessage);
    } on http.ClientException {
      throw ApiException(noInternetMessage);
    } catch (e) {
      if (e is ApiException) rethrow;
      throw ApiException('Could not complete the request. Please try again.');
    }
  }

  Future<Map<String, dynamic>> login(String username, String password) async {
    final res = await _send(
      () => _http.post(
        _uri('/auth/login'),
        headers: _headers(),
        body: jsonEncode({'username': username, 'password': password}),
      ),
      preserveUnauthorizedMessage: true,
      preserveRateLimitMessage: true,
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> me(String token) async {
    final res = await _send(
      () => _http.get(_uri('/auth/me'), headers: _headers(token: token)),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Change the signed-in account's recovery email. The current password is
  /// required so a stolen session cannot redirect password recovery.
  Future<Map<String, dynamic>> updateProfile(
    String token, {
    required String email,
    required String currentPassword,
  }) async {
    final res = await _send(
      () => _http.patch(
        _uri('/auth/me'),
        headers: _headers(token: token),
        body: jsonEncode({'email': email, 'currentPassword': currentPassword}),
      ),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Exchange a refresh token for a fresh access + rotated refresh token.
  Future<Map<String, dynamic>> refresh(String refreshToken) async {
    final res = await _send(
      () => _http.post(
        _uri('/auth/refresh'),
        headers: _headers(),
        body: jsonEncode({'refreshToken': refreshToken}),
      ),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Email a 6-digit password-change code to the signed-in account.
  /// Fails when the account still has only a placeholder recovery email.
  Future<Map<String, dynamic>> requestChangePasswordCode(String token) async {
    final res = await _send(
      () => _http.post(
        _uri('/auth/change-password/otp'),
        headers: _headers(token: token),
        body: jsonEncode(const <String, dynamic>{}),
      ),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Change the account password. The email code is the second factor and is
  /// mandatory; the server revokes all sessions on success, so the caller must
  /// re-login immediately after.
  Future<Map<String, dynamic>> changePassword(
    String token, {
    required String currentPassword,
    required String newPassword,
    required String code,
  }) async {
    final res = await _send(
      () => _http.post(
        _uri('/auth/change-password'),
        headers: _headers(token: token),
        body: jsonEncode({
          'currentPassword': currentPassword,
          'newPassword': newPassword,
          'code': code,
        }),
      ),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  // --- RFID card registration (self-service) -------------------------------
  // The reader (ESP32 + MFRC522) only ever reports a tag UID; it does not know
  // who is holding the card. So the app opens a short-lived claim on its cart
  // and polls until the next tap on that cart's reader resolves it.

  /// The tag UID bound to this account, or null when none is registered.
  Future<String?> myRfid(String token) async {
    final res = await _send(
      () => _http.get(_uri('/auth/my-rfid'), headers: _headers(token: token)),
    );
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return body['rfidUid'] as String?;
  }

  /// Attendance history for one cart on one day (Manila date, YYYY-MM-DD).
  /// Returns the same envelope the web page consumes: `{ data, meta }`.
  Future<Map<String, dynamic>> shiftsHistory(
    String token, {
    required String code,
    required String date,
    int pageSize = 100,
  }) async {
    final res = await _send(
      () => _http.get(
        _uri(
          '/shifts/history?code=$code&date=$date&pageSize=$pageSize',
        ),
        headers: _headers(token: token),
      ),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Announce "someone is at this cart with a card". Returns the claim as
  /// `{claimId, status, expiresAt, locationCode, event}`.
  ///
  /// [locationCode] is only needed for an owner, who is not assigned to a cart;
  /// staff always use their own.
  ///
  /// [event] is `"IN"` / `"OUT"` when the person is clocking on or off, and null
  /// when they are only enrolling a card. Passing it means the tap records that
  /// shift instead of the firmware's blind IN/OUT toggle.
  Future<Map<String, dynamic>> startRfidClaim(
    String token, {
    String? locationCode,
    String? event,
  }) async {
    final res = await _send(
      () => _http.post(
        _uri('/auth/my-rfid/claim'),
        headers: _headers(token: token),
        body: jsonEncode({'locationCode': ?locationCode, 'event': ?event}),
      ),
    );
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return body['claim'] as Map<String, dynamic>;
  }

  /// Poll a claim. Returns the same shape as [startRfidClaim] with `status` one
  /// of `pending`, `bound`, `conflict` or `expired`.
  Future<Map<String, dynamic>> rfidClaimStatus(
    String token,
    String claimId,
  ) async {
    final res = await _send(
      () => _http.get(
        _uri('/auth/my-rfid/claim/$claimId'),
        headers: _headers(token: token),
      ),
    );
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return body['claim'] as Map<String, dynamic>;
  }

  /// Remove this account's own card. Throws when offline.
  Future<Map<String, dynamic>> unbindRfid(String token) async {
    final res = await _send(
      () =>
          _http.delete(_uri('/auth/my-rfid'), headers: _headers(token: token)),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// The cart-wide Time clock windows (web dashboard → Settings → Time clock).
  /// Returns the normalized config: `{enabled, inOpen, inClose, outOpen, outClose}`.
  /// Any signed-in role may read it — the POS uses it to grey out the Time in /
  /// Time out buttons while they are closed. Throws [ApiException] on failure.
  Future<Map<String, dynamic>> getTimeClock(String token) async {
    final res = await _send(
      () => _http.get(
        _uri('/settings/timeclock'),
        headers: _headers(token: token),
      ),
    );
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return (body['clock'] as Map<String, dynamic>?) ?? const {};
  }

  /// Request an email OTP for password reset. Always succeeds with the same
  /// generic message (the server never reveals whether the email is known).
  Future<Map<String, dynamic>> forgotPassword(String email) async {
    final res = await _send(
      () => _http.post(
        _uri('/auth/forgot-password'),
        headers: _headers(),
        body: jsonEncode({'email': email}),
      ),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Check the reset code before asking for a new password, so a typo does not
  /// throw away the code or show a misleading password screen.
  Future<Map<String, dynamic>> verifyResetCode({
    required String email,
    required String code,
  }) async {
    final res = await _send(
      () => _http.post(
        _uri('/auth/verify-reset-code'),
        headers: _headers(),
        body: jsonEncode({'email': email, 'code': code}),
      ),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Redeem a reset OTP with a new password. Server revokes all sessions,
  /// so the caller must sign in fresh afterwards.
  Future<Map<String, dynamic>> resetPassword({
    required String email,
    required String code,
    required String newPassword,
  }) async {
    final res = await _send(
      () => _http.post(
        _uri('/auth/reset-password'),
        headers: _headers(),
        body: jsonEncode({
          'email': email,
          'code': code,
          'newPassword': newPassword,
        }),
      ),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Revoke a refresh token server-side. Best-effort: never throws, so
  /// logout always completes locally even offline.
  Future<void> logout(String? refreshToken) async {
    if (refreshToken == null || refreshToken.isEmpty) return;
    try {
      await _http
          .post(
            _uri('/auth/logout'),
            headers: _headers(),
            body: jsonEncode({'refreshToken': refreshToken}),
          )
          .timeout(const Duration(seconds: 5));
    } catch (_) {
      // offline or already revoked: local logout still proceeds
    }
  }

  Future<bool> health() async {
    try {
      final res = await _http
          .get(_uri('/health'))
          .timeout(const Duration(seconds: 5));
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// POS catalog: products + locations.
  ///
  /// Serves the persisted catalog instantly when it is fresher than
  /// [catalogCacheTtl] (no network). Pass [forceRefresh] for pull-to-refresh
  /// and app-resume so new/removed products show up. When the network fails
  /// and a stale copy exists, the stale copy is returned so the POS still
  /// opens offline (sales stay duplicate-safe via clientRef).
  Future<Map<String, dynamic>> catalog(
    String token, {
    bool forceRefresh = false,
  }) async {
    if (!forceRefresh) {
      final cached = await _readCatalogCache(maxAge: catalogCacheTtl);
      if (cached != null) return cached;
    }
    try {
      final res = await _send(
        () => _http.get(_uri('/catalog'), headers: _headers(token: token)),
      );
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      await _writeCatalogCache(res.body);
      return body;
    } on ApiException catch (e) {
      // Network-level failure only (no status code): fall back to stale
      // cache. Auth/server errors still throw so the UI shows them.
      if (e.statusCode == null && !forceRefresh) {
        final cached = await _readCatalogCache();
        if (cached != null) return cached;
      }
      rethrow;
    }
  }

  Future<Map<String, dynamic>?> _readCatalogCache({Duration? maxAge}) async {
    try {
      final cached = await storage.read(key: _catalogKey);
      if (cached == null || cached.isEmpty) return null;
      if (maxAge != null) {
        final ts = await storage.read(key: _catalogTsKey);
        if (ts == null) return null;
        if (DateTime.now().difference(DateTime.parse(ts)) >= maxAge) {
          return null;
        }
      }
      return jsonDecode(cached) as Map<String, dynamic>;
    } catch (_) {
      return null;
    }
  }

  Future<void> _writeCatalogCache(String rawBody) async {
    try {
      await storage.write(key: _catalogKey, value: rawBody);
      await storage.write(
        key: _catalogTsKey,
        value: DateTime.now().toIso8601String(),
      );
    } catch (_) {
      // Cache is best-effort; the live response is already in hand.
    }
  }

  Future<List<dynamic>> inventory(String token, {String? locationCode}) async {
    final path = locationCode == null
        ? '/inventory'
        : '/inventory?code=$locationCode';
    final res = await _send(
      () => _http.get(_uri(path), headers: _headers(token: token)),
    );
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return body['locations'] as List<dynamic>;
  }

  Future<List<dynamic>> restockRequests(
    String token, {
    String? locationCode,
  }) async {
    final path = locationCode == null
        ? '/inventory/restock-requests'
        : '/inventory/restock-requests?code=${Uri.encodeQueryComponent(locationCode)}';
    final res = await _send(
      () => _http.get(_uri(path), headers: _headers(token: token)),
    );
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return body['data'] as List<dynamic>;
  }

  Future<Map<String, dynamic>> createRestockRequest(
    String token,
    Map<String, dynamic> payload,
  ) async {
    final res = await _send(
      () => _http.post(
        _uri('/inventory/restock-request'),
        headers: _headers(token: token),
        body: jsonEncode(payload),
      ),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> submitOrder(
    Map<String, dynamic> payload,
    String token,
  ) async {
    final res = await _send(
      () => _http.post(
        _uri('/orders'),
        headers: _headers(token: token),
        body: jsonEncode(payload),
      ),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> createExpense(
    String token,
    Map<String, dynamic> payload,
  ) async {
    final res = await _send(
      () => _http.post(
        _uri('/expenses'),
        headers: _headers(token: token),
        body: jsonEncode(payload),
      ),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// 7-day sales series for the home sparkline. Never throws - returns [].
  Future<List<double>> salesSeries(
    String token, {
    String? locationCode,
    int days = 7,
  }) async {
    try {
      final params =
          'days=$days${locationCode != null ? '&code=$locationCode' : ''}';
      final res = await _send(
        () => _http.get(
          _uri('/analytics/trends?$params'),
          headers: _headers(token: token),
        ),
      );
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      final series = (body['daily_series'] as List?) ?? [];
      return series
          .map<double>(
            (e) => (((e as Map?)?['total_sales'] ?? 0) as num).toDouble(),
          )
          .toList();
    } catch (_) {
      return [];
    }
  }

  Future<Map<String, dynamic>> dailyReport(
    String token, {
    String? locationCode,
    int? daysAgo,
  }) async {
    final params = <String, String>{};
    if (locationCode != null) params['code'] = locationCode;
    if (daysAgo != null) params['daysAgo'] = daysAgo.toString();
    final query = params.isEmpty
        ? ''
        : '?${params.entries.map((e) => '${e.key}=${e.value}').join('&')}';
    final res = await _send(
      () => _http.get(
        _uri('/reports/daily$query'),
        headers: _headers(token: token),
      ),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> ordersPaged(
    String token, {
    int page = 1,
    int pageSize = 10,
    String? locationCode,
  }) async {
    final path =
        '/orders?page=$page&pageSize=$pageSize${locationCode != null ? '&location_code=$locationCode' : ''}';
    final res = await _send(
      () => _http.get(_uri(path), headers: _headers(token: token)),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Convenience wrapper for [ordersPaged] — returns the `data` array.
  Future<List<dynamic>> orders(
    String token, {
    int page = 1,
    int pageSize = 10,
    String? locationCode,
  }) async {
    final r = await ordersPaged(
      token,
      page: page,
      pageSize: pageSize,
      locationCode: locationCode,
    );
    return (r['data'] as List?) ?? [];
  }

  /// Void an order: flips it to VOID and restores recipe stock server-side.
  ///
  /// Returns the raw `{ order, restored[], warnings[] }` payload. The
  /// warnings matter: a line whose recipe matched nothing (the product was
  /// renamed after the sale) restores NOTHING, and the API reports that
  /// rather than silently understating stock. Callers must surface them
  /// instead of claiming a clean void.
  ///
  /// [orderId] must be the numeric order id — the `clientRef` string is not
  /// accepted by this route.
  Future<Map<String, dynamic>> voidOrder(
    String token,
    int orderId, {
    String? reason,
  }) async {
    final res = await _send(
      () => _http.patch(
        _uri('/orders/$orderId'),
        headers: _headers(token: token),
        body: jsonEncode({
          'status': 'VOID',
          if (reason != null && reason.isNotEmpty) 'reason': reason,
        }),
      ),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Correct the payment method on a PAID order (stock untouched).
  ///
  /// The API rejects this on a VOID order, so callers should not offer the
  /// action for voided rows rather than letting the user tap into an error.
  Future<Map<String, dynamic>> updateOrderPayment(
    String token,
    int orderId,
    String paymentMethod,
  ) async {
    final res = await _send(
      () => _http.patch(
        _uri('/orders/$orderId'),
        headers: _headers(token: token),
        body: jsonEncode({'paymentMethod': paymentMethod}),
      ),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Upload the GCash proof photo for a recorded order (base64, ≤512 KB).
  /// The owner views it in the dashboard's Sales page.
  Future<Map<String, dynamic>> uploadOrderReceipt(
    String token,
    int orderId, {
    required String mime,
    required String data,
  }) async {
    final res = await _send(
      () => _http.post(
        _uri('/orders/$orderId/receipt'),
        headers: _headers(token: token),
        body: jsonEncode({'mime': mime, 'data': data}),
      ),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// Fetch the receipt bytes for the in-app viewer (authenticated; receipts
  /// are private to the owner and the order's own cart).
  Future<List<int>> fetchOrderReceipt(String token, int orderId) async {
    final res = await _send(
      () => _http.get(
        _uri('/orders/$orderId/receipt'),
        headers: _headers(token: token),
      ),
    );
    return res.bodyBytes;
  }

  /// Ask the owner to void a recorded sale. Staff file the request; the
  /// owner approves or denies it from the dashboard.
  Future<Map<String, dynamic>> requestVoidOrder(
    String token,
    int orderId, {
    String? reason,
  }) async {
    final res = await _send(
      () => _http.post(
        _uri('/orders/$orderId/void-request'),
        headers: _headers(token: token),
        body: jsonEncode({
          if (reason != null && reason.isNotEmpty) 'reason': reason,
        }),
      ),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// One-document probe the POS polls to notice dashboard menu changes
  /// without refetching the whole catalog.
  Future<int> catalogVersion(String token) async {
    final res = await _send(
      () => _http.get(
        _uri('/catalog/version'),
        headers: _headers(token: token),
      ),
    );
    final data = jsonDecode(res.body) as Map<String, dynamic>;
    final v = data['version'];
    return v is num ? v.toInt() : 0;
  }

  Future<Map<String, dynamic>> stockAlerts(
    String token, {
    bool unreadOnly = true,
  }) async {
    final path = unreadOnly ? '/alerts?unread_only=true' : '/alerts';
    final res = await _send(
      () => _http.get(_uri(path), headers: _headers(token: token)),
    );
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return body;
  }

  Future<List<dynamic>> stockAlertsList(
    String token, {
    bool unreadOnly = true,
  }) async {
    final r = await stockAlerts(token, unreadOnly: unreadOnly);
    return (r['data'] as List?) ?? [];
  }

  Future<void> markAlertRead(String token, int id) async {
    await _send(
      () => _http.patch(
        _uri('/alerts/$id/read'),
        headers: _headers(token: token),
      ),
    );
  }

  Future<void> markAllAlertsRead(String token) async {
    await _send(
      () => _http.patch(
        _uri('/alerts/read'),
        headers: _headers(token: token),
      ),
    );
  }
  Future<Map<String, dynamic>> staffOnShift(String token) async {
    final res = await _send(
      () => _http.get(_uri('/staff/on-shift'), headers: _headers(token: token)),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> expensesPaged(
    String token, {
    int page = 1,
    int pageSize = 10,
    String? locationCode,
  }) async {
    final path =
        '/expenses?page=$page&pageSize=$pageSize${locationCode != null ? '&code=$locationCode' : ''}';
    final res = await _send(
      () => _http.get(_uri(path), headers: _headers(token: token)),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }
}
