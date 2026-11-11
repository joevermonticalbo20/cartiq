import 'dart:io';
import 'dart:typed_data';
import 'dart:ui';

import 'package:flutter/material.dart';

import '../theme.dart';
import '../utils/haptics.dart';

/// The typed-quantity field the vendor uses for a big order ("200 fries").
///
/// It refuses what the stock cannot cover: the value is only handed back to
/// the caller when it is a whole number of at least 1 AND within the stock on
/// hand. Anything else shows why, right under the field.
class PosQuantityField extends StatefulWidget {
  const PosQuantityField({
    super.key,
    required this.quantity,
    required this.maxQuantity,
    required this.onChanged,
    this.label = 'How many?',
    this.hint,
    this.dense = false,
  });

  /// The quantity currently in the order line.
  final int quantity;

  /// The stock on hand. Null means "no ceiling known".
  final int? maxQuantity;

  /// Called with the new quantity - only when it is valid.
  final ValueChanged<int> onChanged;

  /// The label above the field.
  final String label;

  /// A hint under the field ("Only 200 in stock").
  final String? hint;

  /// The compact layout (for the cart rows).
  final bool dense;

  @override
  State<PosQuantityField> createState() => _PosQuantityFieldState();
}

class _PosQuantityFieldState extends State<PosQuantityField> {
  late final TextEditingController _controller = TextEditingController(
    text: widget.quantity.toString(),
  );
  final FocusNode _focus = FocusNode();
  String? _error;

  @override
  void didUpdateWidget(covariant PosQuantityField oldWidget) {
    super.didUpdateWidget(oldWidget);
    // The stepper (or a restored cart) changed the quantity: show it - but
    // never while the vendor is typing in the field.
    if (widget.quantity != oldWidget.quantity && !_focus.hasFocus) {
      final text = widget.quantity.toString();
      if (_controller.text != text) {
        _controller.text = text;
        _controller.selection = TextSelection.collapsed(offset: text.length);
      }
      if (_error != null) setState(() => _error = null);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _apply(String raw) {
    final value = int.tryParse(raw.trim());
    if (value == null || value < 1) {
      setState(() => _error = 'Enter a number');
      return;
    }
    if (widget.maxQuantity != null && value > widget.maxQuantity!) {
      setState(
        () => _error = widget.maxQuantity == 1
            ? 'Only 1 left in stock'
            : 'Only ${widget.maxQuantity} left in stock',
      );
      return;
    }
    if (_error != null) setState(() => _error = null);
    if (value != widget.quantity) widget.onChanged(value);
  }

  @override
  Widget build(BuildContext context) {
    final field = TextField(
      controller: _controller,
      focusNode: _focus,
      keyboardType: TextInputType.number,
      textInputAction: TextInputAction.done,
      textAlign: TextAlign.center,
      style: Theme.of(
        context,
      ).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w900),
      decoration: InputDecoration(
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.space3,
          vertical: AppSpacing.space3,
        ),
        hintText: widget.hint,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadius.s),
          borderSide: BorderSide(
            color: _error == null
                ? Theme.of(context).colorScheme.outlineVariant
                : AppColors.danger,
          ),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadius.s),
          borderSide: BorderSide(
            color: _error == null
                ? Theme.of(context).colorScheme.outlineVariant
                : AppColors.danger,
          ),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(AppRadius.s),
          borderSide: BorderSide(
            color: _error == null ? AppColors.primary : AppColors.danger,
            width: 1.6,
          ),
        ),
      ),
      onChanged: _apply,
      onSubmitted: (value) {
        _apply(value);
        _focus.unfocus();
      },
    );

    if (widget.dense) {
      return Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 96, child: field),
          if (_error != null) ...[
            const SizedBox(height: 4),
            Text(
              _error!,
              style: const TextStyle(
                color: AppColors.danger,
                fontSize: 11,
                fontWeight: FontWeight.w700,
              ),
            ),
          ],
        ],
      );
    }

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          widget.label,
          style: Theme.of(
            context,
          ).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w800),
        ),
        const SizedBox(height: AppSpacing.space2),
        Row(
          children: [
            PosQtyStepButton(
              icon: Icons.remove,
              onPressed: widget.quantity > 1
                  ? () {
                      Haptics.select();
                      widget.onChanged(widget.quantity - 1);
                    }
                  : null,
            ),
            const SizedBox(width: AppSpacing.space2),
            Expanded(child: field),
            const SizedBox(width: AppSpacing.space2),
            PosQtyStepButton(
              icon: Icons.add,
              onPressed: widget.maxQuantity != null &&
                      widget.quantity >= widget.maxQuantity!
                  ? null
                  : () {
                      Haptics.select();
                      widget.onChanged(widget.quantity + 1);
                    },
            ),
          ],
        ),
        if (_error != null) ...[
          const SizedBox(height: AppSpacing.space2),
          Row(
            children: [
              const Icon(
                Icons.error_outline_rounded,
                color: AppColors.danger,
                size: 15,
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  _error!,
                  style: const TextStyle(
                    color: AppColors.danger,
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ),
        ] else if (widget.hint != null) ...[
          const SizedBox(height: AppSpacing.space2),
          Text(
            widget.hint!,
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ],
    );
  }
}

/// The square -/+ button next to the quantity field.
class PosQtyStepButton extends StatelessWidget {
  const PosQtyStepButton({super.key, required this.icon, this.onPressed});

  final IconData icon;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final enabled = onPressed != null;
    return Material(
      color: enabled
          ? AppColors.primary.withValues(alpha: 0.12)
          : Theme.of(context).disabledColor.withValues(alpha: 0.1),
      borderRadius: BorderRadius.circular(AppRadius.s),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onPressed,
        child: SizedBox(
          width: 44,
          height: 44,
          child: Icon(
            icon,
            size: 20,
            color: enabled ? AppColors.primary : Theme.of(context).disabledColor,
          ),
        ),
      ),
    );
  }
}

