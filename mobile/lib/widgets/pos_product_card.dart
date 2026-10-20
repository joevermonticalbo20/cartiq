import 'package:flutter/material.dart';

import '../theme.dart';
import 'app_badge.dart';

/// Product tile that opens the existing bottom-sheet ordering flow.
class PosProductCard extends StatelessWidget {
  const PosProductCard({
    super.key,
    required this.product,
    required this.flavorCount,
    required this.inCartQty,
    required this.onTap,
    this.onLongPress,
    this.onQuickAdd,
  });

  final Map<String, dynamic> product;
  final int flavorCount;
  final int inCartQty;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;
  final VoidCallback? onQuickAdd;

  bool _unavailable(Map<String, dynamic> item) {
    return item['isAvailable'] == false ||
        (item['availableServings'] is num &&
            (item['availableServings'] as num) <= 0);
  }

  @override
  Widget build(BuildContext context) {
    final flavors = product['flavors'] is List
        ? (product['flavors'] as List)
              .whereType<Map<String, dynamic>>()
              .toList()
        : <Map<String, dynamic>>[];
    final unavailable = flavors.isNotEmpty
        ? flavors.every(_unavailable)
        : _unavailable(product);
    final availableServings = flavors.isNotEmpty
        ? flavors
              .where((flavor) => !_unavailable(flavor))
              .map((flavor) => flavor['availableServings'])
              .whereType<num>()
              .fold<num?>(
                null,
                (best, count) => best == null || count < best ? count : best,
              )
        : product['availableServings'] as num?;

    return Opacity(
      opacity: unavailable ? 0.48 : 1,
      child: Material(
        color: Theme.of(context).colorScheme.surface,
        borderRadius: BorderRadius.circular(AppRadius.l),
        elevation: 2,
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: unavailable ? null : onTap,
          onLongPress: unavailable ? null : onLongPress,
          child: Padding(
            padding: const EdgeInsets.all(AppSpacing.space3),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      width: 44,
                      height: 44,
                      decoration: BoxDecoration(
                        color: AppColors.primary.withValues(alpha: 0.12),
                        borderRadius: BorderRadius.circular(AppRadius.s),
                      ),
                      alignment: Alignment.center,
                      child: const Icon(
                        Icons.fastfood_rounded,
                        size: 22,
                        color: AppColors.primary,
                      ),
                    ),
                    const SizedBox(width: AppSpacing.space2),
                    Expanded(
                      child: Text(
                        product['name'] as String,
                        style: Theme.of(context).textTheme.titleMedium
                            ?.copyWith(fontWeight: FontWeight.w700),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    if (inCartQty > 0) ...[
                      const SizedBox(width: AppSpacing.space1),
                      AppBadge(
                        label: '$inCartQty',
                        variant: AppBadgeVariant.brand,
                      ),
                    ],
                  ],
                ),
                if (unavailable) ...[
                  const SizedBox(height: AppSpacing.space2),
                  const AppBadge(
                    label: 'Out of Stock',
                    variant: AppBadgeVariant.danger,
                  ),
                ] else if (availableServings != null &&
                    availableServings > 0 &&
                    availableServings <= 10) ...[
                  const SizedBox(height: AppSpacing.space2),
                  AppBadge(
                    label: '${availableServings.toInt()} servings left',
                    variant: AppBadgeVariant.warn,
                  ),
                ],
                const SizedBox(height: AppSpacing.space2),
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text(
                      '₱${product['basePrice']}',
                      style: Theme.of(context).textTheme.titleLarge?.copyWith(
                        color: AppColors.primary,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    if (flavorCount > 0)
                      AppBadge(
                        label: '$flavorCount flavor${flavorCount == 1 ? '' : 's'}',
                        variant: AppBadgeVariant.brand,
                      )
                    else if (onQuickAdd != null && !unavailable)
                      IconButton.filled(
                        tooltip: 'Quick-add ${product['name']}',
                        onPressed: onQuickAdd,
                        icon: const Icon(Icons.add),
                      ),
                  ],
                ),
                Text(
                  flavorCount > 0 ? 'Tap to choose flavors' : 'tap to add',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
