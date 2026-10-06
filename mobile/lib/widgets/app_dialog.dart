import 'package:flutter/material.dart';

import '../theme.dart';

/// Confirm dialog mirroring web `ConfirmDialog`.
/// Returns true when confirmed, false when cancelled/dismissed.
Future<bool> showAppConfirm(
  BuildContext context, {
  required String title,
  String? message,
  Widget? child,
  String confirmLabel = 'Confirm',
  bool danger = false,
}) async {
  final result = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: Text(title),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (message != null) Text(message),
          if (child != null) ...[
            if (message != null) const SizedBox(height: 12),
            child,
          ],
        ],
      ),
      actions: [
        TextButton(
          style: TextButton.styleFrom(
            minimumSize: const Size(0, 48),
          ),
          onPressed: () => Navigator.pop(dialogContext, false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          style: danger
              ? FilledButton.styleFrom(backgroundColor: AppColors.danger)
              : null,
          onPressed: () => Navigator.pop(dialogContext, true),
          child: Text(confirmLabel),
        ),
      ],
    ),
  );
  return result ?? false;
}

/// One option in [showAppChoices].
class AppChoice {
  const AppChoice({required this.value, required this.label, this.danger = false});

  /// Opaque value handed back to the caller.
  final String value;
  final String label;

  /// Renders the option in the danger colour - for destructive branches like
  /// removing a registered card.
  final bool danger;
}

/// Two-or-more-option picker, the sibling of [showAppConfirm] for when an
/// action branches. Returns the chosen [AppChoice.value], or null when
/// cancelled/dismissed.
Future<String?> showAppChoices(
  BuildContext context, {
  required String title,
  String? message,
  required List<AppChoice> choices,
}) async {
  assert(choices.length >= 2, 'use showAppConfirm for a single option');
  final result = await showDialog<String>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: Text(title),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (message != null) ...[
            Text(message),
            const SizedBox(height: 12),
          ],
          for (final c in choices)
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(
                c.label,
                style: c.danger
                    ? TextStyle(color: Theme.of(context).colorScheme.error)
                    : null,
              ),
              trailing: const Icon(Icons.chevron_right_rounded),
              onTap: () => Navigator.pop(dialogContext, c.value),
            ),
        ],
      ),
      actions: [
        TextButton(
          style: TextButton.styleFrom(minimumSize: const Size(0, 48)),
          onPressed: () => Navigator.pop(dialogContext),
          child: const Text('Cancel'),
        ),
      ],
    ),
  );
  return result;
}