/// The numeric dialog used to type a quantity for a cart line.
Future<int?> showPosQuantityDialog(
  BuildContext context, {
  required int quantity,
  int? maxQuantity,
  String title = 'How many?',
}) {
  return showDialog<int>(
    context: context,
    builder: (dialogContext) => _PosQuantityDialog(
      quantity: quantity,
      maxQuantity: maxQuantity,
      title: title,
    ),
  );
}

class _PosQuantityDialog extends StatefulWidget {
  const _PosQuantityDialog({
    required this.quantity,
    required this.maxQuantity,
    required this.title,
  });

  final int quantity;
  final int? maxQuantity;
  final String title;

  @override
  State<_PosQuantityDialog> createState() => _PosQuantityDialogState();
}

class _PosQuantityDialogState extends State<_PosQuantityDialog> {
  late final TextEditingController _controller = TextEditingController(
    text: widget.quantity.toString(),
  );
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    final value = int.tryParse(_controller.text.trim());
    if (value == null || value < 1) {
      setState(() => _error = 'Enter a number');
      return;
    }
    if (widget.maxQuantity != null && value > widget.maxQuantity!) {
      setState(
        () => _error = widget.maxQuantity == 1
            ? 'Only 1 left in stock'
            : 'Only ${widget.maxQuantity} left in stock',
      );
      return;
    }
    Navigator.pop(context, value);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.title),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            controller: _controller,
            autofocus: true,
            keyboardType: TextInputType.number,
            textInputAction: TextInputAction.done,
            style: Theme.of(
              context,
            ).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w900),
            decoration: InputDecoration(
              hintText: widget.maxQuantity == null
                  ? '1'
                  : '1 - ${widget.maxQuantity}',
              errorText: _error,
            ),
            onChanged: (_) {
              if (_error != null) setState(() => _error = null);
            },
            onSubmitted: (_) => _submit(),
          ),
          if (widget.maxQuantity != null) ...[
            const SizedBox(height: AppSpacing.space2),
            Text(
              'Only ${widget.maxQuantity} in stock',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(onPressed: _submit, child: const Text('Set')),
      ],
    );
  }
}

/// The captured GCash proof, shown straight away.
///
/// The photo appears as soon as it is taken - no extra "View proof" tap -
/// and a tap on it opens the full screen version.
class PosProofThumbnail extends StatelessWidget {
  const PosProofThumbnail({
    super.key,
    required this.file,
    required this.onTap,
    this.size = 72,
  });

  final File file;
  final VoidCallback onTap;
  final double size;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: size,
        height: size,
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(AppRadius.s),
          border: Border.all(color: AppColors.ok.withValues(alpha: 0.6), width: 2),
        ),
        child: Image.file(
          file,
          fit: BoxFit.cover,
          errorBuilder: (_, _, _) => Container(
            color: AppColors.danger.withValues(alpha: 0.12),
            child: const Icon(Icons.broken_image_rounded, color: AppColors.danger),
          ),
        ),
      ),
    );
  }
}

/// Opens a photo full screen so the vendor can check the amount.
void showPosImageViewer(BuildContext context, {File? file, Uint8List? bytes}) {
  if (file == null && bytes == null) return;
  showDialog(
    context: context,
    barrierColor: Colors.black.withValues(alpha: 0.4),
    builder: (ctx) => BackdropFilter(
      filter: ImageFilter.blur(sigmaX: 12, sigmaY: 12),
      child: Dialog(
        backgroundColor: Colors.transparent,
        elevation: 0,
        insetPadding: const EdgeInsets.all(AppSpacing.space4),
        child: SizedBox(
          width: double.infinity,
          height: MediaQuery.of(context).size.height * 0.7,
          child: Stack(
            alignment: Alignment.center,
            children: [
              Positioned.fill(
                child: InteractiveViewer(
                  minScale: 1.0,
                  maxScale: 4.0,
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(AppRadius.l),
                    child: file != null
                        ? Image.file(file, fit: BoxFit.contain)
                        : Image.memory(
                            bytes!,
                            fit: BoxFit.contain,
                            errorBuilder: (_, _, _) => const Center(
                              child: Icon(
                                Icons.broken_image_rounded,
                                color: Colors.white,
                                size: 48,
                              ),
                            ),
                          ),
                  ),
                ),
              ),
              Positioned(
                top: AppSpacing.space2,
                right: AppSpacing.space2,
                child: IconButton(
                  style: IconButton.styleFrom(
                    backgroundColor: Colors.white.withValues(alpha: 0.25),
                    side: BorderSide(color: Colors.white.withValues(alpha: 0.4)),
                  ),
                  icon: const Icon(Icons.close_rounded, color: Colors.white),
                  onPressed: () => Navigator.pop(ctx),
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}
