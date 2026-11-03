import 'package:flutter/material.dart';

import '../theme.dart';
import '../utils/password_strength.dart';

/// Four-bar strength meter + requirement checklist for password fields.
/// Mirrors the web `PasswordStrengthMeter`: bars fill with the level, the
/// label names it, and once typing starts the four rules list under it.
class PasswordStrengthMeter extends StatelessWidget {
  const PasswordStrengthMeter({super.key, required this.value});

  final String value;

  int _filledCount(String level) {
    switch (level) {
      case 'weak':
        return 1;
      case 'fair':
        return 2;
      case 'good':
        return 3;
      case 'strong':
        return 4;
      default:
        return 0;
    }
  }

  Color _levelColor(String level, Color fallback) {
    switch (level) {
      case 'weak':
        return AppColors.danger;
      case 'fair':
      case 'good':
        return AppColors.warn;
      case 'strong':
        return AppColors.ok;
      default:
        return fallback;
    }
  }

  @override
  Widget build(BuildContext context) {
    final strength = evaluatePassword(value);
    final filled = _filledCount(strength.level);
    final barColor = _levelColor(strength.level, Theme.of(context).dividerColor);
    final labelColor = _levelColor(strength.level, AppColors.muted);
    final showChecks = value.isNotEmpty;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: List.generate(4, (i) {
            return Expanded(
              child: Container(
                height: 7,
                margin: EdgeInsets.only(right: i == 3 ? 0 : 6),
                decoration: BoxDecoration(
                  color: i < filled
                      ? barColor
                      : Theme.of(context).dividerColor,
                  borderRadius: BorderRadius.circular(99),
                ),
              ),
            );
          }),
        ),
        const SizedBox(height: AppSpacing.space2),
        Row(
          children: [
            Expanded(
              child: Text(
                passwordLevelLabel[strength.level] ?? '',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: labelColor,
                ),
              ),
            ),
            if (showChecks && !strength.meetsGood)
              const Text(
                'Min strength required: good',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: AppColors.warn,
                ),
              ),
          ],
        ),
        if (showChecks) ...[
          const SizedBox(height: AppSpacing.space1),
          _check('At least 8 characters', strength.length),
          _check('Uppercase and lowercase letters', strength.caseOk),
          _check('At least one number', strength.digit),
          _check('At least one special character', strength.special),
        ],
      ],
    );
  }

  Widget _check(String label, bool ok) {
    return Padding(
      padding: const EdgeInsets.only(top: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 16,
            child: Text(
              ok ? '\u2713' : '\u00B7',
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w700,
                color: ok ? AppColors.ok : AppColors.muted,
              ),
            ),
          ),
          Expanded(
            child: Text(
              label,
              style: TextStyle(
                fontSize: 12,
                color: ok ? AppColors.ok : AppColors.muted,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
