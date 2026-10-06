// CartIQ API - one-command emulator boot for local demos.
// Usage: npm run dev:emulator
// Loads api/.env.emulator (dummy secrets, no quota), then boots src/server.js.
// FIRESTORE_EMULATOR_HOST is checked FIRST in src/firestore.js, so the prod
// service-account key in api/.env is never touched while this is set.
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Load the emulator env WITHOUT overriding anything already exported in shell.
dotenv.config({ path: path.join(here, "..", ".env.emulator") });

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";
process.env.JWT_SECRET ||= "emulator-demo-secret-not-for-prod";
process.env.JWT_REFRESH_SECRET ||= "emulator-demo-refresh-not-for-prod";
process.env.HOST ||= "0.0.0.0";
process.env.PORT ||= "4000";

console.log(`[demo] emulator=${process.env.FIRESTORE_EMULATOR_HOST} api=http://${process.env.HOST}:${process.env.PORT}`);
await import("../src/server.js");
