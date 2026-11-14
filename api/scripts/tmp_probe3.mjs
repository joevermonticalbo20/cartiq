import "dotenv/config";
import { createHash } from "node:crypto";
import { db } from "../src/firestore.js";
const code = "123456";
const hash = createHash("sha256").update(code).digest("hex");
const rec = {
  userId: 2,
  email: "probe-owner@example.com",
  purpose: "verify",
  tokenHash: hash,
  expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  used: false,
  attempts: 0,
  createdAt: new Date(),
};
const created = await db.collection("passwordResets").add(rec);
console.log("probe record:", created.id, "hash", hash.slice(0, 12));
console.log(created.id);
process.exit(0);
