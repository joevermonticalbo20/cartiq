import 'services/discovery_service.dart';

class AppConfig {
  // SHARED PRODUCTION API endpoint (same database as the web dashboard).
  //
  // The default below points at the Supabase Edge Function, which serves the
  // same CartIQ API (native auth + proxy for the remaining routes) on top of
  // the same prod Firestore as https://cartiq-8e46f.web.app — reachable even
  // on networks that block *.onrender.com (e.g. PLDT).
  // Legacy Render backend (keep alive until the native port is complete):
  //   https://cartiq-api-aswt.onrender.com/api
  //
  // Local/LAN development still works two ways (no rebuild needed):
  //   - In-app: boot splash or Login → Server row → type the LAN URL
  //     (e.g. http://192.168.1.5:4000/api). A manual URL is persisted and
  //     wins over discovery on every launch until you Rescan.
  //   - Build-time: flutter run --dart-define=API_BASE_URL=http://<PC_LAN_IP>:4000/api
  //
  // LAN auto-discovery (subnet scan) is OFF by default so the app can never
  // silently attach to a localhost/LAN dev server instead of the shared
  // production database. Flip to true only for offline LAN pilots.
  static const bool enableLanDiscovery = false;
  // Other --dart-define targets:
  //   Android emulator (host API):  --dart-define=API_BASE_URL=http://10.0.2.2:4000/api
  static const String apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'https://ezynbxzarxozzmwqdjxs.supabase.co/functions/v1/api',
  );

  static final DiscoveryService _discovery = DiscoveryService();

  /// Resolve the API URL. With LAN discovery off (default) this returns the
  /// configured shared-production URL immediately — no subnet scan, so the
  /// app can never land on a localhost/LAN dev server by accident.
  /// A manually pinned Server URL (secure storage) still wins over this.
  static Future<String> resolveApiUrl() async {
    if (!enableLanDiscovery) return apiBaseUrl;
    return await _discovery.discoverApiUrl(apiBaseUrl);
  }
}
