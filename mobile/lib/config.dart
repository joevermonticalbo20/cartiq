class AppConfig {
  // LOCAL-ONLY API endpoint.
  //
  // The default below (127.0.0.1) works for Windows desktop and iOS simulator.
  // For other targets, override at build/run time with --dart-define:
  //
  //   Android emulator:   flutter run --dart-define=API_BASE_URL=http://10.0.2.2:4000/api
  //   Physical phone:     flutter run --dart-define=API_BASE_URL=http://<PC_LAN_IP>:4000/api
  //                       (find your PC's LAN IP with `ipconfig`; e.g. 192.168.1.16)
  //   Android APK build:  flutter build apk --dart-define=API_BASE_URL=http://<PC_LAN_IP>:4000/api
  static const String apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://127.0.0.1:4000/api',
  );
}
