import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'api_client.dart';

/// Holds the session token and profile for the whole app.
class AuthState extends ChangeNotifier {
  final ApiClient api;
  final FlutterSecureStorage storage;

  String? token;
  Map<String, dynamic>? user;

  AuthState({ApiClient? apiClient, FlutterSecureStorage? secureStorage})
      : api = apiClient ?? ApiClient(),
        storage = secureStorage ?? const FlutterSecureStorage();

  bool get isLoggedIn => token != null;

  Future<void> restoreSession() async {
    token = await storage.read(key: 'cartiq_token');
    if (token != null) {
      try {
        final data = await api.me(token!);
        user = data['user'] as Map<String, dynamic>?;
      } on ApiException {
        await signOut();
      }
    }
    notifyListeners();
  }

  Future<void> signIn(String username, String password) async {
    final data = await api.login(username, password);
    token = data['token'] as String?;
    user = data['user'] as Map<String, dynamic>?;
    if (token != null) {
      await storage.write(key: 'cartiq_token', value: token);
    }
    notifyListeners();
  }

  Future<void> signOut() async {
    token = null;
    user = null;
    await storage.delete(key: 'cartiq_token');
    notifyListeners();
  }

  String get displayName => user?['name'] as String? ?? 'Staff';
  String get roleDisplay => user?['role'] as String? ?? 'STAFF';
  String? get locationCode =>
      (user?['location'] as Map<String, dynamic>?)?['code'] as String?;
}
