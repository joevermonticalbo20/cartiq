import 'package:flutter/material.dart';
import '../services/persisted_queue.dart';
import '../state/cart_state.dart';
import '../theme.dart';
import '../utils/haptics.dart';
import '../utils/money_input.dart';

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

class PosCashQuickAmounts extends StatelessWidget {
  const PosCashQuickAmounts({
    super.key,
    required this.total,
    required this.onSelect,
  });

  final double total;
  final ValueChanged<double> onSelect;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: AppSpacing.space2,
      runSpacing: AppSpacing.space2,
      children: [
        ActionChip(
          label: const Text('Exact'),
          onPressed: () {
            Haptics.select();
            onSelect(total);
          },
        ),
        for (final amount in MoneyInput.cashDenominations)
          ActionChip(
            label: Text('₱$amount'),
            onPressed: () {
              Haptics.select();
              onSelect(amount.toDouble());
            },
          ),
      ],
    );
  }
}

class PosChangeDisplay extends StatelessWidget {
  const PosChangeDisplay({
    super.key,
    required this.total,
    required this.tendered,
  });

  final double total;
  final double tendered;

  @override
  Widget build(BuildContext context) {
    final enough = tendered >= total;
    final color = enough ? AppColors.ok : AppColors.danger;
    final amount = enough ? tendered - total : total - tendered;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.space3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(AppRadius.s),
        border: Border.all(color: color.withValues(alpha: 0.5)),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(
            enough ? 'Change' : 'Short by',
            style: TextStyle(color: color, fontWeight: FontWeight.w700),
          ),
          Text(
            '₱${amount.toStringAsFixed(0)}',
            style: TextStyle(
              color: color,
              fontWeight: FontWeight.w900,
              fontSize: 20,
            ),
          ),
        ],
      ),
    );
  }
}

class PosFlavorSelectionBar extends StatelessWidget {
  const PosFlavorSelectionBar({
    super.key,
    required this.selectedCount,
    required this.canMix,
    required this.onAdd,
    required this.onMix,
  });

  final int selectedCount;
  final bool canMix;
  final VoidCallback? onAdd;
  final VoidCallback? onMix;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.space4,
        AppSpacing.space2,
        AppSpacing.space4,
        AppSpacing.space2,
      ),
      child: Column(
        children: [
          SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              icon: const Icon(Icons.add_shopping_cart_rounded),
              label: Text('Add $selectedCount Selected Flavors to Cart'),
              onPressed: selectedCount == 0 ? null : onAdd,
            ),
          ),
          if (canMix) ...[
            const SizedBox(height: AppSpacing.space1),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                icon: const Icon(Icons.join_inner_rounded),
                label: const Text('Add as Mix-and-Match'),
                onPressed: canMix ? onMix : null,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class PosFlavorPicker extends StatelessWidget {
  const PosFlavorPicker({
    super.key,
    required this.flavors,
    required this.selectedQuantities,
    required this.onToggle,
    required this.onQuantityChanged,
    required this.onQuickAdd,
  });

  final List<Map<String, dynamic>> flavors;
  final Map<String, int> selectedQuantities;
  final ValueChanged<String> onToggle;
  final void Function(String flavor, int quantity) onQuantityChanged;
  final void Function(String flavor, int amount) onQuickAdd;

  bool _unavailable(Map<String, dynamic> flavor) {
    return flavor['isAvailable'] == false ||
        (flavor['availableServings'] is num &&
            (flavor['availableServings'] as num) <= 0);
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(
          'Choose flavors',
          style: TextStyle(fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: AppSpacing.space2),
        Wrap(
          spacing: AppSpacing.space2,
          runSpacing: AppSpacing.space1,
          children: [
            for (final flavor in flavors) _flavorChip(context, flavor),
          ],
        ),
        for (final flavor in flavors)
          if (selectedQuantities.containsKey(flavor['name']))
            _quantityControls(flavor, selectedQuantities[flavor['name']]!),
      ],
    );
  }

  Widget _flavorChip(BuildContext context, Map<String, dynamic> flavor) {
    final name = flavor['name'] as String;
    final unavailable = _unavailable(flavor);
    final servings = flavor['availableServings'];
    return ChoiceChip(
      label: Text(
        unavailable
            ? '$name • Out of Stock'
            : servings is num && servings <= 10
            ? '$name • ${servings.toInt()} left'
            : name,
      ),
      selected: selectedQuantities.containsKey(name),
      showCheckmark: false,
      selectedColor: AppColors.primary,
      labelStyle: TextStyle(
        color: selectedQuantities.containsKey(name) ? Colors.white : null,
        fontWeight: FontWeight.w600,
      ),
      onSelected: unavailable ? null : (_) => onToggle(name),
    );
  }

  Widget _quantityControls(Map<String, dynamic> flavor, int quantity) {
    final name = flavor['name'] as String;
    final stock = flavor['availableServings'];
    final maxQty = stock is num ? stock.toInt() : quantity;
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.space2),
      child: Row(
        children: [
          Expanded(
            child: Text(
              name,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
          ),
          PosQtyButton(
            icon: Icons.remove,
            onPressed: () => onQuantityChanged(name, quantity - 1),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.space2),
            child: Text(
              '$quantity',
              style: const TextStyle(fontWeight: FontWeight.w800),
            ),
          ),
          PosQtyButton(
            icon: Icons.add,
            onPressed: quantity < maxQty
                ? () => onQuantityChanged(name, quantity + 1)
                : null,
          ),
          for (final amount in const [2, 3, 5])
            Padding(
              padding: const EdgeInsets.only(left: 2),
              child: ActionChip(
                visualDensity: VisualDensity.compact,
                label: Text('+$amount'),
                onPressed: () => onQuickAdd(name, amount),
              ),
            ),
        ],
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
