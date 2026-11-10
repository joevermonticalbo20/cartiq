import { Router } from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import { db as prisma } from "../firestore.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  splitFlavorCell,
  splitOptionPricesCell,
  parseCostCell,
  validateProductRow,
} from "../services/import_rules.js";
import {
  manilaMonthRange,
  manilaDayRange,
  manilaDayKey,
  manilaTimeHM,
} from "../services/timezone.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Safety bound for history-growth exports (sales/expenses/shifts): newest
// rows win, and the response carries X-Export-Truncated when capped.
const MAX_EXPORT_ROWS = 5000;

function monthRange(month) {
  // Manila calendar month (server runs UTC in prod; a bare local-midnight
  // start would shift the month edge by 8h).
  return manilaMonthRange(month);
}

/**
 * Resolve the export window from query params. `month=YYYY-MM` wins when
 * present; otherwise an explicit Manila-calendar custom range. Returns
 * { range } or { error } (caller responds 400).
 */
function resolveRange({ month, startDate, endDate }) {
  if (month) return { range: monthRange(month) };
  if (startDate === undefined && endDate === undefined) return { range: null };
  if (!startDate || !endDate) {
    return { error: "startDate and endDate are both required for a custom range" };
  }
  const start = manilaDayRange(String(startDate));
  const end = manilaDayRange(String(endDate));
  if (!start || !end) {
    return { error: "startDate/endDate must be YYYY-MM-DD" };
  }
  if (start.start.getTime() > end.start.getTime()) {
    return { error: "startDate must not be after endDate" };
  }
  return { range: { start: start.start, end: end.end } };
}

function styleHeader(sheet) {
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFF4E3D3" },
  };
  sheet.columns.forEach((col) => col?.width && undefined);
}

async function buildSalesSheet(wb, range) {
  const newest = await prisma.order.findMany({
    where: {
      status: "PAID",
      ...(range ? { createdAt: { gte: range.start, lt: range.end } } : {}),
    },
    include: {
      items: true,
      location: { select: { code: true, name: true } },
      staff: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: MAX_EXPORT_ROWS + 1,
  });
  const truncated = newest.length > MAX_EXPORT_ROWS;
  // File stays chronological (oldest first) even though we fetched newest.
  const orders = newest.slice(0, MAX_EXPORT_ROWS).reverse();

  const lines = wb.addWorksheet("Sales Lines");
  lines.columns = [
    { header: "Date", key: "date", width: 12 },
    { header: "Time", key: "time", width: 10 },
    { header: "Cart", key: "cart", width: 10 },
    { header: "Product", key: "product", width: 18 },
    { header: "Flavor", key: "flavor", width: 14 },
    { header: "Qty", key: "qty", width: 6 },
    { header: "Unit Price", key: "unitPrice", width: 11 },
    { header: "Line Total", key: "lineTotal", width: 11 },
    { header: "Staff", key: "staff", width: 20 },
  ];
  const perCart = new Map();
  for (const o of orders) {
    const cartTotals = perCart.get(o.location.code) ?? { sales: 0, orders: 0 };
    cartTotals.sales += o.total;
    cartTotals.orders += 1;
    perCart.set(o.location.code, cartTotals);
    for (const it of o.items) {
      lines.addRow({
        date: manilaDayKey(o.createdAt),
        time: manilaTimeHM(o.createdAt),
        cart: o.location.code,
        product: it.productName,
        flavor: it.flavor ?? "",
        qty: it.qty,
        unitPrice: it.unitPrice,
        lineTotal: Number((it.qty * it.unitPrice).toFixed(2)),
        staff: o.staff?.name ?? "",
      });
    }
  }
  styleHeader(lines);

  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { header: "Cart", key: "cart", width: 12 },
    { header: "Orders", key: "orders", width: 10 },
    { header: "Total Sales", key: "sales", width: 14 },
  ];
  let totalSales = 0;
  let totalOrders = 0;
  for (const [code, v] of perCart) {
    summary.addRow({ cart: code, orders: v.orders, sales: Number(v.sales.toFixed(2)) });
    totalSales += v.sales;
    totalOrders += v.orders;
  }
  summary.addRow({});
  summary.addRow({ cart: "TOTAL", orders: totalOrders, sales: Number(totalSales.toFixed(2)) });
  styleHeader(summary);
  return truncated;
}

