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
- **HX711 #2 (cheese bin mount)**: DT→GPIO26, SCK→GPIO25.
- Status LED on GPIO2 (onboard).

## Setup

1. `cp config.example.h config.h`, fill Wi-Fi, API base URL (LAN IP of the PC running `api/`), device IDs.
2. Flash to the ESP32 DevKit, open Serial Monitor at 115200.
3. Tap a card → `Shift event queued: <uid>` appears; readings sample every 10 min and flush every 30 s when online.

## Safety notes (from proposal Section X)

- The LPG tank simply rests on an external platform — **no modification of tank, valve, or regulator**.
- Weekly tare calibration; refill-reset after each gas/powder refill.
- Accuracy target ±5%; drift beyond that raises a maintenance alert.

## Offline behavior

Events/readings buffer in RAM (`BUF_SIZE` slots). Phase 2 upgrades buffering to
Preferences/NVS so records survive power loss, then uploads in batches with
original timestamps whenever Wi-Fi is reachable.
