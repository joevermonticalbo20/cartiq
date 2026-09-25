import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';

import 'kv_store.dart';

/// Offline PIN gate for staff devices without internet.
///
/// Design (threat model: shared food-cart phones, supervised operation):
/// - The PIN unlocks the *cached* session only; it never creates authority.
///   A fresh device still needs one online login first.
/// - The verifier is an iterated HMAC-SHA256 (salt + 20k rounds) stored in
///   hardware-backed secure storage — the storage itself (Keystore/Keychain)
///   is the real boundary; the hash + app lockout are second layers.
/// - The PIN is bound to one username: any new online login by a different
///   user wipes PIN state and forces re-setup.
/// - Offline unlock is time-boxed (default 7 days since last online auth)
///   so disabled accounts stop working even without connectivity.
class PinException implements Exception {
  /// noSession | noProfile | noPin | notStaff | expired | locked | wrong | invalid
  final String code;
  final String message;
  final DateTime? lockedUntil;

  const PinException(this.code, this.message, {this.lockedUntil});

  @override
  String toString() => message;
}

/// Result of the offline-eligibility precheck (used to gate the Continue
/// offline button before any PIN pad is shown).
class PinEligibility {
  /// ready | noSession | noProfile | noPin | notStaff | expired | locked
  final bool eligible;
  final String code;
  final String message;
  final DateTime? lockedUntil;

  const PinEligibility(this.eligible, this.code, this.message,
      {this.lockedUntil});
}

class OfflinePinService {
  OfflinePinService(this._store);

  final KeyValueStore _store;

  static const maxOfflineAge = Duration(days: 7);
  static const hashRounds = 20000;
  static const maxAttempts = 5;

  /// Escalating lockouts after every 5 consecutive failures.
  static const lockoutSteps = [
    Duration(minutes: 1),
    Duration(minutes: 5),
    Duration(minutes: 15),
  ];

  static const _kHash = 'cartiq_pin_hash';
  static const _kSalt = 'cartiq_pin_salt';
  static const _kUser = 'cartiq_pin_user';
  static const _kAttempts = 'cartiq_pin_attempts';
  static const _kLockoutUntil = 'cartiq_pin_lockout_until';
  static const _kLockLevel = 'cartiq_pin_lock_level';

  static bool validFormat(String pin) =>
      pin.length == 6 && int.tryParse(pin) != null;

  Future<bool> get hasPin async =>
      (await _store.read(key: _kHash)) != null &&
      (await _store.read(key: _kSalt)) != null;

  Future<String?> get pinUsername async =>
      _store.read(key: _kUser);

  /// Set up (or re-set up) the PIN for [username], wiping any previous state.
  /// Caller must ensure an online session (setup happens right after login).
  Future<void> setupPin({
    required String username,
    required String pin,
  }) async {
    if (!validFormat(pin)) {
      throw const PinException('invalid', 'PIN must be 6 digits.');
    }
    final salt = _randomSalt();
    final hash = _hash(pin, salt);
    await _store.write(key: _kHash, value: hash);
    await _store.write(key: _kSalt, value: salt);
    await _store.write(key: _kUser, value: username);
    await _store.write(key: _kAttempts, value: '0');
    await _store.write(key: _kLockLevel, value: '0');
    await _store.delete(key: _kLockoutUntil);
  }

  /// Change the PIN. Works offline — the old PIN proves ownership and only
  /// local verifier state changes.
  Future<void> changePin({
    required String username,
    required String oldPin,
    required String newPin,
  }) async {
    await verifyPin(username: username, pin: oldPin);
    await setupPin(username: username, pin: newPin);
  }

  /// Verify [pin] for [username]. Throws [PinException] on any failure
  /// (locked / wrong / no PIN / username mismatch). Resets attempts on success.
  Future<void> verifyPin({
    required String username,
    required String pin,
  }) async {
    final lockedUntil = await _lockedUntil();
    if (lockedUntil != null && DateTime.now().isBefore(lockedUntil)) {
      throw PinException(
        'locked',
        'Too many wrong attempts. Try again later.',
        lockedUntil: lockedUntil,
      );
    }
    final storedUser = await pinUsername;
    final storedHash = await _store.read(key: _kHash);
    final salt = await _store.read(key: _kSalt);
    if (storedHash == null || salt == null || storedUser != username) {
      throw const PinException(
        'noPin',
        'No offline PIN for this account on this device.',
      );
    }
    if (_hash(pin, salt) != storedHash) {
      await _recordFailure();
      final until = await _lockedUntil();
      if (until != null && DateTime.now().isBefore(until)) {
        throw PinException(
          'locked',
          'Too many wrong attempts. Try again later.',
          lockedUntil: until,
        );
      }
      final left = maxAttempts - (await _attempts());
      throw PinException('wrong', '$left attempt(s) left before lockout.');
    }
    await _store.write(key: _kAttempts, value: '0');
    await _store.delete(key: _kLockoutUntil);
  }

  /// Wipe all PIN state (sign-out, user switch).
  Future<void> clear() async {
    for (final k in [_kHash, _kSalt, _kUser, _kAttempts, _kLockoutUntil, _kLockLevel]) {
      try {
        await _store.delete(key: k);
      } catch (_) {}
    }
  }

  String _hash(String pin, String saltB64) {
    List<int> block = utf8.encode(pin);
    final salt = base64Decode(saltB64);
    for (var i = 0; i < hashRounds; i++) {
      block = Hmac(sha256, salt).convert([...block, ...utf8.encode('$i')]).bytes;
    }
    return base64Encode(block);
  }

  String _randomSalt() {
    final rnd = Random.secure();
    return base64Encode(List<int>.generate(16, (_) => rnd.nextInt(256)));
  }

  Future<int> _attempts() async =>
      int.tryParse(await _store.read(key: _kAttempts) ?? '0') ?? 0;

  Future<DateTime?> _lockedUntil() async {
    final raw = await _store.read(key: _kLockoutUntil);
    if (raw == null) return null;
    return DateTime.tryParse(raw);
  }

  /// Public read of the lockout deadline (null when not locked).
  Future<DateTime?> lockedUntil() => _lockedUntil();

  Future<void> _recordFailure() async {
    final attempts = await _attempts() + 1;
    if (attempts >= maxAttempts) {
      final level = int.tryParse(await _store.read(key: _kLockLevel) ?? '0') ?? 0;
      final step = lockoutSteps[level.clamp(0, lockoutSteps.length - 1)];
      await _store.write(
        key: _kLockoutUntil,
        value: DateTime.now().add(step).toIso8601String(),
      );
      await _store.write(key: _kLockLevel, value: '${level + 1}');
      await _store.write(key: _kAttempts, value: '0');
    } else {
      await _store.write(key: _kAttempts, value: '$attempts');
    }
  }
}
