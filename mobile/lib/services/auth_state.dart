import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'api_client.dart';
import 'kv_store.dart';
import 'offline_pin.dart';

/// Holds the session token and profile for the whole app.
class AuthState extends ChangeNotifier {
  final ApiClient api;
  final KeyValueStore storage;
  late final OfflinePinService pin;

  String? token;
  String? refreshToken;
  Map<String, dynamic>? user;

  /// True when the session was unlocked offline via PIN (queue-only mode).
  bool offlineMode = false;

  AuthState({ApiClient? apiClient, KeyValueStore? secureStorage})
      : api = apiClient ?? ApiClient(),
        storage = secureStorage ??
            const SecureStoreAdapter(FlutterSecureStorage()) {
    pin = OfflinePinService(storage);
  }

  bool get isLoggedIn => token != null;

  /// Last successful online auth (login/refresh/profile fetch), ISO string.
  /// Drives the 7-day offline window and the "Last verified" UI row.
  Future<DateTime?> get lastOnline async {
    final raw = await storage.read(key: 'cartiq_last_online');
    return raw == null ? null : DateTime.tryParse(raw);
  }

  Future<void> _persistSession() async {
    if (token != null) {
      await storage.write(key: 'cartiq_token', value: token);
    }
    if (refreshToken != null) {
      await storage.write(key: 'cartiq_refresh_token', value: refreshToken!);
    }
    if (user != null) {
      await storage.write(key: 'cartiq_profile', value: jsonEncode(user));
    }
    await storage.write(
        key: 'cartiq_last_online', value: DateTime.now().toIso8601String());
  }

  Future<void> _restoreCachedProfile() async {
    try {
      final raw = await storage.read(key: 'cartiq_profile');
      if (raw != null && raw.isNotEmpty) {
        user = jsonDecode(raw) as Map<String, dynamic>;
      }
    } catch (_) {}
  }

  Future<void> restoreSession() async {
    token = await storage.read(key: 'cartiq_token');
    refreshToken = await storage.read(key: 'cartiq_refresh_token');
    if (token != null) {
      try {
        final data = await api.me(token!);
        user = data['user'] as Map<String, dynamic>?;
        await _persistSession();
      } on ApiException catch (e) {
        // Only drop on explicit server rejection (401/403) — NOT on
        // network failures (offline cold-start) to preserve session.
        if (e.statusCode == 401 || e.statusCode == 403) {
          // An expired access token with a valid refresh token can be
          // recovered silently; only sign out when refresh also fails.
          try {
            final recovered = await _tryRefresh();
            if (!recovered) await signOut();
          } on ApiException catch (refreshErr) {
            // Refresh explicitly rejected -> dead session. Anything else
            // (offline) keeps tokens + falls back to the cached profile so
            // the POS still knows its cart.
            if (refreshErr.statusCode != null) {
              await signOut();
            } else {
              await _restoreCachedProfile();
            }
          }
        } else {
          await _restoreCachedProfile();
        }
      }
    }
    notifyListeners();
  }

  /// Attempt to obtain a fresh access token from the stored refresh token.
  /// Returns true and persists new tokens on success. Returns false when the
  /// server explicitly rejects the session; throws [ApiException] with no
  /// status code on network failure so callers can tell offline apart.
  Future<bool> _tryRefresh() async {
    final rt = refreshToken;
    if (rt == null) return false;
    final data = await api.refresh(rt);
    token = data['token'] as String?;
    refreshToken = data['refreshToken'] as String?;
    user = data['user'] as Map<String, dynamic>?;
    await _persistSession();
    return true;
  }

  /// Refresh the access token mid-session (e.g. when a sync hits 401).
  /// Returns true when a fresh token was stored.
  Future<bool> refreshSession() async {
    try {
      final recovered = await _tryRefresh();
      if (recovered) notifyListeners();
      return recovered;
    } on ApiException catch (e) {
      // Offline: keep everything as-is; the sync layer retries later.
      if (e.statusCode == null) return false;
      return false;
    }
  }

  /// Unlock a cached STAFF session offline via PIN. Sets [offlineMode] and
  /// restores the cached profile. Throws [PinException] when not eligible.
  Future<void> unlockOffline(String pinCode) async {
    if (token == null || refreshToken == null) {
      throw const PinException(
          'noPin', 'No saved session on this device. Sign in online first.');
    }
    await _restoreCachedProfile();
    final role = user?['role'] as String?;
    if (role != 'STAFF') {
      throw const PinException(
          'notStaff', 'Offline login is for staff accounts.');
    }
    final last = await lastOnline;
    if (last == null ||
        DateTime.now().difference(last) > OfflinePinService.maxOfflineAge) {
      throw const PinException(
          'expired', 'Please connect to the internet to verify your account.');
    }
    final username = user?['username'] as String?;
    if (username == null || username.isEmpty) {
      throw const PinException(
          'noPin', 'No saved session on this device. Sign in online first.');
    }
    await pin.verifyPin(username: username, pin: pinCode);
    offlineMode = true;
    notifyListeners();
  }

  Future<void> signIn(String username, String password) async {
    final data = await api.login(username, password);
    token = data['token'] as String?;
    refreshToken = data['refreshToken'] as String?;
    user = data['user'] as Map<String, dynamic>?;
    offlineMode = false;
    await _persistSession();
    // A different user takes over this device: their PIN setup starts over.
    final pinnedUser = await pin.pinUsername;
    final currentUser = user?['username'] as String?;
    if (pinnedUser != null && pinnedUser != currentUser) {
      await pin.clear();
    }
    notifyListeners();
  }

  Future<void> signOut() async {
    // Revoke server-side first so a stolen refresh dies; local clear
    // happens regardless (logout must never hang on network fail).
    try {
      await api.logout(refreshToken);
    } catch (_) {}
    token = null;
    refreshToken = null;
    user = null;
    offlineMode = false;
    for (final k in [
      'cartiq_token',
      'cartiq_refresh_token',
      'cartiq_profile',
      'cartiq_last_online',
      'cartiq_catalog_json',
      'cartiq_catalog_ts',
    ]) {
      try {
        await storage.delete(key: k);
      } catch (_) {}
    }
    await pin.clear();
    notifyListeners();
  }

  String get displayName => user?['name'] as String? ?? 'Staff';
  String get roleDisplay => user?['role'] as String? ?? 'STAFF';
  String? get locationCode =>
      (user?['location'] as Map<String, dynamic>?)?['code'] as String?;
}
