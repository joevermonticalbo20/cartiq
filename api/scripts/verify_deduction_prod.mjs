// Live stock-deduction smoke check against the production API.
//
// Creates a throwaway OWNER user, places ONE real order on CART-01
// (Cheese Fries / XL 50 x1 + Chili Cheese Fries / Medium x2), asserts the
// size pouches + frozen packs + powders deducted by the recipe amounts,
// then VOIDS the order (which restores the stock) and deletes the user.
// The voided order stays in history with reason "stock verification".
//
//   node scripts/verify_deduction_prod.mjs
import "dotenv/config";
import bcrypt from "bcryptjs";
import { db } from "../src/firestore.js";

const API = "https://ezynbxzarxozzmwqdjxs.supabase.co/functions/v1/api";
const USERNAME = "zz-stock-check";
const PASSWORD = "StockCheck#2026";
const CART = "CART-01";

let userId = null;
let failures = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};
const approx = (a, b, eps = 1e-6) => Math.abs(Number(a) - Number(b)) < eps;

async function api(path, { token, ...opts } = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function stockOf(locationId) {
  const rows = await db.inventoryItem.findMany({ where: { locationId } });
  return new Map(rows.map((r) => [r.name, Number(r.stock)]));
}

try {
  const existing = await db.users.findUnique({ where: { username: USERNAME } });
  if (existing) await db.users.delete({ where: { id: existing.id } });

  const created = await db.users.create({
    data: {
      name: "Stock Check (temp)",
      username: USERNAME,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      role: "OWNER",
      active: true,
      locationId: null,
      email: null,
      rfidUid: null,
    },
  });
  userId = created.id;

  const cart = await db.location.findUnique({ where: { code: CART } });
  if (!cart) throw new Error(`location ${CART} not found`);

  const login = await api("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!login.body?.token) throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
  const token = login.body.token;

  const before = await stockOf(cart.id);

  const order = await api("/orders", {
    method: "POST",
    token,
    body: JSON.stringify({
      clientRef: `stock-verify-${Date.now()}`,
      locationCode: CART,
      status: "PAID",
      paymentMethod: "CASH",
      items: [
        { productName: "Cheese Fries", flavor: "XL 50", qty: 1, unitPrice: 50 },
        { productName: "Chili Cheese Fries", flavor: "Medium", qty: 2, unitPrice: 20 },
      ],
    }),
  });
  check("order placed (201)", order.status === 201, `got ${order.status} ${JSON.stringify(order.body)?.slice(0, 200)}`);
  const orderId = order.body?.order?.id;

  const after = await stockOf(cart.id);
  const delta = (name) => Number(after.get(name)) - Number(before.get(name));
  check("XL 50 deducts 1 Pouch XL", approx(delta("Pouch XL"), -1), `delta ${delta("Pouch XL")}`);
  check("Medium x2 deducts 2 Pouch Medium", approx(delta("Pouch Medium"), -2), `delta ${delta("Pouch Medium")}`);
  check("frozen packs deduct 0.15", approx(delta("Fries (frozen packs)"), -0.15), `delta ${delta("Fries (frozen packs)")}`);
  check("Cheese Powder deducts 0.015 kg", approx(delta("Cheese Powder"), -0.015), `delta ${delta("Cheese Powder")}`);
  check("Chili Cheese Powder deducts 0.030 kg", approx(delta("Chili Cheese Powder"), -0.03), `delta ${delta("Chili Cheese Powder")}`);
  check("Pouch Large untouched", approx(delta("Pouch Large"), 0), `delta ${delta("Pouch Large")}`);

  if (orderId) {
    const voided = await api(`/orders/${orderId}`, {
      method: "PATCH",
      token,
      body: JSON.stringify({ status: "VOID", reason: "stock verification" }),
    });
    check("order voided (200)", voided.status === 200, `got ${voided.status} ${JSON.stringify(voided.body)?.slice(0, 200)}`);
    check("void reported no restore warnings", Array.isArray(voided.body?.warnings) && voided.body.warnings.length === 0,
      JSON.stringify(voided.body?.warnings));

    const restored = await stockOf(cart.id);
    let allRestored = true;
    for (const name of ["Pouch XL", "Pouch Medium", "Fries (frozen packs)", "Cheese Powder", "Chili Cheese Powder"]) {
      if (!approx(restored.get(name), before.get(name))) {
        allRestored = false;
        console.log(`       not restored: ${name} ${before.get(name)} -> ${restored.get(name)}`);
      }
    }
    check("void restores every deducted stock", allRestored);
  }
} finally {
  if (userId !== null) {
    await db.users.delete({ where: { id: userId } });
    const gone = await db.users.findUnique({ where: { username: USERNAME } });
    console.log(gone ? `!! temp user ${USERNAME} still present` : `(temp user ${USERNAME} removed)`);
  }
  await db.$disconnect();
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
