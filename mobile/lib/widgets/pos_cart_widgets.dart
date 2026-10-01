import 'package:flutter/material.dart';
import '../services/persisted_queue.dart';
import '../state/cart_state.dart';
import '../theme.dart';
import '../utils/haptics.dart';

/// Round +/- stepper used in the item option sheet. Presentational only.
class PosQtyButton extends StatelessWidget {
  const PosQtyButton({super.key, required this.icon, this.onPressed});

  final IconData icon;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final label = icon == Icons.add ? 'Increase quantity' : 'Decrease quantity';
    return Tooltip(
      message: label,
      child: Material(
        color: onPressed == null
            ? Theme.of(context).disabledColor.withValues(alpha: 0.2)
            : AppColors.primary,
        shape: const CircleBorder(),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onPressed == null
              ? null
              : () {
                  Haptics.select();
                  onPressed!();
                },
          child: SizedBox(
            width: 48,
            height: 48,
            child: Icon(
              icon,
              color: onPressed == null
                  ? Theme.of(context).disabledColor
                  : Colors.white,
            ),
          ),
        ),
      ),
    );
  }
}

/// Thin persistent strip showing queued-offline sales where the cashier works.
class PosOfflineStrip extends StatefulWidget {
  const PosOfflineStrip({super.key});

  @override
  State<PosOfflineStrip> createState() => PosOfflineStripState();
}

class PosOfflineStripState extends State<PosOfflineStrip> {
  int _count = 0;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    try {
      final c = await PersistedOfflineQueue.instance.count;
      if (mounted) setState(() => _count = c);
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<int>(
      stream: PersistedOfflineQueue.instance.changes,
      builder: (context, snap) {
        final count = snap.hasData ? snap.data! : _count;
        if (count <= 0) return const SizedBox.shrink();

        return Container(
          margin: const EdgeInsets.fromLTRB(
            AppSpacing.space4,
            0,
            AppSpacing.space4,
            AppSpacing.space2,
          ),
          padding: const EdgeInsets.symmetric(
            horizontal: AppSpacing.space3,
            vertical: AppSpacing.space2,
          ),
          decoration: BoxDecoration(
            color: AppColors.warn.withValues(alpha: 0.14),
            borderRadius: BorderRadius.circular(AppRadius.s),
            // Tinanggal ang Border.all para perfectly soft at malinis
          ),
          child: Row(
            children: [
              const Icon(
                Icons.cloud_upload_outlined,
                size: 20,
                color: AppColors.warn,
              ),
              const SizedBox(width: AppSpacing.space2),
              Expanded(
                child: Text(
                  '$count sale${count != 1 ? 's' : ''} waiting to sync - uploads automatically when online',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// Persistent cart panel at the bottom of POS. Tapping opens the cart sheet.
/// Empty state is visually muted but keeps layout stable.
class PosCartBar extends StatelessWidget {
  const PosCartBar({super.key, required this.cart, required this.onTap});

  final CartState cart;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final isEmpty = cart.isEmpty;

    return Container(
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        borderRadius: const BorderRadius.vertical(
          top: Radius.circular(AppRadius.xl),
        ),
        // Tinanggal ang top BorderSide dahil sapat na ang shadow para sa separation
        boxShadow: AppShadow.md(),
      ),
      child: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.space4,
            AppSpacing.space3,
            AppSpacing.space4,
            AppSpacing.space3,
          ),
          child: Material(
            color: isEmpty
                ? AppColors.primary.withValues(alpha: 0.5)
                : AppColors.primary,
            borderRadius: BorderRadius.circular(AppRadius.m),
            child: InkWell(
              borderRadius: BorderRadius.circular(AppRadius.m),
              onTap: isEmpty ? null : onTap,
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.space5,
                  vertical: AppSpacing.space4,
                ),
                child: Row(
                  children: [
                    const Icon(Icons.receipt_long_rounded, color: Colors.white),
                    const SizedBox(width: AppSpacing.space3),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            isEmpty
                                ? 'Order empty'
                                : '${cart.totalQty} item${cart.totalQty != 1 ? 's' : ''} in order',
                            style: const TextStyle(
                              color: Colors.white,
                              fontWeight: FontWeight.w700,
                              fontSize: 14,
                            ),
                          ),
                          if (!isEmpty) ...[
                            const SizedBox(height: AppSpacing.space1),
                            Text(
                              'P${cart.total.toStringAsFixed(0)}',
                              style: const TextStyle(
                                color: Colors.white,
                                fontWeight: FontWeight.w800,
                                fontSize: 18,
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                    if (!isEmpty)
                      const Icon(
                        Icons.chevron_right_rounded,
                        color: Colors.white,
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
