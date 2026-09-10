import 'package:flutter/material.dart';

/// Section header: title on the left, optional trailing action on the right.
/// Mirrors web `PageHeader` (without the eyebrow/actions row).
class SectionHeader extends StatelessWidget {
  const SectionHeader({
    super.key,
    required this.title,
    this.eyebrow,
    this.trailing,
  });

  final String title;
  final String? eyebrow;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final children = <Widget>[
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (eyebrow != null) ...[
              Text(eyebrow!, style: textTheme.labelSmall),
              const SizedBox(height: 2),
            ],
            Text(title, style: textTheme.titleMedium),
          ],
        ),
      ),
    ];
    final t = trailing;
    if (t != null) children.add(t);
    return Row(children: children);
  }
}
