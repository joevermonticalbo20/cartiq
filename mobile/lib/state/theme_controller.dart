import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Persists the user's theme preference and exposes it to MaterialApp.
class ThemeController extends ChangeNotifier {
  final FlutterSecureStorage storage;
  ThemeMode _mode = ThemeMode.system;

  ThemeController({FlutterSecureStorage? secureStorage})
      : storage = secureStorage ?? const FlutterSecureStorage();

  ThemeMode get mode => _mode;
  bool get isDark => _mode == ThemeMode.dark;

  Future<void> load() async {
    // This is awaited from main() before runApp(), so a throw here means a
    // blank white window. flutter_secure_storage reads through the Android
    // Keystore, which legitimately fails (key invalidated by a device
    // restore, a changed signing key, or a reset keystore). A missing theme
    // preference is not worth losing the app over - fall back to system.
    String? saved;
    try {
      saved = await storage.read(key: 'cartiq_theme_mode');
    } catch (_) {
      saved = null;
    }
    if (saved == 'light') {
      _mode = ThemeMode.light;
    } else if (saved == 'dark') {
      _mode = ThemeMode.dark;
    } else {
      _mode = ThemeMode.system;
    }
    notifyListeners();
  }

  Future<void> setMode(ThemeMode mode) async {
    _mode = mode;
    try {
      await storage.write(
        key: 'cartiq_theme_mode',
        value: switch (mode) {
          ThemeMode.light => 'light',
          ThemeMode.dark => 'dark',
          _ => 'system',
        },
      );
    } catch (_) {
      // Preference simply will not persist; the in-session change still holds.
    }
    notifyListeners();
  }

  Future<void> toggle() async {
    await setMode(isDark ? ThemeMode.light : ThemeMode.dark);
  }
}
