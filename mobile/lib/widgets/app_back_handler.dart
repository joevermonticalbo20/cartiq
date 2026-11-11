import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'app_dialog.dart';

/// What the system back button should do on the current tab.
enum BackAction {
  /// Walk to the app's front door (Home) instead of leaving.
  goHome,

  /// Ask before closing the app.
  confirmExit,
}

/// Handles the Android back button for the tab shell.
///
/// The vendor rings up an order on a phone that is often in a pocket or on a
/// counter with a cartful of fries next to it. Back must never close the app
/// by accident: from any tab it walks to Home first, and only from Home does
/// it ask "Do you still want to exit?".
class AppBackHandler extends StatelessWidget {
  const AppBackHandler({
    super.key,
    required this.currentIndex,
    required this.homeIndex,
    required this.onGoHome,
    required this.child,
    this.exitMessage,
    this.onExit,
  });

  /// The tab the shell is showing.
  final int currentIndex;

  /// The tab that counts as "home" (the front door of the app).
  final int homeIndex;

  /// Called when back should move the shell to [homeIndex].
  final VoidCallback onGoHome;

  /// Shown in the exit dialog. Null means the plain "close the app?" question.
  final String? exitMessage;

  /// Called when the vendor confirms the exit. Defaults to closing the app.
  final VoidCallback? onExit;

  /// The screen (the tab shell) that the back button protects.
  final Widget child;

  /// What back does on this tab.
  BackAction get action =>
      currentIndex == homeIndex ? BackAction.confirmExit : BackAction.goHome;

  Future<void> _handle(BuildContext context) async {
    if (action == BackAction.goHome) {
      onGoHome();
      return;
    }
    final leave = await showAppConfirm(
      context,
      title: 'Do you still want to exit?',
      message: exitMessage,
      confirmLabel: 'Yes',
      cancelLabel: 'No',
    );
    if (!leave) return;
    final exit = onExit;
    if (exit != null) {
      exit();
      return;
    }
    await SystemNavigator.pop();
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      // The shell never pops: back is handled here so the vendor is walked
      // Home and asked before the app closes.
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        _handle(context);
      },
      child: child,
    );
  }
}
