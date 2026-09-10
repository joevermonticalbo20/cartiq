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
