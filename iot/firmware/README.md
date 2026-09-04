# CartIQ ESP32 IoT Node

Firmware for the RFID + load-cell node described in the approved proposal
(Section X). One node per cart; validate the **CART-01 prototype first**, then
replicate.

## Libraries (Arduino IDE → Library Manager)

| Library | Author | Purpose |
|---|---|---|
| MFRC522 | GithubCommunity | RC522 RFID reader |
| HX711 | bogde | Load-cell ADC |
| ArduinoJson | Benoit Blanchon | Batch payloads |
| WiFi / HTTPClient | built-in (ESP32 core) | Local sync |

ESP32 board support: install **esp32 by Espressif Systems** via Boards Manager.

## Wiring quick reference

- **RC522**: 3.3V ONLY. SDA→GPIO5, SCK→GPIO18, MOSI→GPIO23, MISO→GPIO19, RST→GPIO22, GND→GND.
- **HX711 #1 (LPG tank platform)**: DT→GPIO32, SCK→GPIO33, VCC→VIN 5V, GND→GND.
- **HX711 #2 (cheese bin mount)**: DT→GPIO25, SCK→GPIO26.
- Status LED on GPIO2 (onboard).

> Pin source of truth is `config.example.h` (`BIN_DT_PIN 25`, `BIN_SCK_PIN 26`).
> Firmware sends FIFO in chronological order: shifts one-per-POST to `/shifts`,
> readings batched up to 10-per-POST to `/iot/readings` (base URL keeps trailing `/api`).

## Setup

1. `cp config.example.h config.h`, fill Wi-Fi, API base URL (LAN IP of the PC running `api/`), device IDs.
2. Flash to the ESP32 DevKit, open Serial Monitor at 115200.
3. Tap a card → `Shift event queued: <uid>` appears; readings sample every 10 min and flush every 30 s when online.

## Safety notes (from proposal Section X)

- The LPG tank simply rests on an external platform — **no modification of tank, valve, or regulator**.
- Weekly tare calibration; refill-reset after each gas/powder refill.
- Accuracy target ±5%; drift beyond that raises a maintenance alert.

## Offline behavior

Events/readings buffer in RAM (`BUF_SIZE` slots) in chronological (FIFO) order.
Phase 2 upgrades buffering to Preferences/NVS so records survive power loss,
then uploads in batches with original timestamps whenever Wi-Fi is reachable.
Until then, power loss drops the RAM buffer — refill/reset and re-tap after outages.

## Hardware ops (pilot)

- **Wi-Fi provisioning:** edit `config.h` (`WIFI_SSID`/`WIFI_PASS`), reflash. No portal.
- **LAN target:** `API_BASE_URL=http://<PC_LAN_IP>:4000/api` (`ipconfig` on the API PC),
  API must run with `HOST=0.0.0.0` + Windows Firewall TCP 4000 allow.
- **Tokens:** dev tokens printed by `npm run db:seed` (`dev-CART-0x-potafries`); rotate
  for deployment by updating the `Device` row hash + `API_DEVICE_TOKEN`, reflash.
- **Install/tare:** mount cells, power on with empty platform to auto-tare (see `setup()`),
  then place tank/bin. Weekly re-tare; refill-reset after each gas/powder refill.
- **Calibration:** adjust `CAL_FACTOR_LPG`/`CAL_FACTOR_BIN` with a known weight
  (measured / raw), target ±5%.
- **Multi-cart:** validate CART-01 first, then duplicate node with new `DEVICE_ID`,
  `DEVICE_CART_ID`, and token.
