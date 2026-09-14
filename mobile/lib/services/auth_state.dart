import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'api_client.dart';

/// Holds the session token and profile for the whole app.
class AuthState extends ChangeNotifier {
  final ApiClient api;
  final FlutterSecureStorage storage;

  String? token;
  String? refreshToken;
  Map<String, dynamic>? user;

  AuthState({ApiClient? apiClient, FlutterSecureStorage? secureStorage})
      : api = apiClient ?? ApiClient(),
        storage = secureStorage ?? const FlutterSecureStorage();

  bool get isLoggedIn => token != null;

  Future<void> restoreSession() async {
    token = await storage.read(key: 'cartiq_token');
    refreshToken = await storage.read(key: 'cartiq_refresh_token');
    if (token != null) {
      try {
        final data = await api.me(token!);
        user = data['user'] as Map<String, dynamic>?;
      } on ApiException catch (e) {
        // Only drop on explicit server rejection (401/403) — NOT on
        // network failures (offline cold-start) to preserve session.
        if (e.statusCode == 401 || e.statusCode == 403) {
          // An expired access token with a valid refresh token can be
          // recovered silently; only sign out when refresh also fails.
          final recovered = await _tryRefresh();
          if (!recovered) await signOut();
        }
      }
    }
    notifyListeners();
  }

  /// Attempt to obtain a fresh access token from the stored refresh token.
  /// Returns true and persists new tokens on success.
  Future<bool> _tryRefresh() async {
    final rt = refreshToken;
    if (rt == null) return false;
    try {
      final data = await api.refresh(rt);
      token = data['token'] as String?;
      refreshToken = data['refreshToken'] as String?;
      user = data['user'] as Map<String, dynamic>?;
      if (token != null) {
        await storage.write(key: 'cartiq_token', value: token);
      }
      if (refreshToken != null) {
        await storage.write(key: 'cartiq_refresh_token', value: refreshToken!);
      }
      return true;
    } on ApiException {
      return false;
    }
  }

  /// Refresh the access token mid-session (e.g. when a sync hits 401).
  /// Returns true when a fresh token was stored.
  Future<bool> refreshSession() async {
    final recovered = await _tryRefresh();
    if (recovered) notifyListeners();
    return recovered;
  }

  Future<void> signIn(String username, String password) async {
    final data = await api.login(username, password);
    token = data['token'] as String?;
    refreshToken = data['refreshToken'] as String?;
    user = data['user'] as Map<String, dynamic>?;
    if (token != null) {
      await storage.write(key: 'cartiq_token', value: token);
    }
    if (refreshToken != null) {
      await storage.write(key: 'cartiq_refresh_token', value: refreshToken!);
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
    await storage.delete(key: 'cartiq_token');
    await storage.delete(key: 'cartiq_refresh_token');
    notifyListeners();
  }

  String get displayName => user?['name'] as String? ?? 'Staff';
  String get roleDisplay => user?['role'] as String? ?? 'STAFF';
  String? get locationCode =>
      (user?['location'] as Map<String, dynamic>?)?['code'] as String?;
}
