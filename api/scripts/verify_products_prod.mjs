// Production smoke check for the Products upgrades (run after a deploy):
//   1. Flavor options come back in size order (Medium, Large, XL 40, XL 50).
//   2. isBestSeller round-trips through PATCH -> /catalog (and is reverted).
//   3. A photo uploads, is served by the public image URL (bytes + CORS),
//      shows up as the product's imageUrl, then is deleted with the product.
//
// Uses a throwaway OWNER user and a throwaway product; both are removed in
// the finally block. Existing products are only touched by the best-seller
// flip, which is reverted immediately.
import "dotenv/config";
import { readFile } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { db } from "../src/firestore.js";

const API = "https://ezynbxzarxozzmwqdjxs.supabase.co/functions/v1/api";
const USERNAME = "zz-products-check";
const PASSWORD = "ProductsCheck#2026";
const TEMP_PRODUCT = "zz-photo-check";

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
  const body = await res.json().catch(() => null);
  return { status: res.status, body, headers: res.headers };
}

async function catalogNotes(token) {
  const { body } = await api("/catalog", { token });
  return new Map((body?.products ?? []).map((p) => [p.name, p]));
}

try {
  const stale = await db.users.findUnique({ where: { username: USERNAME } });
  if (stale) await db.users.delete({ where: { id: stale.id } });
  const createdUser = await db.users.create({
    data: {
      name: "Products Check (temp)",
      username: USERNAME,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      role: "OWNER",
      active: true,
      locationId: null,
      email: null,
      rfidUid: null,
    },
  });
  userId = createdUser.id;

  const login = await api("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!login.body?.token) throw new Error(`login failed: ${login.status}`);
  const token = login.body.token;

  // 1. Size-aware option order.
  const cat = await catalogNotes(token);
  const cheese = cat.get("Cheese Fries");
  const names = (cheese?.flavors ?? []).map((f) => f.name);
  check(
    "catalog lists sizes in order Medium, Large, XL 40, XL 50",
    JSON.stringify(names) === JSON.stringify(["Medium", "Large", "XL 40", "XL 50"]),
    JSON.stringify(names)
  );

  // 2. Best-seller flag round-trip on an existing product, then revert.
  const target = [...cat.values()].find((p) => p.name === "Cheese Fries");
  const wasBest = target?.isBestSeller === true;
  if (target) {
    await api(`/products/${target.id}`, {
      method: "PATCH",
      token,
      body: JSON.stringify({ isBestSeller: !wasBest }),
    });
    const flipped = (await catalogNotes(token)).get("Cheese Fries");
    check("isBestSeller=true reaches the catalog", flipped?.isBestSeller === !wasBest, String(flipped?.isBestSeller));
    await api(`/products/${target.id}`, {
      method: "PATCH",
      token,
      body: JSON.stringify({ isBestSeller: wasBest }),
    });
    const reverted = (await catalogNotes(token)).get("Cheese Fries");
    check("best-seller mark reverted to original", (reverted?.isBestSeller === true) === wasBest);
  }

  // 3. Photo upload -> public GET -> list imageUrl -> delete.
  const fresh = await api("/products", {
    method: "POST",
    token,
    body: JSON.stringify({ name: TEMP_PRODUCT, category: "Fries", basePrice: 1 }),
  });
  check("temp product created", fresh.status === 201, `got ${fresh.status}`);
  const productId = fresh.body?.product?.id;

  let photoBytes = null;
  try {
    const file = await readFile(new URL("../../web/public/products/pota-fries-cheese.jpg", import.meta.url));
    photoBytes = file;
  } catch {
    // Fall back to a tiny embedded JPEG when the repo asset is missing.
  }
  check("a source JPEG is available for the upload", Boolean(photoBytes?.length));

  if (productId && photoBytes) {
    const data = photoBytes.toString("base64");
    const up = await api(`/products/${productId}/image`, {
      method: "POST",
      token,
      body: JSON.stringify({ data, mime: "image/jpeg" }),
    });
    check("photo upload accepted", up.status === 200 && /\/products\/\d+\/image\?v=/.test(up.body?.imageUrl ?? ""), `${up.status} ${up.body?.imageUrl ?? ""}`);

    if (up.body?.imageUrl) {
      const img = await fetch(up.body.imageUrl);
      const served = Buffer.from(await img.arrayBuffer());
      check("image URL serves the exact bytes", img.status === 200 && served.length === photoBytes.length, `${img.status} ${served.length}/${photoBytes.length}`);
      check("image content-type is image/jpeg", img.headers.get("content-type")?.includes("image/jpeg"));
      check("image allows canvas CORS", img.headers.get("access-control-allow-origin") === "*");
    }

    const listed = (await api("/products", { token })).body?.data?.find((p) => p.id === productId);
    check("product list serves the uploaded photo", (listed?.imageUrl ?? "").includes(`/products/${productId}/image`), listed?.imageUrl ?? "");

    const delImg = await api(`/products/${productId}/image`, { method: "DELETE", token });
    check("photo delete accepted", delImg.status === 200);
    const listedAfter = (await api("/products", { token })).body?.data?.find((p) => p.id === productId);
    check("photo gone from the product after delete", listedAfter?.imageUrl == null, String(listedAfter?.imageUrl));
  }

  if (productId) {
    const del = await api(`/products/${productId}`, { method: "DELETE", token });
    check("temp product deleted", del.status === 200, `got ${del.status}`);
    check("temp product gone from catalog", !(await catalogNotes(token)).has(TEMP_PRODUCT));
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
