// Shared inventory business rules used by both the POS order flow and the
// IoT sensor ingestion, so threshold alerts behave identically everywhere.

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
