import 'package:flutter/material.dart';
import '../services/persisted_queue.dart';
import '../state/cart_state.dart';
import '../theme.dart';
import '../utils/haptics.dart';
import '../utils/payment_rules.dart';

class PosQtyButton extends StatelessWidget {
  const PosQtyButton({super.key, required this.icon, this.onPressed});
  final IconData icon;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final isAdd = icon == Icons.add;
    final label = isAdd ? 'Increase quantity' : 'Decrease quantity';

    // Mas soft at modern na kulay para sa buttons
    final bgColor = onPressed == null
        ? Theme.of(context).disabledColor.withValues(alpha: 0.1)
        : (isAdd
              ? AppColors.primary
              : AppColors.primary.withValues(alpha: 0.12));

    final iconColor = onPressed == null
        ? Theme.of(context).disabledColor
        : (isAdd ? Colors.white : AppColors.primary);

    return Tooltip(
      message: label,
      child: Material(
        color: bgColor,
        borderRadius: BorderRadius.circular(
          AppRadius.s,
        ), // Rounded rectangle imbes na bilog
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onPressed == null
              ? null
              : () {
                  Haptics.select();
                  onPressed!();
                },
          child: SizedBox(
            width: 38,
            height: 38,
            child: Icon(icon, size: 20, color: iconColor),
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
    // The chips follow the total: the exact amount first, then the notes a
    // customer would actually hand over (the smallest ones above the total).
    // A fixed list of notes was useless for a big order - every chip was
    // below the total and could not be used.
    final amounts = PaymentRules.quickCashAmounts(total);
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
        for (final amount in amounts.skip(1))
          ActionChip(
            label: Text('₱${amount == amount.roundToDouble() ? amount.toStringAsFixed(0) : amount.toStringAsFixed(2)}'),
            onPressed: () {
              Haptics.select();
              onSelect(amount);
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
    this.maxTendered,
  });
  final double total;
  final double tendered;

  /// The most cash that may be typed for this total (total + the change
  /// limit). Null means "no limit known".
  final double? maxTendered;

  @override
  Widget build(BuildContext context) {
    final ceiling = maxTendered;
    final tooMuch = ceiling != null && tendered > ceiling;
    final tooLittle = tendered < total;
    final ok = !tooMuch && !tooLittle;
    final color = ok ? AppColors.ok : AppColors.danger;
    final label = tooMuch ? 'Too much' : (tooLittle ? 'Short by' : 'Change');
    final amount = tooMuch
        ? tendered - ceiling
        : (tooLittle ? total - tendered : tendered - total);

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
            label,
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
    required this.onAdd,
  });
  final int selectedCount;
  final VoidCallback? onAdd;

  @override
  Widget build(BuildContext context) {
    final flavorLabel = selectedCount == 1 ? 'Flavor' : 'Flavors';

    return SizedBox(
      width: double.infinity,
      child: FilledButton.icon(
        icon: const Icon(Icons.add_shopping_cart_rounded),
        label: Text('Add $selectedCount Selected $flavorLabel to Cart'),
        onPressed: selectedCount == 0 ? null : onAdd,
      ),
    );
  }
}

/// The size picker for a fries product.
///
/// The vendor taps a flavor ("BBQ Fries") and then picks the size
/// (Medium / Large / XL 40 / XL 50). One size per order line: the sizes are
/// shown as big tiles with the price, the live stock and a + / - stepper, so
/// the choice is one tap instead of a list of small chips.
class PosSizePicker extends StatelessWidget {
  const PosSizePicker({
    super.key,
    required this.sizes,
    required this.selected,
    required this.selectedQuantity,
    required this.onSelect,
    required this.onQuantityChanged,
  });

  /// The size options from the catalog: name, unitPrice, availableServings.
  final List<Map<String, dynamic>> sizes;

  /// The currently picked size name (null = nothing picked yet).
  final String? selected;

  /// How many servings the vendor picked for [selected] (0 when none).
  final int selectedQuantity;

  final ValueChanged<String> onSelect;
  final void Function(String size, int quantity) onQuantityChanged;

  bool _unavailable(Map<String, dynamic> size) {
    return size['isAvailable'] == false ||
        (size['availableServings'] is num &&
            (size['availableServings'] as num) <= 0);
  }

  String _priceLabel(num value) {
    final v = value.toDouble();
    return v == v.roundToDouble() ? v.toInt().toString() : v.toStringAsFixed(2);
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          'Choose a size',
          style: Theme.of(
            context,
          ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
        ),
        const SizedBox(height: AppSpacing.space3),
        GridView.count(
          crossAxisCount: 2,
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          mainAxisSpacing: AppSpacing.space2,
          crossAxisSpacing: AppSpacing.space2,
          childAspectRatio: 1.55,
          children: [for (final size in sizes) _sizeTile(context, size)],
        ),
      ],
    );
  }

