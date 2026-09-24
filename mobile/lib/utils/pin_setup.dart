import 'package:flutter/material.dart';

import '../services/auth_state.dart';
import '../services/offline_pin.dart';
import '../theme.dart';
import '../utils/haptics.dart';
import '../widgets/pin_pad.dart';

/// Two-step PIN setup sheets (enter + confirm). Returns true when a PIN was
/// stored. Used by the post-login auto-prompt and the Settings setup row so
/// both flows behave identically.
Future<bool> showPinSetupFlow(BuildContext context, AuthState auth) async {
  final username = auth.user?['username'] as String?;
  if (username == null) return false;

  Future<String?> askPin(String title) async {
    String? result;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) => SafeArea(
        child: Padding(
          padding: EdgeInsets.only(
            left: AppSpacing.space5,
            right: AppSpacing.space5,
            top: AppSpacing.space4,
            bottom: MediaQuery.of(context).viewInsets.bottom +
                AppSpacing.space6,
          ),
          child: PinPad(
            title: title,
            onComplete: (pin) {
              result = pin;
              Navigator.pop(sheetContext);
            },
          ),
        ),
      ),
    );
    return result;
  }

  final first = await askPin('Choose a 6-digit offline PIN');
  if (first == null || !context.mounted) return false;
  final second = await askPin('Confirm offline PIN');
  if (second == null || !context.mounted) return false;
  if (first != second) {
    await Haptics.error();
    if (!context.mounted) return false;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        const SnackBar(content: Text('PINs did not match. Try again.')),
      );
    return false;
  }
  try {
    await auth.pin.setupPin(username: username, pin: first);
    await Haptics.success();
    return true;
  } on PinException catch (e) {
    if (!context.mounted) return false;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(e.message)));
    return false;
  }
}
