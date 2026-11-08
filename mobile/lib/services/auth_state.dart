import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'api_client.dart';
import 'kv_store.dart';
import 'offline_pin.dart';
import 'push_notification_service.dart';
import 'rfid_registration.dart';
import 'time_clock.dart';
import '../utils/manila_time.dart';

/// Holds the session token and profile for the whole app.
class AuthState extends ChangeNotifier {
  static const sessionExpiredMessage = ApiClient.sessionExpiredMessage;

  final ApiClient api;
  final KeyValueStore storage;
  final CartIQPushService push;
  late final OfflinePinService pin;

  String? token;
  String? refreshToken;
  Map<String, dynamic>? user;

  /// True when the session was unlocked offline via PIN (queue-only mode).
  bool offlineMode = false;

  /// Cold start could not verify the session online and this device holds a
  /// PIN for the cached account: the app must ask for that PIN before the
  /// POS opens. Without this gate an offline cold start went straight into
  /// the shell and the PIN was never used — the bug reported from the field.
  bool offlineUnlockRequired = false;

  AuthState({
    ApiClient? apiClient,
    KeyValueStore? secureStorage,
    CartIQPushService? pushService,
  })  : api = apiClient ?? ApiClient(),
        storage =
            secureStorage ?? const SecureStoreAdapter(FlutterSecureStorage()),
        push = pushService ?? CartIQPushService() {
    pin = OfflinePinService(storage);
    push.onNotificationOpened = (_, _) async {
      refreshMyAlerts().catchError((_) {});
    };
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
      key: 'cartiq_last_online',
      value: DateTime.now().toIso8601String(),
    );
  }

  Future<void> _restoreCachedProfile() async {
    try {
      final raw = await storage.read(key: 'cartiq_profile');
      if (raw != null && raw.isNotEmpty) {
        user = jsonDecode(raw) as Map<String, dynamic>;
      }
    } catch (_) {}
  }

  Future<void> _registerPushTokenBestEffort() async {
    final t = token;
    if (t == null || offlineMode) return;
    if ((user?['role'] as String?) != 'STAFF') return;
    await push.initializeAndRegister(
      onToken: (pushToken) => api.registerPushToken(t, pushToken),
    );
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
        offlineUnlockRequired = false;
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
              await _armOfflineUnlock();
            }
          }
        } else {
          await _restoreCachedProfile();
          await _armOfflineUnlock();
        }
      }
    }
    startTimeClockSync();
    // Pull this staff member's notifications (void decisions, restock
    // acknowledgements) without blocking the session restore.
    refreshMyAlerts().catchError((_) {});
    _registerPushTokenBestEffort().catchError((_) {});
    _startAlertPoll();
    notifyListeners();
  }

  /// Ask for the device PIN before the shell opens when this run could not
  /// verify the session online and a working PIN exists for the cached
  /// STAFF account. Only arms while the offline window is still fresh, so a
  /// stale session behaves exactly as before (never a lockout it cannot
  /// resolve without internet).
  Future<void> _armOfflineUnlock() async {
    offlineUnlockRequired = false;
    try {
      if (!await pin.hasPin) return;
      final last = await lastOnline;
      if (last == null ||
          DateTime.now().difference(last) > OfflinePinService.maxOfflineAge) {
        return;
      }
      final profile = await _readCachedProfile();
      final username =
          (user?['username'] ?? profile?['username']) as String?;
      final role = (user?['role'] ?? profile?['role']) as String?;
      final storedUser = await pin.pinUsername;
      offlineUnlockRequired =
          role == 'STAFF' && storedUser != null && storedUser == username;
    } catch (_) {
      offlineUnlockRequired = false;
    }
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
      if (recovered) {
        // A successful refresh verifies the session: no PIN gate needed.
        offlineUnlockRequired = false;
        notifyListeners();
      }
      return recovered;
    } on ApiException catch (e) {
      // Offline: keep everything as-is; the sync layer retries later.
      if (e.statusCode == null) return false;
      return false;
    }
  }

  /// Targeted alerts for the signed-in staff account (void decisions, restock
  /// updates). Refreshed on login and on app resume; the Settings screen shows
  /// them. Never throws — failures leave the list as-is.
  final List<Map<String, dynamic>> myAlerts = [];
  int get myUnreadCount => myAlerts.length;

  Timer? _alertPoll;

  Future<void> refreshMyAlerts() async {
    final t = token;
    if (t == null) {
      myAlerts.clear();
      notifyListeners();
      return;
    }
    try {
      final rows = await api.stockAlertsList(t, unreadOnly: true);
      myAlerts
        ..clear()
        ..addAll(rows.cast<Map<String, dynamic>>());
    } catch (_) {
      // Keep whatever was there; offline is expected.
    }
    notifyListeners();
  }

  void _startAlertPoll() {
    _alertPoll?.cancel();
    // 2s foreground poll: the first thing a staff member sees after a void
    // decision, with FCM in the background. Paused by pauseAlertPoll().
    _alertPoll = Timer.periodic(const Duration(seconds: 2), (_) {
      if (token == null) return;
      refreshMyAlerts().catchError((_) {});
    });
  }

  void _stopAlertPoll() {
    _alertPoll?.cancel();
    _alertPoll = null;
  }

  /// Suspend the foreground alert poll while the app is in the background to
  /// avoid waking the radio every few seconds for nothing. Resumed in
  /// [resumeAlertPoll].
  void pauseAlertPoll() => _stopAlertPoll();
  void resumeAlertPoll() {
    if (token == null) return;
    refreshMyAlerts().catchError((_) {});
    _startAlertPoll();
  }

  Future<void> markMyAlertRead(int id) async {
    final t = token;
    if (t == null) return;
    try {
      await api.markAlertRead(t, id);
      myAlerts.removeWhere((a) => a['id'] == id);
    } catch (_) {
      /* best-effort */
    }
    notifyListeners();
  }

  Future<void> markAllMyAlertsRead() async {
    final t = token;
    if (t == null) return;
    try {
      await api.markAllAlertsRead(t);
      myAlerts.clear();
    } catch (_) {
      /* best-effort */
    }
    notifyListeners();
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
    // A signed-out device keeps its cached profile (see signOut), so the
    // question is never "is a live session stored?" but "is a fresh enough
    // online verification cached, and is there a PIN for it?".
    final profile = await _readCachedProfile();
    final role = profile?['role'] as String?;
    final username = profile?['username'] as String?;
    if (username == null || username.isEmpty) {
      // Fresh install, new package name, or wiped app data: nothing to unlock
      // with yet. Online sign-in is the only cure — and it only has to happen once.
      return const PinEligibility(
        false,
        'noSession',
        'No saved login on this device yet. Sign in online once, then Continue offline works.',
      );
    }
    if (role != 'STAFF') {
      return const PinEligibility(
        false,
        'notStaff',
        'Offline login is for staff accounts. Owners need internet.',
      );
    }
    // Fresh install, new package name, or wiped app data: nothing to unlock
    // with yet. Online sign-in is the only cure — and it only has to happen once.
    // (The username check above covers this; this branch keeps the message if
    // a stored profile is ever incomplete.)
    final last = await lastOnline;
    if (last == null ||
        DateTime.now().difference(last) > OfflinePinService.maxOfflineAge) {
      return const PinEligibility(
        false,
        'expired',
        'Your offline window expired. Sign in online once to verify, then Continue offline works again.',
      );
    }
    final storedUser = await pin.pinUsername;
    if (!(await pin.hasPin) || storedUser != username) {
      return const PinEligibility(
        false,
        'noPin',
        'No offline PIN for this account on this device. Set it in Settings while online.',
      );
    }
    final until = await pin.lockedUntil();
    if (until != null && DateTime.now().isBefore(until)) {
      return PinEligibility(
        false,
        'locked',
        'Too many wrong attempts. Try again later.',
        lockedUntil: until,
      );
    }
    return const PinEligibility(true, 'ready', 'Ready');
  }

  /// Unlock a cached STAFF session offline via PIN. Sets [offlineMode] and
  /// restores the cached profile. Throws [PinException] when not eligible.
  /// Works on a signed-out device, provided a fresh enough online verification
  /// and a PIN were left behind — a log-out is a network boundary, not a
  /// guarantee that the canteen has signal.
  Future<void> unlockOffline(String pinCode) async {
    await _restoreCachedProfile();
    final role = user?['role'] as String?;
    if (user == null) {
      throw const PinException(
        'noSession',
        'No saved login on this device yet. Sign in online once, then Continue offline works.',
      );
    }
    if (role != 'STAFF') {
      throw const PinException(
        'notStaff',
        'Offline login is for staff accounts.',
      );
    }
    final last = await lastOnline;
    if (last == null ||
        DateTime.now().difference(last) > OfflinePinService.maxOfflineAge) {
      throw const PinException(
        'expired',
        'Please connect to the internet to verify your account.',
      );
    }
    final username = user?['username'] as String?;
    if (username == null || username.isEmpty) {
      throw const PinException(
        'noProfile',
        'No saved profile on this device. Sign in online first.',
      );
    }
    await pin.verifyPin(username: username, pin: pinCode);
    offlineMode = true;
    offlineUnlockRequired = false;
    notifyListeners();
  }

  Future<void> signIn(String username, String password) async {
    final data = await api.login(username, password);
    token = data['token'] as String?;
    refreshToken = data['refreshToken'] as String?;
    user = data['user'] as Map<String, dynamic>?;
    offlineMode = false;
    offlineUnlockRequired = false;
    await _persistSession();
    // A different user takes over this device: their PIN setup starts over.
    final pinnedUser = await pin.pinUsername;
    refreshMyAlerts().catchError((_) {});
    _registerPushTokenBestEffort().catchError((_) {});
    _startAlertPoll();
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
    final activeToken = token;
    if (activeToken != null) {
      try {
        final pushToken = await push.currentRegisteredToken();
        await push.unregister(
          removeFromApi: () async {
            if (pushToken != null && pushToken.isNotEmpty) {
              await api.unregisterPushToken(activeToken, pushToken);
            }
          },
        );
      } catch (_) {}
    }
    token = null;
    refreshToken = null;
    user = null;
    offlineMode = false;
    offlineUnlockRequired = false;
    _stopTimeClockSync();
    _stopAlertPoll();
    // Signing out revokes the refresh token server-side and clears the two
    // tokens here — but the cached profile, catalog snapshot and last-verified
    // stamp stay so a staff member can still reach the queue-only POS offline
    // on a PIN unlock (shared cart phones rely on this when the canteen has no
    // signal). Nothing sensitive is kept: no token, no refresh token, and the
    // PIN verifier lives separately. Sales recorded in offline mode queue and
    // sync after the next online sign-in.
    for (final k in [
      'cartiq_token',
      'cartiq_refresh_token',
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

  /// Stored recovery email, or null when the profile still has a placeholder.
  String? get email {
    final value = (user?['email'] as String?)?.trim();
    return (value == null || value.isEmpty) ? null : value;
  }

  bool get hasRealEmail =>
      email != null && !email!.toLowerCase().endsWith('@cartiq.local');

  /// Visible placeholder for a profile that has not set a real inbox yet.
  String get displayEmail =>
      hasRealEmail ? email! : '${user?['username'] ?? 'staff'}@cartiq.local';

  /// Update the recovery email. The current password plus a 6-digit code sent
  /// to the new inbox are both required; the caller surfaces the ApiException
  /// text when it fails.
  Future<void> sendEmailCode(String email) async {
    final activeToken = token;
    if (activeToken == null) {
      throw const ApiException('Sign in again to update your email.');
    }
    await api.sendEmailVerificationCode(activeToken, email: email);
  }

  Future<void> updateEmail({
    required String email,
    required String currentPassword,
    required String code,
  }) async {
    final activeToken = token;
    if (activeToken == null) {
      throw const ApiException('Sign in again to update your email.');
    }
    final data = await api.updateProfile(
      activeToken,
      email: email,
      currentPassword: currentPassword,
      code: code,
    );
    final updated = data['user'];
    if (updated is Map<String, dynamic>) user = updated;
    await _persistSession();
    notifyListeners();
  }

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

  /// Fold a just-registered card into [user] so the rest of the app sees it
  /// without a re-login. Called by the claim dialog when the server reports
  /// the tap bound; persisted so a cold start keeps the card.
  Future<void> applyRfidBound(String rfidUid) async {
    user = {...?user, 'rfidUid': rfidUid};
    // Persisted so a cold start after this keeps the card.
    try {
      await storage.write(key: 'cartiq_profile', value: jsonEncode(user));
    } catch (_) {}
    notifyListeners();
  }

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
  /// Settings share one instance and one base URL. The refresh callback lets a
  /// mid-claim token expiry be recovered instead of killing the registration.
  RfidRegistrationService get rfidRegistration => RfidRegistrationService(
        apiClient: api,
        refreshToken: () async {
          final ok = await refreshSession();
          return ok ? token : null;
        },
      );

  // -----------------------------------------------------------------------
  // Time clock windows
  //
  // The owner configures cart-wide open/close times for Time in / Time out in
  // the web dashboard. The POS greys the buttons out while they are closed and
  // the server refuses IN/OUT claims and taps outside the windows as well.
  // -----------------------------------------------------------------------

  /// Owner-configured windows, persisted so a cold start (even offline)
  /// respects the last known state instead of defaulting to always-open.
  /// Null until the first fetch: until then clocking behaves as before.
  TimeClockConfig? timeClock;

  /// Test seam: when set, clock gates are evaluated against this instead of
  /// the wall clock (keeps widget tests deterministic at every time of day).
  @visibleForTesting
  DateTime Function()? clockNow;

  Timer? _timeClockTimer;
  DateTime? _timeClockFetchedAt;
  bool _inOpenCache = true;
  bool _outOpenCache = true;
  static const _timeClockCacheKey = 'cartiq_timeclock';

  DateTime _clockNow() => clockNow?.call() ?? DateTime.now();

  bool get clockInOpen =>
      (timeClock ?? TimeClockConfig.defaults).isOpenNow('IN', _clockNow());
  bool get clockOutOpen =>
      (timeClock ?? TimeClockConfig.defaults).isOpenNow('OUT', _clockNow());

  /// True when today is one of the configured selling days (unrestricted when
  /// the feature is unconfigured).
  bool get timeClockDayOpen =>
      (timeClock ?? TimeClockConfig.defaults).isDayOpen(_clockNow());

  /// "Time in opens 7:00 AM (closes 9:00 AM)" — greys-out caption for the row.
  /// On a closed day (no selling day in the config) every window is off, so
  /// the caption says so instead of naming a window. Always 12-hour.
  String clockHint(String event) {
    final cfg = timeClock ?? TimeClockConfig.defaults;
    if (!cfg.isDayOpen(_clockNow())) return 'Closed today - no selling day.';
    String fmt(String hhmm) {
      final m = RegExp(r'^(\d{1,2}):(\d{2})$').firstMatch(hhmm);
      if (m == null) return hhmm;
      final h = int.parse(m.group(1)!);
      final minute = m.group(2)!;
      final period = h < 12 ? 'AM' : 'PM';
      final h12 = h % 12 == 0 ? 12 : h % 12;
      return '$h12:$minute $period';
    }

    return event == 'OUT'
        ? 'Time out opens ${fmt(cfg.outOpen)} (closes ${fmt(cfg.outClose)})'
        : 'Time in opens ${fmt(cfg.inOpen)} (closes ${fmt(cfg.inClose)})';
  }

  /// The single caption shown under the row when anything is locked.
  String timeClockCaption() {
    final cfg = timeClock ?? TimeClockConfig.defaults;
    if (!cfg.isDayOpen(_clockNow())) return 'Closed today - no selling day.';
    final parts = <String>[];
    if (!clockInOpen && !myInDone) parts.add(clockHint('IN'));
    if (!clockOutOpen && !myOutDone) parts.add(clockHint('OUT'));
    return parts.join('  ·  ');
  }

  /// Persisted copy so a cold start (even offline) respects the last known
  /// windows instead of defaulting to always-open. Best-effort.
  Future<void> _restoreTimeClockCache() async {
    try {
      final raw = await storage.read(key: _timeClockCacheKey);
      if (raw == null || raw.isEmpty) return;
      timeClock = TimeClockConfig.fromJson(
        jsonDecode(raw) as Map<String, dynamic>,
      );
    } catch (_) {}
  }

  /// Pull the windows from the server. Silent on failure — the UI keeps the
  /// last known state. Never throws.
  Future<void> refreshTimeClock() async {
    if (token == null || offlineMode) return;
    try {
      final raw = await api.getTimeClock(token!);
      if (raw.isEmpty) return;
      final cfg = TimeClockConfig.fromJson(raw);
      final changed = !cfg.sameAs(timeClock);
      timeClock = cfg;
      try {
        await storage.write(key: _timeClockCacheKey, value: jsonEncode(cfg.toJson()));
      } catch (_) {}
      if (changed) notifyListeners();
    } catch (_) {
      // Offline / server unreachable: keep the cache — never flip staff into
      // a locked-out state because of a network hiccup.
    }
  }

  /// Start the background sync. Idempotent. Re-checks the clock boundary every
  /// 30s (so the buttons open on time without a manual refresh) and polls the
  /// server every 5 minutes (so an owner's edit propagates by itself — that is
  /// the "auto reload" half of the feature).
  void startTimeClockSync() {
    if (_timeClockTimer != null) return;
    unawaited(_restoreTimeClockCache().then((_) {
      _inOpenCache = clockInOpen;
      _outOpenCache = clockOutOpen;
      notifyListeners();
    }));
    if (token == null) return; // No session to sync.
    _timeClockFetchedAt = DateTime.now();
    _inOpenCache = clockInOpen;
    _outOpenCache = clockOutOpen;
    unawaited(_tickTimeClock());
    _timeClockTimer = Timer.periodic(
      const Duration(seconds: 30),
      (_) => unawaited(_tickTimeClock()),
    );
  }

  Future<void> _tickTimeClock() async {
    var inNow = clockInOpen;
    var outNow = clockOutOpen;
    if (inNow != _inOpenCache || outNow != _outOpenCache) {
      _inOpenCache = inNow;
      _outOpenCache = outNow;
      notifyListeners();
    }
    final fetched = _timeClockFetchedAt;
    if (fetched == null ||
        DateTime.now().difference(fetched) > const Duration(minutes: 5)) {
      _timeClockFetchedAt = DateTime.now();
      await refreshTimeClock(); // notifies by itself when the config changed
      inNow = clockInOpen;
      outNow = clockOutOpen;
      if (inNow != _inOpenCache || outNow != _outOpenCache) {
        _inOpenCache = inNow;
        _outOpenCache = outNow;
        notifyListeners();
      }
    }
    // Piggyback the attendance refresh onto the same 5-minute window.
    final shiftsFetched = _myShiftsFetchedAt;
    if (shiftsFetched == null ||
        DateTime.now().difference(shiftsFetched) > const Duration(minutes: 5)) {
      await refreshMyShifts();
    }
  }

  void _stopTimeClockSync() {
    _timeClockTimer?.cancel();
    _timeClockTimer = null;
    timeClock = null;
    _timeClockFetchedAt = null;
    _inOpenCache = true;
    _outOpenCache = true;
    _myShiftsToday = const [];
    _myShiftsFetchedAt = null;
  }

  // -----------------------------------------------------------------------
  // Attendance: today's own shifts (server: /shifts/history for the cart).
  //
  // A staff member who already timed in must not tap Time in again, and the
  // times they tapped are shown on the row. /shifts/history is fetched with
  // the cart and today's Manila date and filtered to this account by
  // staffId — no new endpoint needed.
  // -----------------------------------------------------------------------

  List<Map<String, dynamic>> _myShiftsToday = const [];
  DateTime? _myShiftsFetchedAt;

  /// Today's shifts for the signed-in user, Manila wall-clock, oldest first.
  List<Map<String, dynamic>> get myShiftsToday => _myShiftsToday;

  /// Latest event of [event] ("IN"/"OUT") today for the signed-in user,
  /// Manila wall-clock. Null when none exists (not yet tapped).
  DateTime? latestShiftToday(String event) {
    final ev = event.toUpperCase();
    DateTime? latest;
    for (final s in _myShiftsToday) {
      if ((s['event'] ?? '').toString().toUpperCase() != ev) continue;
      final ts = ManilaTime.parse(s['ts']);
      if (ts == null) continue;
      if (latest == null || ts.isAfter(latest)) latest = ts;
    }
    return latest;
  }

  bool get myInDone => latestShiftToday('IN') != null;
  bool get myOutDone => latestShiftToday('OUT') != null;
  DateTime? get myInAtToday => latestShiftToday('IN');
  DateTime? get myOutAtToday => latestShiftToday('OUT');

  int? _asInt(dynamic v) => v is int ? v : int.tryParse('$v');

  /// Pull today's shifts for this cart and keep the signed-in user's.
  /// Silent on failure — the UI keeps the last known state.
  Future<void> refreshMyShifts() async {
    if (token == null || offlineMode) return;
    final code = locationCode;
    if (code == null) return;
    try {
      final m = DateTime.now().toUtc().add(const Duration(hours: 8));
      final date =
          '${m.year.toString().padLeft(4, '0')}-${m.month.toString().padLeft(2, '0')}-${m.day.toString().padLeft(2, '0')}';
      final res = await api.shiftsHistory(
        token!,
        code: code,
        date: date,
        pageSize: 100,
      );
      final me = _asInt(user?['id']);
      final rows = ((res['data'] as List?) ?? const [])
          .whereType<Map<String, dynamic>>()
          .where((s) => _asInt(s['staffId']) != null && _asInt(s['staffId']) == me)
          .toList()
        ..sort((a, b) {
          final x = ManilaTime.parse(a['ts']);
          final y = ManilaTime.parse(b['ts']);
          return (x ?? DateTime(0)).compareTo(y ?? DateTime(0));
        });
      _myShiftsToday = rows;
      _myShiftsFetchedAt = DateTime.now();
      notifyListeners();
    } catch (_) {
      // Keep the last known state — never wedge the buttons on a flaky fetch.
    }
  }

  /// Run one registration attempt and fold a success back into [user], so the
  /// rest of the app immediately sees the card without a re-login.
  Future<RfidClaimResult> registerRfid({String? locationCode}) async {
    final result = await rfidRegistration.register(
      token: token ?? '',
      locationCode: locationCode ?? this.locationCode,
    );
    if (result is RfidBound) {
      await applyRfidBound(result.rfidUid);
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