async function buildInventorySheet(wb) {
  const locations = await prisma.location.findMany({
    include: { inventory: true },
    orderBy: { code: "asc" },
  });
  const sheet = wb.addWorksheet("Inventory");
  sheet.columns = [
    { header: "Cart", key: "cart", width: 10 },
    { header: "Item", key: "item", width: 24 },
    { header: "Stock", key: "stock", width: 10 },
    { header: "Unit", key: "unit", width: 8 },
    { header: "Threshold", key: "threshold", width: 10 },
    { header: "Source", key: "source", width: 9 },
    { header: "Updated", key: "updated", width: 20 },
  ];
  for (const loc of locations) {
    for (const item of loc.inventory) {
      sheet.addRow({
        cart: loc.code,
        item: item.name,
        stock: item.stock,
        unit: item.unit,
        threshold: item.threshold,
        source: item.source,
        updated: item.updatedAt.toISOString(),
      });
    }
  }
  styleHeader(sheet);
}

async function buildExpensesSheet(wb, range) {
  const newest = await prisma.expense.findMany({
    where: range ? { date: { gte: range.start, lt: range.end } } : {},
    include: { location: { select: { code: true } } },
    orderBy: { date: "desc" },
    take: MAX_EXPORT_ROWS + 1,
  });
  const truncated = newest.length > MAX_EXPORT_ROWS;
  const expenses = newest.slice(0, MAX_EXPORT_ROWS).reverse();
  const sheet = wb.addWorksheet("Expenses");
  sheet.columns = [
    { header: "Date", key: "date", width: 12 },
    { header: "Vendor", key: "vendor", width: 26 },
    { header: "Cart", key: "cart", width: 10 },
    { header: "Amount", key: "amount", width: 12 },
    { header: "Source", key: "source", width: 9 },
    { header: "Note", key: "note", width: 40 },
  ];
  let sum = 0;
  for (const e of expenses) {
    sum += e.amount;
    sheet.addRow({
      date: manilaDayKey(e.date),
      vendor: e.vendor,
      cart: e.location?.code ?? "",
      amount: e.amount,
      source: e.source,
      note: e.note ?? "",
    });
  }
  sheet.addRow({});
  sheet.addRow({ vendor: "TOTAL", amount: Number(sum.toFixed(2)) });
  styleHeader(sheet);
  return truncated;
}

async function buildShiftsSheet(wb, range) {
  const newest = await prisma.shift.findMany({
    where: range ? { ts: { gte: range.start, lt: range.end } } : {},
    include: { location: { select: { code: true } } },
    orderBy: { ts: "desc" },
    take: MAX_EXPORT_ROWS + 1,
  });
  const truncated = newest.length > MAX_EXPORT_ROWS;
  const shifts = newest.slice(0, MAX_EXPORT_ROWS).reverse();
  const sheet = wb.addWorksheet("Shifts");
  sheet.columns = [
    { header: "Date/Time", key: "ts", width: 20 },
    { header: "Staff", key: "staff", width: 22 },
    { header: "RFID UID", key: "uid", width: 14 },
    { header: "Event", key: "event", width: 7 },
    { header: "Cart", key: "cart", width: 10 },
  ];
  for (const s of shifts) {
    sheet.addRow({
      ts: s.ts.toISOString().slice(0, 16).replace("T", " "),
      staff: s.staffName ?? "(unregistered)",
      uid: s.staffUid,
      event: s.event,
      cart: s.location.code,
    });
  }
  styleHeader(sheet);
  return truncated;
}

