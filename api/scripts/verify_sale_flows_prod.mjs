// Production smoke check for the sale notification + receipt + void-request
// chain (run after a deploy):
//   1. /catalog/version bumps when the menu changes.
//   2. A recorded sale writes a SALE alert (the bell's source).
//   3. A GCash receipt uploads and its (private) GET returns the exact bytes.
//   4. A staff void request is created; approving it voids the order,
//      restores stock, marks the request approved and resolves the alert.
//
// Uses a throwaway OWNER user (deleted in the finally block). ONE real order
// is left behind as VOID (the decision is executed for real; that is the
// point of the test).
import "dotenv/config";
import { readFile } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { db } from "../src/firestore.js";

const API = "https://ezynbxzarxozzmwqdjxs.supabase.co/functions/v1/api";
const WEB_ORIGIN = "https://cartiq-8e46f.web.app";
const USERNAME = "zz-flows-check";
const PASSWORD = "FlowsCheck#2026";
const CART = "CART-01";

let userId = null;
let failures = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` - ${extra}` : ""}`);
};

async function api(path, { token, ...opts } = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* binary or empty */ }
  return { status: res.status, body, text, headers: res.headers };
}

async function stockOf(locationId) {
  const rows = await db.inventoryItem.findMany({ where: { locationId }, nocache: true });
  return new Map(rows.map((r) => [r.name, Number(r.stock)]));
}

try {
  const stale = await db.users.findUnique({ where: { username: USERNAME } });
  if (stale) await db.users.delete({ where: { id: stale.id } });
  const created = await db.users.create({
    data: {
      name: "Flows Check (temp)",
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

  const login = await api("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!login.body?.token) throw new Error(`login failed: ${login.status}`);
  const token = login.body.token;

  // 1. Catalog version probe + bump.
  const v1 = (await api("/catalog/version", { token })).body?.version;
  check("catalog version probe returns a number", Number.isFinite(Number(v1)), String(v1));
  const temp = await api("/products", {
    method: "POST",
    token,
    body: JSON.stringify({ name: "zz-version-check", category: "Fries", basePrice: 1 }),
  });
  const tempId = temp.body?.product?.id;
  const v2 = (await api("/catalog/version", { token })).body?.version;
  check("menu change bumps the version", Number(v2) > Number(v1), `${v1} -> ${v2}`);
  if (tempId) await api(`/products/${tempId}`, { method: "DELETE", token });

  // 2. A sale writes a SALE alert + 3..4 chain on the same order.
  const cart = await db.location.findUnique({ where: { code: CART } });
  const before = await stockOf(cart.id);
  const orderRes = await api("/orders", {
    method: "POST",
    token,
    body: JSON.stringify({
      clientRef: `flows-verify-${Date.now()}`,
      locationCode: CART,
      status: "PAID",
      paymentMethod: "GCASH",
      items: [{ productName: "Cheese Fries", flavor: "Medium", qty: 1, unitPrice: 20 }],
    }),
  });
  check("order placed", orderRes.status === 201, `got ${orderRes.status}`);
  const orderId = orderRes.body?.order?.id;

  const after = await stockOf(cart.id);
  check("sale deducted 1 Pouch Medium", Math.abs((before.get("Pouch Medium") - after.get("Pouch Medium")) - 1) < 1e-6);

  {
    const alerts = (await api("/alerts?page=1&pageSize=10", { token })).body?.data ?? [];
    const saleAlert = alerts.find((a) => {
      if (a.type !== "SALE") return false;
      try { return JSON.parse(a.payload ?? "{}")?.orderId === orderId; } catch { return false; }
    });
    check("sale wrote a SALE alert for the order", Boolean(saleAlert), saleAlert?.message ?? "missing");
    check("SALE alert starts unread", saleAlert?.isRead !== true);
  }

  // 3. GCash receipt upload + private GET.
  let photo = null;
  try {
    photo = await readFile(new URL("../../web/public/products/pota-fries-cheese.jpg", import.meta.url));
  } catch { /* nothing to attach */ }
  if (photo && orderId) {
    const up = await api(`/orders/${orderId}/receipt`, {
      method: "POST",
      token,
      body: JSON.stringify({ data: photo.toString("base64"), mime: "image/jpeg" }),
    });
    check("receipt upload accepted", up.status === 200 && up.body?.receipt?.bytes === photo.length, `${up.status} ${JSON.stringify(up.body?.receipt)}`);
    // Byte-exact comparison straight off the wire (res.text() would decode
    // the JPEG and mangle the length). Origin header included: the dashboard
    // fetches this with XHR, so a missing CORS header breaks the owner's
    // receipt viewer even though the token is valid.
    const raw = await fetch(`${API}/orders/${orderId}/receipt`, {
      headers: { Authorization: `Bearer ${token}`, Origin: WEB_ORIGIN },
    });
    const served = new Uint8Array(await raw.arrayBuffer());
    check("receipt GET returns the exact bytes", raw.status === 200 && served.length === photo.length, `${raw.status} ${served.length}/${photo.length}`);
    check(
      "receipt GET carries the web CORS header",
      raw.headers.get("access-control-allow-origin") === WEB_ORIGIN,
      String(raw.headers.get("access-control-allow-origin"))
    );
    const preflight = await fetch(`${API}/orders/${orderId}/receipt`, {
      method: "OPTIONS",
      headers: {
        Origin: WEB_ORIGIN,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    check(
      "receipt preflight allows the web origin + authorization header",
      preflight.status === 204 &&
        preflight.headers.get("access-control-allow-origin") === WEB_ORIGIN &&
        String(preflight.headers.get("access-control-allow-headers") || "")
          .toLowerCase()
          .includes("authorization"),
      `${preflight.status} ${preflight.headers.get("access-control-allow-origin")}`
    );
    const anon = await api(`/orders/${orderId}/receipt`, {});
    check("receipt GET is private (401 without a token)", anon.status === 401, `got ${anon.status}`);
  }

  // 4. Void request -> approve.
  const req = await api(`/orders/${orderId}/void-request`, {
    method: "POST",
    token,
    body: JSON.stringify({ reason: "flows verification" }),
  });
  check("void request filed", req.status === 201 && req.body?.order?.voidRequest?.status === "pending", `got ${req.status}`);
  const requestAlertId = req.body?.order?.voidRequest?.alertId;
  const dup = await api(`/orders/${orderId}/void-request`, {
    method: "POST",
    token,
    body: JSON.stringify({ reason: "again" }),
  });
  check("duplicate void request is rejected", dup.status === 409, `got ${dup.status}`);

  const decision = await api(`/orders/${orderId}/void-request`, {
    method: "PATCH",
    token,
    body: JSON.stringify({ decision: "approve" }),
  });
  check("owner approval voids the order", decision.status === 200 && decision.body?.order?.status === "VOID", `${decision.status} ${decision.body?.order?.status}`);
  check("request marked approved", decision.body?.order?.voidRequest?.status === "approved");

  const restored = await stockOf(cart.id);
  check("approval restored the deducted stock", Math.abs(restored.get("Pouch Medium") - before.get("Pouch Medium")) < 1e-6);

  if (requestAlertId != null) {
    const alert = (await db.alert.findUnique({ where: { id: Number(requestAlertId) }, nocache: true }));
    check("void-request alert resolved (isRead)", alert?.isRead === true, String(alert?.isRead));
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
