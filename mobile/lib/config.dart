import 'services/discovery_service.dart';

class AppConfig {
  // LOCAL-ONLY API endpoint.
  //
  // The default below uses mDNS (.local) so the app works on any network without
  // rebuilding when the PC's IP changes:
  //   - On the same LAN, cartiq-api.local resolves to the API server's IP
  //   - The server advertises itself via Bonjour/mDNS (bonjour npm package)
  //
  // For other targets, override at build/run time with --dart-define:
  //
  //   Android emulator:   flutter run --dart-define=API_BASE_URL=http://10.0.2.2:4000/api
  //   Physical phone:     flutter run --dart-define=API_BASE_URL=http://<PC_LAN_IP>:4000/api
  //   Android APK build:  flutter build apk --dart-define=API_BASE_URL=http://<PC_LAN_IP>:4000/api
  //
  // To find your PC's LAN IP: ipconfig (Windows) or ifconfig (macOS/Linux)
  static const String apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://cartiq-api.local:4000/api',
  );

  static final DiscoveryService _discovery = DiscoveryService();

  /// Resolve the API URL via auto-discovery (subnet scan) before falling back
  /// to the configured value. This enables network-agnostic operation – the app
  /// will automatically find the API server on any WiFi subnet.
  static Future<String> resolveApiUrl() async {
    return await _discovery.discoverApiUrl(apiBaseUrl);
  }
}
