import "dotenv/config";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { initializeApp, getApps, applicationDefault, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "cartiq-8e46f";
if (getApps().length === 0) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)), projectId: PROJECT_ID });
  else initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID });
}
const fs = getFirestore();
const snap = await fs.collection("liveEvents").orderBy("id", "desc").limit(5).get();
console.log(`liveEvents docs: ${snap.size}`);
for (const d of snap.docs) {
  const x = d.data();
  console.log(`  id=${d.id} event=${x.event} payload=${String(x.payload).slice(0, 140)}`);
}
const c = await fs.collection("_counters").doc("liveEvents").get();
console.log(`counter: ${c.exists ? JSON.stringify(c.data()) : "(missing)"}`);
process.exit(0);
