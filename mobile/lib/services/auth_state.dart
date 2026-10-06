import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'api_client.dart';
import 'kv_store.dart';
import 'offline_pin.dart';
import 'rfid_registration.dart';

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
    // flutter_secure_storage reads through the Android Keystore, which can
    // legitimately fail (device restore, changed signing key, reset
    // keystore). An unreadable cache must mean "no saved session", never a
    // crash on startup.
    try {
      token = await storage.read(key: 'cartiq_token');
      refreshToken = await storage.read(key: 'cartiq_refresh_token');
    } catch (_) {
      token = null;
      refreshToken = null;
    }
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

  Future<Map<String, dynamic>?> _readCachedProfile() async {
    try {
      final raw = await storage.read(key: 'cartiq_profile');
      if (raw == null || raw.isEmpty) return null;
      return jsonDecode(raw) as Map<String, dynamic>;
    } catch (_) {
      return null;
    }
  }

  /// Precheck used to gate the Continue offline button BEFORE any PIN pad
  /// is shown. Never throws — returns the specific reason when ineligible.
  Future<PinEligibility> checkOfflineEligibility() async {
    if (token == null || refreshToken == null) {
      return const PinEligibility(false, 'noSession',
          'No saved session on this device. Sign in online first.');
    }
    final profile = await _readCachedProfile();
    final role = profile?['role'] as String?;
    if (role != 'STAFF') {
      return const PinEligibility(false, 'notStaff',
          'Offline login is for staff accounts. Owners need internet.');
    }
    final last = await lastOnline;
    if (last == null ||
        DateTime.now().difference(last) > OfflinePinService.maxOfflineAge) {
      return const PinEligibility(false, 'expired',
          'Session needs online verification. Please connect to the internet.');
    }
    final username = profile?['username'] as String?;
    if (username == null || username.isEmpty) {
      return const PinEligibility(false, 'noProfile',
          'No saved profile on this device. Sign in online first.');
    }
    final storedUser = await pin.pinUsername;
    if (!(await pin.hasPin) || storedUser != username) {
      return const PinEligibility(false, 'noPin',
          'No offline PIN for this account on this device. Set it in Settings while online.');
    }
    final until = await pin.lockedUntil();
    if (until != null && DateTime.now().isBefore(until)) {
      return PinEligibility(false, 'locked',
          'Too many wrong attempts. Try again later.',
          lockedUntil: until);
    }
    return const PinEligibility(true, 'ready', 'Ready');
  }

  /// Unlock a cached STAFF session offline via PIN. Sets [offlineMode] and
  /// restores the cached profile. Throws [PinException] when not eligible.
  Future<void> unlockOffline(String pinCode) async {
    if (token == null || refreshToken == null) {
      throw const PinException('noSession',
          'No saved session on this device. Sign in online first.');
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
      throw const PinException('noProfile',
          'No saved profile on this device. Sign in online first.');
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
    // Only a GENUINE user switch re-arms the one-time prompt. This used to be
    // `pinnedUser != currentUser`, which is also true when pinnedUser is null -
    // i.e. every login by someone who skipped or has no PIN. That deleted the
    // "already asked" flag on every single login, so the app asked for a new
    // PIN forever. No PIN at all is first-run, which the flag already covers.
    final tookOverDevice = pinnedUser != null && pinnedUser != currentUser;
    if (tookOverDevice) {
      await pin.clear();
      try {
        await storage.delete(key: 'cartiq_pin_prompted');
      } catch (_) {}
    }

    // The RFID prompt is about whether THIS person has a card, so it re-arms
    // when a different user takes the device over - otherwise whoever skipped
    // it silently silenced the prompt for the next person to sign in.
    //
    // Tracked separately from the PIN on purpose. The PIN check above cannot be
    // reused: `pinnedUser != currentUser` is also true when pinnedUser is null,
    // and reusing it deleted the flag on every login (see the comment above).
    // `cartiq_last_user` is written on every login and survives sign-out, so
    // `lastUser != null` really does mean "a previous user existed".
    try {
      final lastUser = await storage.read(key: 'cartiq_last_user');
      if (lastUser != null && lastUser != currentUser) {
        await storage.delete(key: 'cartiq_rfid_prompted');
      }
      await storage.write(key: 'cartiq_last_user', value: currentUser);
    } catch (_) {}
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
      // NOTE: cartiq_pin_prompted is deliberately NOT here. It records that
      // this device already offered PIN setup - device state, not session
      // state. Deleting it on sign-out re-armed the prompt on the next login,
      // which is the nag reported from the field. A genuine user switch still
      // resets it, in signIn().
      try {
        await storage.delete(key: k);
      } catch (_) {}
    }
    // PIN state is deliberately KEPT. It is bound to the device and the
    // account, not to the session: wiping it here meant a staff member who
    // signed out and back in had to invent a new PIN every time. A genuine
    // takeover by a different user is handled in signIn(), which compares
    // pinUsername against the new account and clears it there. A leftover PIN
    // is inert anyway - unlockOffline requires a cached token + profile, and
    // signOut just removed both.
    notifyListeners();
  }

  String get displayName => user?['name'] as String? ?? 'Staff';
  String get roleDisplay => user?['role'] as String? ?? 'STAFF';
  String? get locationCode =>
      (user?['location'] as Map<String, dynamic>?)?['code'] as String?;

  /// One-time post-login nudge: STAFF, online session, no PIN yet, never
  /// prompted on this device. The UI calls [markPinPromptShown] when it
  /// shows the sheet so a skip never nags again (Settings stays available).
  Future<bool> needsPinSetupPrompt() async {
    if (!isLoggedIn || offlineMode) return false;
    if ((user?['role'] as String?) != 'STAFF') return false;
    if (await pin.hasPin) return false;
    try {
      if (await storage.read(key: 'cartiq_pin_prompted') == '1') {
        return false;
      }
    } catch (_) {}
    return true;
  }

  Future<void> markPinPromptShown() async {
    try {
      await storage.write(key: 'cartiq_pin_prompted', value: '1');
    } catch (_) {}
  }

  // -----------------------------------------------------------------------
  // RFID card registration
  //
  // Staff clock in and out by tapping a card on the cart's reader, so the
  // account has to be tied to that tag. Registration needs the server (only a
  // real tap can complete it), so every path here bails out when offline rather
  // than pretending a card was saved.
  // -----------------------------------------------------------------------

  /// The card bound to this account, or null. Normalized uppercase hex by the
  /// server, safe to show directly.
  String? get rfidUid => user?['rfidUid'] as String?;

  bool get hasRfidCard => (rfidUid ?? '').isNotEmpty;

  /// Post-login nudge for a user with no card. Mirrors [needsPinSetupPrompt]:
  /// online session only, once per device, and Settings stays available for
  /// anyone who skips it.
  ///
  /// STAFF only. An owner is not assigned to a cart and has to pick one, which
  /// is a deliberate choice, not a one-tap prompt - they use Settings.
  Future<bool> needsRfidPrompt() async {
    if (!isLoggedIn || offlineMode) return false;
    if ((user?['role'] as String?) != 'STAFF') return false;
    if (hasRfidCard) return false;
    // No cart means no reader to tap; prompting would be a dead end.
    if (locationCode == null) return false;
    try {
      if (await storage.read(key: 'cartiq_rfid_prompted') == '1') {
        return false;
      }
    } catch (_) {}
    return true;
  }

  Future<void> markRfidPromptShown() async {
    try {
      await storage.write(key: 'cartiq_rfid_prompted', value: '1');
    } catch (_) {}
  }

  /// Registration service bound to this session's API client, so the dialog and
  /// Settings share one instance and one base URL.
  RfidRegistrationService get rfidRegistration =>
      RfidRegistrationService(apiClient: api);

  /// Run one registration attempt and fold a success back into [user], so the
  /// rest of the app immediately sees the card without a re-login.
  Future<RfidClaimResult> registerRfid({String? locationCode}) async {
    final result = await rfidRegistration.register(
      token: token ?? '',
      locationCode: locationCode ?? this.locationCode,
    );
    if (result is RfidBound) {
      user = {...?user, 'rfidUid': result.rfidUid};
      // Persisted so a cold start after this keeps the card.
      try {
        await storage.write(key: 'cartiq_profile', value: jsonEncode(user));
      } catch (_) {}
      notifyListeners();
    }
    return result;
  }

  /// Drop this account's card. Offline is refused by the caller: an unbound
  /// card that silently failed to save would lock staff out of their shift.
  Future<RfidClaimResult> unbindRfid() async {
    try {
      await api.unbindRfid(token ?? '');
      user = {...?user, 'rfidUid': null};
      try {
        await storage.write(key: 'cartiq_profile', value: jsonEncode(user));
      } catch (_) {}
      notifyListeners();
      return const RfidUnbound();
    } on ApiException catch (e) {
      return RfidFailed(e.message);
    }
  }
}
