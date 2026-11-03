// One-off production smoke check for the Pota Fries catalog.
// Creates a throwaway STAFF user, logs in through the live Edge API, reads
// /catalog, asserts the menu payload, then DELETES the user (finally block).
import "dotenv/config";
import bcrypt from "bcryptjs";
import { db } from "../src/firestore.js";

const API = "https://ezynbxzarxozzmwqdjxs.supabase.co/functions/v1/api";
const USERNAME = "zz-catalog-check";
const PASSWORD = "CatalogCheck#2026";

let userId = null;
let failures = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

try {
  const existing = await db.users.findUnique({ where: { username: USERNAME } });
  if (existing) {
    await db.users.delete({ where: { id: existing.id } });
    console.log(`(removed stray ${USERNAME})`);
  }
  const created = await db.users.create({
    data: {
      name: "Catalog Check (temp)",
      username: USERNAME,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      role: "STAFF",
      active: true,
      locationId: null,
      email: null,
      rfidUid: null,
    },
  });
  userId = created.id;

  const loginRes = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  const login = await loginRes.json();
  if (!loginRes.ok || !login.token) {
    console.log("login failed:", loginRes.status, JSON.stringify(login));
    process.exitCode = 1;
  } else {
    const catRes = await fetch(`${API}/catalog`, {
      headers: { Authorization: `Bearer ${login.token}` },
    });
    const cat = await catRes.json();
    const products = cat.products ?? [];
    const byName = new Map(products.map((p) => [p.name, p]));
    console.log(`catalog: ${products.length} product(s), status ${catRes.status}`);

    const expected = [
      "Cheese Fries", "Chili Cheese Fries", "BBQ Fries", "Chili BBQ Fries",
      "Caramel Fries", "Sweet Corn Fries", "Sour Cream Fries", "Honey Butter Fries",
      "Cheese Dip", "Garlic Mayo Dip", "Barbecue Dip",
    ];
    for (const name of expected) check(`catalog has "${name}"`, byName.has(name));

    const cheese = byName.get("Cheese Fries");
    if (cheese) {
      check("photo URL is absolute", /^https:\/\/cartiq-8e46f\.web\.app\/products\/pota-fries-cheese\.jpg$/.test(cheese.imageUrl ?? ""), cheese.imageUrl);
      const sizes = new Map((cheese.flavors ?? []).map((f) => [f.name, f.unitPrice]));
      check("Medium P20", sizes.get("Medium") === 20, String(sizes.get("Medium")));
      check("Large P30", sizes.get("Large") === 30, String(sizes.get("Large")));
      check("XL P40", sizes.get("XL") === 40, String(sizes.get("XL")));
      check("sizes available for sale", (cheese.flavors ?? []).every((f) => f.isAvailable === true));
    }
    const dip = byName.get("Cheese Dip");
    if (dip) {
      check("dip price P15", dip.basePrice === 15, String(dip.basePrice));
      check("dip category Add-ons", /add/i.test(dip.category ?? ""), dip.category);
    }
    check("legacy Flavored Fries hidden", !byName.has("Flavored Fries"));
    // Dips are text-only cards; only the 8 flavor products ship photos.
    const photoNames = expected.slice(0, 8);
    check("8 flavor products carry imageUrl", photoNames.every((n) => {
      const p = byName.get(n);
      return /^https:\/\//.test(p.imageUrl ?? "");
    }));
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