async function buildProductsSheet(wb) {
  const [products, flavors] = await Promise.all([
    prisma.product.findMany({ orderBy: { name: "asc" } }),
    prisma.flavor.findMany(),
  ]);
  const flavorName = new Map(flavors.map((f) => [f.id, f.name]));
  const sheet = wb.addWorksheet("Products");
  sheet.columns = [
    { header: "Name", key: "name", width: 22 },
    { header: "Category", key: "category", width: 14 },
    { header: "Base Price", key: "basePrice", width: 11 },
    { header: "Flavors", key: "flavors", width: 30 },
    // Optional columns (the importer reads them by header name, so a workbook
    // with only the first four columns still imports).
    { header: "Cost", key: "cost", width: 11 },
    { header: "Option Prices", key: "optionPrices", width: 30 },
  ];
  for (const p of products) {
    const flavorPrices = p.flavorPrices ?? {};
    sheet.addRow({
      name: p.name,
      category: p.category,
      basePrice: p.basePrice,
      flavors: (p.flavorIds ?? []).map((id) => flavorName.get(id) ?? id).join("; "),
      cost: p.cost ?? null,
      optionPrices: Object.entries(flavorPrices)
        .map(([name, price]) => `${name}=${price}`)
        .join("; "),
    });
  }
  styleHeader(sheet);
}

