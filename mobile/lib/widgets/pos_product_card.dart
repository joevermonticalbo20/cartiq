import 'package:flutter/material.dart';
import '../theme.dart';
import 'app_badge.dart';

/// Product tile na naka-design specifically para sa 2x2 Grid.
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
      child: Container(
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surface,
          borderRadius: BorderRadius.circular(AppRadius.l),
          // Eto na ang same exact shadowing gaya ng sa Home Screen
          boxShadow: AppShadow.sm(),
        ),
        child: Material(
          color: Colors.transparent,
          borderRadius: BorderRadius.circular(AppRadius.l),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: unavailable ? null : onTap,
            onLongPress: unavailable ? null : onLongPress,
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.space3),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // TOP ROW: Icon at In-Cart Qty Badge
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
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
                      if (inCartQty > 0)
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 8,
                            vertical: 4,
                          ),
                          decoration: BoxDecoration(
                            color: AppColors.primary,
                            borderRadius: BorderRadius.circular(AppRadius.pill),
                          ),
                          child: Text(
                            '$inCartQty',
                            style: const TextStyle(
                              color: Colors.white,
                              fontWeight: FontWeight.w900,
                              fontSize: 12,
                            ),
                          ),
                        ),
                    ],
                  ),

                  const Spacer(), // Itutulak ang mga susunod na elements paibaba
                  // STATUS BADGES
                  if (unavailable) ...[
                    const AppBadge(
                      label: 'Out of Stock',
                      variant: AppBadgeVariant.danger,
                    ),
                    const SizedBox(height: 4),
                  ] else if (availableServings != null &&
                      availableServings > 0 &&
                      availableServings <= 10) ...[
                    AppBadge(
                      label: '${availableServings.toInt()} left',
                      variant: AppBadgeVariant.warn,
                    ),
                    const SizedBox(height: 4),
                  ],

                  // PRODUCT NAME
                  Text(
                    product['name'] as String,
                    style: Theme.of(context).textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                      height: 1.1,
                    ),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const SizedBox(height: AppSpacing.space2),

                  // BOTTOM ROW: Price at Action Button (Flavors / Quick Add)
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Text(
                        '₱${product['basePrice']}',
                        style: Theme.of(context).textTheme.titleLarge?.copyWith(
                          color: AppColors.primary,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                      if (flavorCount > 0)
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 6,
                            vertical: 2,
                          ),
                          decoration: BoxDecoration(
                            color: AppColors.primary.withValues(alpha: 0.1),
                            borderRadius: BorderRadius.circular(4),
                          ),
                          child: Text(
                            '$flavorCount flavs',
                            style: const TextStyle(
                              fontSize: 10,
                              fontWeight: FontWeight.w800,
                              color: AppColors.primary,
                            ),
                          ),
                        )
                      else if (onQuickAdd != null && !unavailable)
                        InkWell(
                          onTap: onQuickAdd,
                          borderRadius: BorderRadius.circular(AppRadius.xs),
                          child: Container(
                            padding: const EdgeInsets.all(4),
                            decoration: BoxDecoration(
                              color: AppColors.primary,
                              borderRadius: BorderRadius.circular(AppRadius.xs),
                            ),
                            child: const Icon(
                              Icons.add,
                              size: 16,
                              color: Colors.white,
                            ),
                          ),
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
