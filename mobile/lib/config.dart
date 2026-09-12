import 'services/discovery_service.dart';

class AppConfig {
  // SHARED PRODUCTION API endpoint (same database as the web dashboard).
  //
  // The default below points at the hosted Render backend, which talks to the
  // same prod Firestore as https://cartiq-8e46f.web.app — so the app and the
  // web share one database with no per-phone configuration.
  //
  // Local/LAN development still works two ways (no rebuild needed):
  //   - In-app: boot splash or Login → Server row → type the LAN URL
  //     (e.g. http://192.168.1.5:4000/api). A manual URL is persisted and
  //     wins over discovery on every launch until you Rescan.
  //   - Build-time: flutter run --dart-define=API_BASE_URL=http://<PC_LAN_IP>:4000/api
  //
  // Other --dart-define targets:
  //   Android emulator (host API):  --dart-define=API_BASE_URL=http://10.0.2.2:4000/api
  static const String apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'https://cartiq-api-aswt.onrender.com/api',
  );

  static final DiscoveryService _discovery = DiscoveryService();

  /// Resolve the API URL via auto-discovery (subnet scan) before falling back
  /// to the configured value. This enables network-agnostic operation – the app
  /// will automatically find the API server on any WiFi subnet.
  static Future<String> resolveApiUrl() async {
    return await _discovery.discoverApiUrl(apiBaseUrl);
  }
}