// GET /api/export/:dataset?month=YYYY-MM&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
router.get(
  "/export/:dataset",
  requireAuth,
  requireRole("OWNER"),
  async (req, res, next) => {
  try {
    const { dataset } = req.params;
    const month = req.query.month ? String(req.query.month) : undefined;
    const startDate = req.query.startDate ? String(req.query.startDate) : undefined;
    const endDate = req.query.endDate ? String(req.query.endDate) : undefined;
    const { range, error } = resolveRange({ month, startDate, endDate });
    if (error) return res.status(400).json({ error });
    const wb = new ExcelJS.Workbook();
    wb.creator = "CartIQ";
    let truncated = false;

    switch (dataset) {
      case "sales":
        truncated = await buildSalesSheet(wb, range);
        break;
      case "inventory":
        await buildInventorySheet(wb);
        break;
      case "expenses":
        truncated = await buildExpensesSheet(wb, range);
        break;
      case "shifts":
        truncated = await buildShiftsSheet(wb, range);
        break;
      case "products":
        await buildProductsSheet(wb);
        break;
      default:
        return res.status(404).json({ error: `Unknown dataset "${dataset}" (sales|inventory|expenses|shifts|products)` });
    }

    const suffix = month
      ? `-${month}`
      : startDate && endDate
        ? `-${startDate}-to-${endDate}`
        : "";
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="cartiq-${dataset}${suffix}.xlsx"`
    );
    if (truncated) {
      res.setHeader("X-Export-Truncated", "true");
    }
    const buffer = await wb.xlsx.writeBuffer();
    return res.send(Buffer.from(buffer));
  } catch (err) {
    return next(err);
  }
  }
);

// ---------------- product bulk import ----------------

// Expected columns: name* | category | basePrice* | flavors ("Cheese;BBQ")
router.post(
  "/import/products",
  requireAuth,
  requireRole("OWNER"),
  upload.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Attach an .xlsx file in the "file" field' });
      const commit = req.query.dry_run === "false";

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(req.file.buffer);
      const sheet = wb.worksheets[0];
      if (!sheet) return res.status(400).json({ error: "Workbook has no sheets" });
      if (sheet.rowCount - 1 > 2000) {
        return res.status(400).json({ error: "max 2000 data rows per import" });
      }

      const errors = [];
      const validRows = [];
      const seenNames = new Set();

      const existingProducts = new Set(
        (await prisma.product.findMany({ select: { name: true } })).map((p) => p.name.toLowerCase())
      );
      const existingFlavors = new Map(
        (await prisma.flavor.findMany()).map((f) => [f.name.toLowerCase(), f.id])
      );

      // Optional columns are read by HEADER NAME, so a workbook with only the
      // original four columns still imports.
      const headerIndex = new Map();
      sheet.getRow(1).eachCell((cell, col) => {
        const header = String(cell.value ?? "").trim().toLowerCase();
        if (header) headerIndex.set(header, col);
      });
      const columnFor = (...names) => {
        for (const n of names) {
          const col = headerIndex.get(n);
          if (col) return col;
        }
        return 0;
      };
      const costCol = columnFor("cost");
      const optionPricesCol = columnFor("option prices", "optionprices", "flavor prices");

      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // header
        const name = String(row.getCell(1).value ?? "").trim();
        const category = String(row.getCell(2).value ?? "").trim() || "Fries";
        const basePriceRaw = row.getCell(3).value;
        const flavorsRaw = String(row.getCell(4).value ?? "").trim();
        const costRaw = costCol ? row.getCell(costCol).value : null;
        const optionPricesRaw = optionPricesCol
          ? String(row.getCell(optionPricesCol).value ?? "").trim()
          : "";

        if (!name) {
          errors.push({ row: rowNumber, reason: "missing name" });
          return;
        }
        if (seenNames.has(name.toLowerCase()) || existingProducts.has(name.toLowerCase())) {
          errors.push({ row: rowNumber, reason: `duplicate or existing product "${name}"` });
          return;
        }
        const basePrice = Number(basePriceRaw);
        if (!Number.isFinite(basePrice) || basePrice <= 0) {
          errors.push({ row: rowNumber, reason: `invalid basePrice "${basePriceRaw}"` });
          return;
        }
        const flavorNames = splitFlavorCell(flavorsRaw);
        const optionPrices = splitOptionPricesCell(optionPricesRaw);
        // The cost is optional: an empty cell means "unknown cost".
        const { cost, reason: costReason } = parseCostCell(costRaw);
        if (costReason) {
          errors.push({ row: rowNumber, reason: costReason });
          return;
        }
        // DoS/size caps (name/category/price/flavor bounds mirror
        // routes/products.js) plus the cost and per-option price rules.
        // Rejections land in errors[] so commit stays blocked until the file
        // is fixed.
        const capReason = validateProductRow({
          name,
          category,
          basePrice,
          flavorNames,
          cost,
          optionPrices,
        });
        if (capReason) {
          errors.push({ row: rowNumber, reason: capReason });
          return;
        }
        // Key the prices by the flavor's spelling in the sheet, so the price
        // still matches when the cell used different casing.
        const optionPricesByName = {};
        for (const [optionName, price] of Object.entries(optionPrices)) {
          const match = flavorNames.find(
            (f) => f.toLowerCase() === optionName.toLowerCase()
          );
          if (match) optionPricesByName[match] = price;
        }
        seenNames.add(name.toLowerCase());
        validRows.push({
          row: rowNumber,
          name,
          category,
          basePrice,
          flavorNames,
          cost,
          optionPrices: optionPricesByName,
        });
      });

      const result = {
        rows_total: sheet.rowCount - 1,
        valid_count: validRows.length,
        errors,
        committed: false,
      };

      if (commit && errors.length === 0 && validRows.length > 0) {
        for (const r of validRows) {
          const flavorIds = [];
          for (const fname of r.flavorNames) {
            const key = fname.toLowerCase();
            let id = existingFlavors.get(key);
            if (!id) {
              const created = await prisma.flavor.create({ data: { name: fname } });
              existingFlavors.set(key, created.id);
              id = created.id;
            }
            flavorIds.push(id);
          }
          await prisma.product.create({
            data: {
              name: r.name,
              category: r.category,
              basePrice: r.basePrice,
              // Firestore port: M2M flavors are stored as flavorIds on the
              // product doc (was Prisma `flavors: { connect: [...] }`).
              ...(flavorIds.length ? { flavorIds } : {}),
              // The per-option prices (Medium / Large / XL 40 / XL 50) and the
              // cost, both optional columns of the sheet.
              ...(Object.keys(r.optionPrices ?? {}).length
                ? { flavorPrices: r.optionPrices }
                : {}),
              ...(r.cost !== null && r.cost !== undefined ? { cost: r.cost } : {}),
            },
          });
          existingProducts.add(r.name.toLowerCase());
        }
        result.committed = true;
      } else if (commit && errors.length > 0) {
        result.error = "cannot commit: fix validation errors first";
      }

      return res.json(result);
    } catch (err) {
      if (err.message?.includes("Can't find end of central directory")) {
        return res.status(400).json({ error: "File is not a valid .xlsx workbook" });
      }
      return next(err);
    }
  }
);

export default router;
