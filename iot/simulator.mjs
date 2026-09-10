#!/usr/bin/env node
// CartIQ ESP32 Simulator - behaves exactly like the real firmware:
// posts weight batches to /api/iot/readings and RFID taps to /api/shifts
// using the same device-token auth. Lets the whole IoT pipeline run and be
// demoed before physical hardware arrives.
//
// Usage:
//   node simulator.mjs --cart CART-01 --token dev-CART-01-potafries
//   node simulator.mjs --help
//
// Options:
//   --base URL      API base (default http://127.0.0.1:4000/api)
//   --cart CODE     cart id embedded in payloads (default CART-01)
//   --token TOK     device token (default dev-CART-01-potafries)
//   --interval MS   milliseconds between reading ticks (default 5000)
//   --drain         drain fast so LOW_STOCK alerts trigger quickly
//   --uid HEX       staff card uid to tap (default 04A2B3C4)
//   --tap-every N   toggle IN/OUT every N ticks (default 6, 0 disables)

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

if (has("help")) {
  console.log("CartIQ ESP32 simulator. See source header for options.");
  process.exit(0);
}

const BASE = arg("base", "http://127.0.0.1:4000/api");
const CART = arg("cart", "CART-01");
const TOKEN = arg("token", "dev-CART-01-potafries");
const INTERVAL = Number(arg("interval", 5000));
const DRAIN = has("drain");
const UID = arg("uid", "04A2B3C4");
const TAP_EVERY = Number(arg("tap-every", 6));

let lpgKg = 11.0;
let binKg = 3.0;
let tick = 0;
let shiftOpen = false;

function stamp(label, obj) {
  console.log(`[${new Date().toLocaleTimeString()}] ${label}`, obj);
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    stamp("HTTP ERROR", { status: res.status, path, data });
    return null;
  }
  return data;
}

async function sendReadings() {
  // Simulated consumption per tick; --drain empties tanks fast for demos.
  const step = DRAIN ? 0.8 : Math.random() * 0.05;
  lpgKg = Math.max(0, lpgKg - step);
  binKg = Math.max(0, binKg - step * (DRAIN ? 2 : 0.4));
  const jitter = () => (Math.random() - 0.5) * 0.01;

  const readings = [
    { channel: "LPG_TANK", kg: Number((lpgKg + jitter()).toFixed(3)) },
    { channel: "CHEESE_BIN", kg: Number((binKg + jitter()).toFixed(3)) },
  ];
  const result = await post("/iot/readings", {
    cart_id: CART,
    device_id: `sim-${CART.toLowerCase()}`,
    readings,
  });
  if (result) {
    const lowCount = 0; // alerts are visible on the dashboard feed
    stamp(
      `readings OK (accepted=${result.accepted.length} rejected=${result.rejected.length})`,
      { lpg: readings[0].kg, bin: readings[1].kg }
    );
  }
}

async function maybeTapCard() {
  if (TAP_EVERY === 0 || tick % TAP_EVERY !== 0 || tick === 0) return;
  shiftOpen = !shiftOpen;
  const events = [{ staff_uid: UID, event: shiftOpen ? "IN" : "OUT" }];
  const result = await post("/shifts", { cart_id: CART, device_id: `sim-${CART.toLowerCase()}`, events });
  if (result) {
    stamp(`RFID ${events[0].event}`, { accepted: result.accepted });
  }
}

console.log(`CartIQ simulator -> ${BASE} as ${CART}`);
console.log(`interval=${INTERVAL}ms drain=${DRAIN} uid=${UID} tapEvery=${TAP_EVERY}`);
console.log("Press Ctrl+C to stop.\n");

await sendReadings();
setInterval(async () => {
  tick++;
  try {
    await sendReadings();
    await maybeTapCard();
  } catch (err) {
    stamp("network error (will retry)", err.message);
  }
}, INTERVAL);
