// CartIQ demo setup - seed the LOCAL emulator only. Never touches prod.
// Usage: npm run demo:setup
// Runs db:seed + 21-day history against 127.0.0.1:8080 with dummy secrets.
import { spawnSync } from "node:child_process";

const env = {
  ...process.env,
  FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080",
  JWT_SECRET: process.env.JWT_SECRET || "emulator-demo-secret-not-for-prod",
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET || "emulator-demo-refresh-not-for-prod",
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || "cartiq-8e46f",
};

function run(args) {
  console.log(`[demo:setup] node ${args.join(" ")}`);
  const r = spawnSync("node", args, { env, stdio: "inherit", cwd: new URL("..", import.meta.url) });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run(["scripts/seed_firestore.mjs"]);
run(["scripts/seed_history.mjs", "21", "--clean"]);
console.log("[demo:setup] done. Users: owner/owner123, staff01..03/staff123. API: http://127.0.0.1:4000/api/health");
