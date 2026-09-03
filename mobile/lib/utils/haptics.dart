import 'package:flutter/services.dart';

/// Centralised haptic feedback helpers. iOS-safe:
/// `HapticFeedback.X()` is a no-op on devices without a taptic engine
/// (older Androids) and on the iOS simulator.
class Haptics {
  const Haptics._();

  /// Light tap for primary button presses (Sign in, etc.).
  static Future<void> tap() => HapticFeedback.lightImpact();

  /// Selection feedback for add-to-cart and option toggles.
  static Future<void> select() => HapticFeedback.selectionClick();

  /// Medium impact for successful confirmations (sale recorded, etc.).
  static Future<void> success() => HapticFeedback.mediumImpact();

  /// Heavy impact for errors / destructive actions.
  static Future<void> error() => HapticFeedback.heavyImpact();
}