  Widget _sizeTile(BuildContext context, Map<String, dynamic> size) {
    final name = size['name'] as String;
    final unavailable = _unavailable(size);
    final servings = size['availableServings'];
    final price = size['unitPrice'];
    final isSelected = selected == name;
    final quantity = isSelected ? selectedQuantity : 0;

    final borderColor = isSelected
        ? AppColors.primary
        : Theme.of(context).colorScheme.outlineVariant;
    final bg = isSelected
        ? AppColors.primary.withValues(alpha: 0.08)
        : Theme.of(context).colorScheme.surface;

    return Opacity(
      opacity: unavailable ? 0.5 : 1,
      child: Material(
        color: bg,
        borderRadius: BorderRadius.circular(AppRadius.l),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: unavailable ? null : () => onSelect(name),
          child: Container(
            padding: const EdgeInsets.all(AppSpacing.space3),
            decoration: BoxDecoration(
              border: Border.all(color: borderColor, width: isSelected ? 2 : 1),
              borderRadius: BorderRadius.circular(AppRadius.l),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Text(
                        name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.titleMedium?.copyWith(
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                    ),
                    if (price is num)
                      Text(
                        '₱${_priceLabel(price)}',
                        style: Theme.of(context).textTheme.titleMedium?.copyWith(
                          color: AppColors.primary,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                  ],
                ),
                const SizedBox(height: AppSpacing.space1),
                Text(
                  unavailable
                      ? 'Out of stock'
                      : servings is num && servings <= 10
                      ? '${servings.toInt()} left'
                      : servings is num
                      ? '${servings.toInt()} servings left'
                      : 'In stock',
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: unavailable
                        ? AppColors.danger
                        : Theme.of(context).colorScheme.onSurfaceVariant,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                if (isSelected)
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      PosQtyButton(
                        icon: Icons.remove,
                        onPressed: () => onQuantityChanged(name, quantity - 1),
                      ),
                      Text(
                        '$quantity',
                        style: Theme.of(context).textTheme.titleMedium?.copyWith(
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                      PosQtyButton(
                        icon: Icons.add,
                        onPressed: () => onQuantityChanged(name, quantity + 1),
                      ),
                    ],
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The sticky bar under the size picker: what was picked and the total, with
/// the button that adds it to the cart.
class PosSizeSelectionBar extends StatelessWidget {
  const PosSizeSelectionBar({
    super.key,
    required this.sizeName,
    required this.quantity,
    required this.total,
    required this.onAdd,
  });

  final String? sizeName;
  final int quantity;
  final double total;
  final VoidCallback? onAdd;

  @override
  Widget build(BuildContext context) {
    final hasSelection = sizeName != null && quantity > 0;
    final label = hasSelection
        ? 'Add $quantity × $sizeName  •  ₱${total.toStringAsFixed(2)}'
        : 'Pick a size';

    return SizedBox(
      width: double.infinity,
      child: FilledButton.icon(
        icon: const Icon(Icons.add_shopping_cart_rounded),
        label: Text(label),
        onPressed: hasSelection ? onAdd : null,
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
        Text(
          'Choose flavors',
          style: Theme.of(
            context,
          ).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w800),
        ),
        const SizedBox(height: AppSpacing.space3),
        Wrap(
          spacing: AppSpacing.space2,
          runSpacing: AppSpacing.space2,
          children: [
            for (final flavor in flavors) _flavorChip(context, flavor),
          ],
        ),
        const SizedBox(height: AppSpacing.space2),
        for (final flavor in flavors)
          if (selectedQuantities.containsKey(flavor['name']))
            _quantityControls(
              context,
              flavor,
              selectedQuantities[flavor['name']]!,
            ),
      ],
    );
  }

  /// Whole pesos print bare (P20), centavos keep two decimals (P20.50).
  String _priceLabel(num value) {
    final v = value.toDouble();
    return v == v.roundToDouble() ? v.toInt().toString() : v.toStringAsFixed(2);
  }

  Widget _flavorChip(BuildContext context, Map<String, dynamic> flavor) {
    final name = flavor['name'] as String;
    final unavailable = _unavailable(flavor);
    final servings = flavor['availableServings'];
    // Price makes size options readable (Medium P20 / Large P30 / XL P40)
    // and shows custom flavor prices; omitted when the catalog is old.
    final unitPrice = flavor['unitPrice'];
    final priceSuffix = unitPrice is num ? ' • ₱${_priceLabel(unitPrice)}' : '';

    return ChoiceChip(
      label: Text(
        unavailable
            ? '$name$priceSuffix • Out of Stock'
            : servings is num && servings <= 10
            ? '$name$priceSuffix • ${servings.toInt()} left'
            : '$name$priceSuffix',
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

  Widget _quantityControls(
    BuildContext context,
    Map<String, dynamic> flavor,
    int quantity,
  ) {
    final name = flavor['name'] as String;
    final stock = flavor['availableServings'];
    final maxQty = stock is num ? stock.toInt() : quantity;

    return Container(
      margin: const EdgeInsets.only(top: AppSpacing.space3),
      padding: const EdgeInsets.all(AppSpacing.space3),
      decoration: BoxDecoration(
        color: AppColors.primary.withValues(
          alpha: 0.04,
        ), // Subtle highlight box
        borderRadius: BorderRadius.circular(AppRadius.m),
        border: Border.all(color: AppColors.primary.withValues(alpha: 0.1)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            name,
            style: const TextStyle(
              fontWeight: FontWeight.w800,
              fontSize: 15,
              color: AppColors.primaryStrong,
            ),
          ),
          const SizedBox(height: AppSpacing.space2),
          Row(
            children: [
              PosQtyButton(
                icon: Icons.remove,
                onPressed: () => onQuantityChanged(name, quantity - 1),
              ),
              Container(
                width: 44,
                alignment: Alignment.center,
                child: Text(
                  '$quantity',
                  style: const TextStyle(
                    fontWeight: FontWeight.w900,
                    fontSize: 18,
                  ),
                ),
              ),
              PosQtyButton(
                icon: Icons.add,
                onPressed: quantity < maxQty
                    ? () => onQuantityChanged(name, quantity + 1)
                    : null,
              ),
              const Spacer(),
              for (final amount in const [2, 3, 5])
                Padding(
                  padding: const EdgeInsets.only(left: AppSpacing.space1),
                  child: ActionChip(
                    visualDensity: VisualDensity.compact,
                    side: BorderSide(
                      color: AppColors.primary.withValues(alpha: 0.2),
                    ),
                    backgroundColor: Colors.transparent,
                    labelStyle: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                      color: AppColors.primary.withValues(alpha: 0.8),
                    ),
                    label: Text('+$amount'),
                    onPressed: () => onQuickAdd(name, amount),
                  ),
                ),
            ],
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
      child: Container(
        constraints: const BoxConstraints(maxWidth: 220),
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
                vertical: 10,
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
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
