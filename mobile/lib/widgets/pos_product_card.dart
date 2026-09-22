import 'package:flutter/material.dart';

import '../theme.dart';
import 'app_badge.dart';

/// Product tile for the POS catalog grid. Pure presentational widget:
/// all cart/API logic stays in `pos_screen.dart`.
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

  @override
  Widget build(BuildContext context) {
    final name = product['name'] as String;
    final price = product['basePrice'] as num;
    return Material(
      color: Theme.of(context).colorScheme.surface,
      borderRadius: BorderRadius.circular(AppRadius.l),
      child: InkWell(
        borderRadius: BorderRadius.circular(AppRadius.l),
        onTap: onTap,
        onLongPress: onLongPress,
        child: Container(
          padding: const EdgeInsets.all(AppSpacing.space3),
          decoration: BoxDecoration(
            border: Border.all(
              color: inCartQty > 0
                  ? AppColors.primary
                  : Theme.of(context).dividerColor,
              width: inCartQty > 0 ? 1.5 : 1,
            ),
            borderRadius: BorderRadius.circular(AppRadius.l),
            boxShadow: inCartQty > 0 ? AppShadow.sm() : null,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Top: food icon tile + name + cart badge
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
                      name,
                      style: Theme.of(context).textTheme.titleMedium?.copyWith(
                        fontWeight: FontWeight.w700,
                      ),
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
              const Spacer(),
              // Price + flavor badge / quick-add
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Flexible(
                    child: Text(
                      'P$price',
                      style: Theme.of(context).textTheme.headlineSmall
                          ?.copyWith(
                            color: AppColors.primary,
                            fontWeight: FontWeight.w800,
                          ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if (flavorCount > 0)
                    AppBadge(
                      label: '$flavorCount',
                      variant: AppBadgeVariant.brand,
                    )
                  else if (onQuickAdd != null)
                    Tooltip(
                      message: 'Quick-add $name',
                      child: Material(
                        color: AppColors.primary,
                        shape: const CircleBorder(),
                        child: InkWell(
                          customBorder: const CircleBorder(),
                          onTap: onQuickAdd,
                          child: const SizedBox(
                            width: 48,
                            height: 48,
                            child:
                                Icon(Icons.add, color: Colors.white, size: 22),
                          ),
                        ),
                      ),
                    ),
                ],
              ),
              const SizedBox(height: AppSpacing.space1),
              Text(
                flavorCount > 0
                    ? '$flavorCount flavor${flavorCount != 1 ? 's' : ''}'
                    : 'tap to add',
                style: Theme.of(context).textTheme.bodySmall,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
