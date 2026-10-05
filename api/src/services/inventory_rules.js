// Shared inventory business rules used by both the POS order flow and the
// IoT sensor ingestion, so threshold alerts behave identically everywhere.

const trim3 = (n) => Number(n.toFixed(3));

/**
 * Oversell detector for sale consumption. Returns the shortage (> 0) when
 * `stock` cannot cover `amountPerUnit * qty`, else 0. Pure function so the
 * math is unit-testable without a database.
 */
export function oversellShortage(stock, amountPerUnit, qty) {
  const raw = stock - amountPerUnit * qty;
  return raw < 0 ? trim3(-raw) : 0;
}

/** Human-readable stock amounts (trims float dust like 0.30000000000000004). */
export function fmtStock(n) {
  return trim3(n);
}

/**
 * Recipe maps applying to one order line: every candidate map whose flavor
 * matches the line or is generic (""), with the flavor-specific row winning
 * per itemName. Single source of truth shared by the POS deduction
 * (routes/orders.js) and the forecast usage builder
 * (services/analytics_engine.js buildDailyUsage) — the two must agree or
 * forecasts systematically undercount multi-ingredient products.
 */
export function mapsForOrderLine(maps, productName, flavorKey) {
  const byItem = new Map();
  for (const m of maps) {
    if (m.productName !== productName) continue;
    if (m.flavor !== flavorKey && m.flavor !== "") continue;
    const current = byItem.get(m.itemName);
    if (!current || (m.flavor === flavorKey && current.flavor !== flavorKey)) {
      byItem.set(m.itemName, m);
    }
  }
  return [...byItem.values()];
}

/**
 * Plan the stock restores for a VOID, without touching the database.
 *
 * Single source of truth for the restore arithmetic, used by the POS void
 * path (routes/orders.js) and mirrored verbatim in the Supabase Edge
 * Function so both stacks restore identically. Pure, so the arithmetic is
 * unit-testable without an emulator.
 *
 * The orphan case: PATCH /products/:id/rename deliberately rewrites
 * ingredientMaps to the new name while past orders keep the old one
 * ("historical truth"). Because matching is exact-string, an order sold
 * before a rename (or before a flavor rename) matches NO map, so nothing is
 * restored. That previously returned `{ restored: [], warnings: [] }` - a
 * clean-looking 200 that silently lost stock - so a line with zero matched
 * maps is now always reported. `warnings` is therefore never silently empty.
 *
 * Do NOT "fix" the rename case by keeping extra ingredientMaps rows under
 * the old product name: analytics_engine.buildDailyUsage feeds the same
 * matcher, so alias rows would double-count usage and skew reorder
 * suggestions. The durable fix is snapshotting the resolved recipe onto the
 * order line at sale time.
 */
export function planVoidRestores(orderItems, maps, invRows) {
  const invByName = new Map(invRows.map((r) => [r.name, r]));
  const warnings = [];
  const restores = new Map(); // invId -> { inv, newStock, added }
  for (const row of orderItems ?? []) {
    const flavorKey = row.flavor ?? "";
    const label = [row.productName, row.flavor].filter(Boolean).join(" / ");
    const matched = mapsForOrderLine(maps, row.productName, flavorKey);
    if (matched.length === 0) {
      warnings.push(
        `no recipe matched "${label}" at void — stock NOT restored ` +
        `(product or flavor was renamed after this sale)`,
      );
      continue;
    }
    // Flavour-drift guard. A FLAVOURED line that resolves only to generic
    // ("") recipes, on a product that DOES carry flavour-specific recipes,
    // means this flavour's override was renamed or deleted after the sale:
    // the deduction used the flavour amount but the restore falls back to
    // the generic one, silently restoring the wrong quantity. Products whose
    // recipe is genuinely flavourless have no flavour-specific maps at all,
    // so this stays quiet for them.
    if (
      flavorKey &&
      matched.every((m) => m.flavor === "") &&
      maps.some((m) => m.productName === row.productName && m.flavor !== "")
    ) {
      warnings.push(
        `only the generic recipe matched "${label}" at void — stock restored at ` +
        `the generic amount, not the flavour amount ` +
        `(that flavour's recipe was likely renamed after this sale)`,
      );
    }
    for (const map of matched) {
      const inv = invByName.get(map.itemName);
      if (!inv) {
        warnings.push(`no inventory row "${map.itemName}" at void — restore skipped`);
        continue;
      }
      const add = map.amountPerUnit * row.qty;
      const prev = restores.has(inv.id) ? restores.get(inv.id).newStock : inv.stock;
      restores.set(inv.id, {
        inv,
        newStock: prev + add,
        added: (restores.get(inv.id)?.added ?? 0) + add,
      });
    }
  }
  return { restores, warnings };
}

export async function applyStockChange(tx, { inv, newStock, location }) {
  const crossed = inv.stock > inv.threshold && newStock <= inv.threshold;
  await tx.inventoryItem.update({
    where: { id: inv.id },
    data: { stock: newStock },
  });
  if (crossed) {
    const needle = `${inv.name} @ ${location.code}`;
    const dup = await tx.alert.findFirst({
      where: { type: "LOW_STOCK", isRead: false, message: { contains: needle } },
    });
    if (!dup) {
      await tx.alert.create({
        data: {
          type: "LOW_STOCK",
          message: `${needle} dropped below threshold (${newStock} ${inv.unit} left)`,
          payload: JSON.stringify({
            inventoryItemId: inv.id,
            stock: newStock,
            threshold: inv.threshold,
            unit: inv.unit,
          }),
        },
      });
    }
  }
  return crossed;
}
