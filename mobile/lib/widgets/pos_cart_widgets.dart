import 'package:flutter/material.dart';
import '../services/persisted_queue.dart';
import '../state/cart_state.dart';
import '../theme.dart';
import '../utils/haptics.dart';

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

class PosCartBar extends StatelessWidget {
  const PosCartBar({super.key, required this.cart, required this.onTap});
  final CartState cart;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final isEmpty = cart.isEmpty;

    return Center(
      // INAYOS: Pinagitna ang buong Cart Bar
      child: Container(
        constraints: const BoxConstraints(
          maxWidth: 220,
        ), // INAYOS: Pinaikli para hindi full-width
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(AppRadius.pill),
          boxShadow: [
            BoxShadow(
              color: isEmpty
                  ? Colors.black.withValues(alpha: 0.1)
                  : AppColors.primary.withValues(alpha: 0.3),
              blurRadius: 16,
              offset: const Offset(0, 6),
            ),
          ],
        ),
        child: Material(
          color: isEmpty
              ? AppColors.primary.withValues(alpha: 0.5)
              : AppColors.primary,
          borderRadius: BorderRadius.circular(AppRadius.pill),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: isEmpty ? null : onTap,
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.space5,
                vertical: 10, // INAYOS: Mas manipis at compact
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min, // Hugs content
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  const Icon(
                    Icons.shopping_basket_rounded,
                    color: Colors.white,
                    size: 20,
                  ),
                  const SizedBox(width: 10),
                  Flexible(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          isEmpty
                              ? 'Order empty'
                              : '${cart.totalQty} item${cart.totalQty != 1 ? 's' : ''}',
                          style: const TextStyle(
                            color: Colors.white,
                            fontWeight: FontWeight.w700,
                            fontSize: 12,
                          ),
                        ),
                        if (!isEmpty) ...[
                          Text(
                            '₱${cart.total.toStringAsFixed(0)}',
                            style: const TextStyle(
                              color: Colors.white,
                              fontWeight: FontWeight.w900,
                              fontSize: 15,
                              height: 1.1,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                  if (!isEmpty) ...[
                    const SizedBox(width: 8),
                    const Icon(
                      Icons.chevron_right_rounded,
                      color: Colors.white,
                      size: 20,
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
