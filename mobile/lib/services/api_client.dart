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
  ApiException(this.message, {this.statusCode});

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
      : storage = secureStorage ??
            const SecureStoreAdapter(FlutterSecureStorage()),
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

  Future<http.Response> _send(Future<http.Response> Function() action) async {
    try {
      final res = await action().timeout(const Duration(seconds: 8));
      if (res.statusCode >= 400) {
        String message = 'Request failed (${res.statusCode})';
        try {
          final body = jsonDecode(res.body) as Map<String, dynamic>?;
          message = body?['error'] as String? ?? message;
        } catch (_) {
          // Non-JSON error body (gateway HTML etc.) - keep generic message.
        }
        throw ApiException(message, statusCode: res.statusCode);
      }
      return res;
    } on TimeoutException {
      throw ApiException('Timed out reaching CartIQ server at $currentBaseUrl');
    } on SocketException catch (e) {
      throw ApiException(
        'Cannot reach CartIQ server at $currentBaseUrl'
        ' (${e.message})',
      );
    } catch (e) {
      if (e is ApiException) rethrow;
      throw ApiException('Network error reaching CartIQ server: $e');
    }
  }

  Future<Map<String, dynamic>> login(String username, String password) async {
    final res = await _send(
      () => _http.post(
        _uri('/auth/login'),
        headers: _headers(),
        body: jsonEncode({'username': username, 'password': password}),
      ),
    );
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  Future<Map<String, dynamic>> me(String token) async {
    final res = await _send(
      () => _http.get(_uri('/auth/me'), headers: _headers(token: token)),
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

  /// Change the account password. Server revokes all sessions on success,
  /// so the caller must re-login immediately after.
  Future<Map<String, dynamic>> changePassword(
    String token, {
    required String currentPassword,
    required String newPassword,
  }) async {
    final res = await _send(
      () => _http.post(
        _uri('/auth/change-password'),
        headers: _headers(token: token),
        body: jsonEncode({
          'currentPassword': currentPassword,
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
