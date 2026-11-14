// Firebase App Check for the POS app.
//
// App Check proves that API calls come from the real app (Play Integrity on
// Android in release builds, the debug provider in development). The server
// verifies the token it sees in the X-Firebase-AppCheck header - but only
// once the owner sets APP_CHECK_ENFORCE=true, so an update to the app never
// locks anyone out while the setting is being turned on.
//
// Everything here is best-effort: a phone without Play Services (or an older
// OS) still gets a working POS, just without the App Check header.
import 'dart:async';

import 'package:firebase_app_check/firebase_app_check.dart';
import 'package:flutter/foundation.dart';

class AppCheckService {
  AppCheckService._();

  static String? cachedToken;
  static bool _refreshing = false;
  static Timer? _refreshTimer;

  /// Activate App Check and keep [cachedToken] fresh. Never throws.
  ///
  /// Android uses Play Integrity in release builds; development builds use
  /// the debug provider (the debug token is registered in the console).
  static Future<void> startBestEffort() async {
    try {
      await FirebaseAppCheck.instance.activate(
        providerAndroid:
            kReleaseMode
                ? const AndroidPlayIntegrityProvider()
                : const AndroidDebugProvider(),
        providerApple: const AppleAppAttestWithDeviceCheckFallbackProvider(),
      );
      await refresh();
      _refreshTimer?.cancel();
      // App Check tokens live for months, but the token TTL also depends on
      // the provider; re-mint every five minutes so the cached one is always
      // fresh enough for a server-side check.
      _refreshTimer = Timer.periodic(
        const Duration(minutes: 5),
        (_) => unawaited(refresh()),
      );
    } catch (_) {
      cachedToken = null;
    }
  }

  /// The token to send with API requests, if one exists.
  static String? get headerValue => cachedToken;

  /// Re-mint the cached token. Never throws.
  static Future<void> refresh() async {
    if (_refreshing) return;
    _refreshing = true;
    try {
      cachedToken = await FirebaseAppCheck.instance.getToken(false);
    } catch (_) {
      // Attestation unavailable (no Play Services, offline, simulator):
      // leave the cache as it is so a previous token can still ride along.
    } finally {
      _refreshing = false;
    }
  }

  /// Ask the server to drop the cached token and mint a new one on the next
  /// call, after the server turned a request down.
  static Future<void> refreshAfterRejection() async {
    cachedToken = null;
    await refresh();
  }
}
