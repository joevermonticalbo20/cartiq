// ============================================================
// CartIQ ESP32 IoT Node - v1 contract (matches iot/simulator.mjs)
//   - MFRC522 RFID reader  -> staff tap events -> /api/shifts
//   - HX711 load cells     -> weight readings  -> /api/iot/readings
//   - Offline buffering    -> batches upload when Wi-Fi returns
// LOCAL-ONLY: talks to http://<host-pc-lan-ip>:4000 on the LAN.
// ============================================================

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <SPI.h>
#include <MFRC522.h>
#include <HX711.h>
#include <time.h>
#include <Preferences.h>
#include "soc/rtc_cntl_reg.h"

#include "config.h"   // copy config.example.h -> config.h and fill in

// If a live WiFi link drops, wait this long for the AP to come back before
// switching to offline-use mode (taps queue in NVS until a replug).
#define WIFI_LOST_GRACE_MS 30000UL

// HX711 load cells are optional. Set USE_LOAD_CELLS to 0 in config.h for an
// RFID-only node.
//
// Why this must be a compile-time switch rather than a runtime is_ready() test:
// HX711::begin() defaults to doReset=true, which calls reset() -> power_up() ->
// read() -> wait_ready(). wait_ready() is `while (!is_ready()) delay(ms)` with
// NO timeout. With no load cell on the DOUT pin, the internal pull-up holds it
// HIGH, is_ready() never becomes true, and the node wedges forever during
// setup() - before it ever prints a single byte of log. Compile-time exclusion
// is the only thing that reliably prevents that.
#ifndef USE_LOAD_CELLS
#define USE_LOAD_CELLS 1
#endif

// Offline queue: NVS survives power loss, RAM does not. Kept small so a full
// serialized queue fits comfortably in the default NVS partition.
#define QUEUE_MAX        24
#define SHIFT_TTL_SEC    (12UL * 60UL * 60UL)

// The cart gets ONE 30-second WiFi attempt at boot. If the configured SSID is
// not found in that window it stays in offline-use mode: taps queue in NVS and
// are only pushed after the operator replugs the node (fresh boot attempt).
// No background retries — that keeps loop() free to read cards while offline.
#ifndef WIFI_CONNECT_TIMEOUT_MS
#define WIFI_CONNECT_TIMEOUT_MS 30000UL
#endif

MFRC522 rfid(SS_PIN, RST_PIN);
HX711 scaleLpg;
HX711 scaleBin;

struct Reading { String channel; float kg; unsigned long epoch; };
Reading readingBuf[BUF_SIZE];
int readingCount = 0;

struct ShiftEvent {
  String uid;
  time_t capturedAt;  // tap time; estimated when the clock was not NTP-synced
  String eventId;     // sync idempotency key; the server never writes the same tap twice
  bool approx;        // true when capturedAt came from the NVS clock estimate
  unsigned long tapMillis;  // uptime at tap, used to correct the stamp after NTP sync
  bool offline;       // WiFi was down at the moment of the tap
};
ShiftEvent shiftBuf[QUEUE_MAX];
int shiftCount = 0;
unsigned long droppedReadings = 0;
unsigned long droppedShifts = 0;

Preferences prefs;
time_t epochAnchor = 0;        // wall clock at anchorMillis
unsigned long anchorMillis = 0;
time_t clockDriftSec = 0;      // stale-anchor offset learned at NTP sync
bool clockTrusted = false;

unsigned long lastSample = 0;
unsigned long lastFlush = 0;
unsigned long lastServerHeartbeat = 0;
String lastUid = "";
unsigned long lastTapMs = 0;
unsigned long lastHeartbeat = 0;
unsigned long lastReaderCheck = 0;
unsigned long lastAnchorSave = 0;
unsigned long tapFlashUntil = 0;   // brief confirmation blink after a queued tap
unsigned long wifiLostAt = 0;      // when a live WiFi link dropped (0 = fine)
bool offlineMode = false;
bool wasWifiConnected = false;
bool readerOk = false;

// The RC522 can drop off the SPI bus after a power dip (a weak USB port is
// enough) and then every register read returns 0x00/0xFF. Keep trying instead
// of staying dead until someone power-cycles the cart.
bool initReader() {
  pinMode(SS_PIN, OUTPUT);
  digitalWrite(SS_PIN, HIGH);
  rfid.PCD_Init();
  delay(50);
  byte ver = rfid.PCD_ReadRegister(MFRC522::VersionReg);
  readerOk = (ver == 0x91 || ver == 0x92);
  Serial.printf("MFRC522 version: 0x%02X %s\n", ver,
                readerOk ? "(reader OK)" : "(no answer)");
  // Keep the RF field off until Wi-Fi is up. The antenna pulses pull the
  // marginal 3.3 V rail down and trip the brownout detector during the radio
  // bring-up. setup() turns it back on only after WiFi connects.
  rfid.PCD_AntennaOff();
  return readerOk;
}

void connectWifi() {
  Serial.println("[dbg] connectWifi start");

  // Turn the antenna off BEFORE touching the Wi-Fi driver. On a weak supply
  // the RF pulses are what trip the brownout detector ("E BOD") right here.
  rfid.PCD_AntennaOff();
  delay(3000); // let the 3.3 V rail recover before the radio powers up

  // Drop any in-flight attempt first. Calling begin() while the driver is still
  // associating is rejected with "wifi:sta is connecting, cannot set config".
  // Keep the stored config (no erase): erasing it makes the radio rescan,
  // and the scan + re-associate is a current spike this node cannot afford on
  // a marginal USB supply.
  WiFi.disconnect(false);
  Serial.println("[dbg] disconnect done");
  WiFi.mode(WIFI_STA);
  Serial.println("[dbg] mode done");
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.println("[dbg] begin done");
  // Lower the TX power. The router sits right next to the cart (-40 dBm), so a
  // full-power burst buys nothing — but it DOES pull the 3.3 V rail down on a
  // weak USB supply, and the brownout detector then reboots the node in the
  // middle of a request. 5 dBm is plenty for a next-to-the-cart router.
  WiFi.setTxPower(WIFI_POWER_5dBm);
  Serial.printf("Connecting to Wi-Fi ssid=\"%s\"", WIFI_SSID);
  // Radio is up now. Re-enable the reader immediately so an offline node can
  // still read taps while association is being retried.
  if (readerOk) rfid.PCD_AntennaOn();

  unsigned long start = millis();
  int lastStatus = (int)WiFi.status();
  while (millis() - start < WIFI_CONNECT_TIMEOUT_MS) {
    delay(400);
    int st = (int)WiFi.status();
    // Status codes: 0 idle, 1 no-ssid, 2 scan-done, 3 connected,
    // 4 connect-failed, 5 connection-lost, 6 disconnected.
    if (st != lastStatus) {
      Serial.printf(" [%d]", st);
      lastStatus = st;
      if (st == WL_CONNECTED) break;
    }
    Serial.print(".");
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nWi-Fi OK  ip=%s  rssi=%d dBm  gateway=%s\n",
                  WiFi.localIP().toString().c_str(), WiFi.RSSI(),
                  WiFi.gatewayIP().toString().c_str());
  } else {
    Serial.printf("\nWi-Fi unavailable (status %d) - OFFLINE MODE: taps will queue in NVS; replug to retry\n", (int)WiFi.status());
  }
  // The antenna was off for the radio bring-up (brownout protection). The
  // WiFi attempt is over now — turn it back on whether or not we connected,
  // otherwise an offline node can never read a card.
  if (readerOk) rfid.PCD_AntennaOn();
}

int postBatch(const char* path, const String& body) {
  HTTPClient http;
  http.setTimeout(15000);  // Edge cold starts can exceed the 5s default
  if (!http.begin(String(API_BASE_URL) + path)) {
    Serial.printf("POST %s -> begin failed\n", path);
    return -1;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + API_DEVICE_TOKEN);
  int code = http.POST(body);
  Serial.printf("POST %s -> %d\n", path, code);
  http.end();
  return code;
}

// One empty /shifts POST proves the device token and the HTTPS path without
// writing a shift: the API authenticates first, then rejects the empty events
// array with 400. This runs once at boot so the serial log says immediately
// whether the production API accepts this node.
void checkDeviceAuth() {
  String body = String("{\"cart_id\":\"") + DEVICE_CART_ID +
                "\",\"device_id\":\"" + DEVICE_ID + "\",\"events\":[]}";
  int code = postBatch("/shifts", body);
  if (code == 400) {
    Serial.println("API auth OK (400 = empty events rejected after auth)");
  } else if (code == 401 || code == 403) {
    Serial.println("API auth FAILED - check API_DEVICE_TOKEN");
  } else {
    Serial.printf("API check inconclusive: HTTP %d\n", code);
  }
}

String nowIso() {
  // Requires time sync (configNTP in setup); falls back to uptime if unset.
  time_t now = time(nullptr);
  if (now < 100000) return "";
  struct tm t;
  localtime_r(&now, &t);
  char buf[32];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S%z", &t);
  return String(buf);
}

void queueReading(const char* channel, float kg) {
  if (readingCount < BUF_SIZE) {
    readingBuf[readingCount++] = {channel, kg, millis()};
  } else {
    droppedReadings++;
    Serial.printf("reading buffer full - dropped %lu total\n", droppedReadings);
  }
}

bool flushShifts();

// --- NVS-backed offline queue ------------------------------------------------
static void saveQueue() {
  prefs.putUInt("count", (unsigned int)shiftCount);
  for (int i = 0; i < shiftCount; i++) {
    prefs.putString((String("u") + i).c_str(), shiftBuf[i].uid);
    prefs.putULong((String("t") + i).c_str(), (unsigned long)shiftBuf[i].capturedAt);
    prefs.putString((String("e") + i).c_str(), shiftBuf[i].eventId);
    prefs.putBool((String("a") + i).c_str(), shiftBuf[i].approx);
    prefs.putULong((String("m") + i).c_str(), shiftBuf[i].tapMillis);
    prefs.putBool((String("o") + i).c_str(), shiftBuf[i].offline);
  }
}

static void loadQueue() {
  shiftCount = (int)prefs.getUInt("count", 0);
  if (shiftCount < 0 || shiftCount > QUEUE_MAX) shiftCount = 0;
  for (int i = 0; i < shiftCount; i++) {
    shiftBuf[i].uid = prefs.getString((String("u") + i).c_str(), "");
    shiftBuf[i].capturedAt = (time_t)prefs.getULong((String("t") + i).c_str(), 0);
    shiftBuf[i].eventId = prefs.getString((String("e") + i).c_str(), "");
    shiftBuf[i].approx = prefs.getBool((String("a") + i).c_str(), false);
    shiftBuf[i].tapMillis = prefs.getULong((String("m") + i).c_str(), 0);
    shiftBuf[i].offline = prefs.getBool((String("o") + i).c_str(), true);
    if (shiftBuf[i].uid.length() == 0 || shiftBuf[i].eventId.length() == 0) {
      Serial.printf("[nvs] corrupt entry %d, queue truncated\n", i);
      shiftCount = i;
      break;
    }
  }
}

static void removeQueued(int n) {
  if (n <= 0) return;
  for (int i = n; i < shiftCount; i++) shiftBuf[i - n] = shiftBuf[i];
  shiftCount -= n;
  saveQueue();
}

// Wall clock at tap time. NTP is authoritative; between syncs (and across a
// power loss) we extrapolate from the last synced epoch plus uptime. The user
// accepts that this estimate is approximate — the `approx` flag records it.
static time_t estimatedEpoch() {
  if (clockTrusted) {
    time_t t = time(nullptr);
    if (t >= 1700000000) return t;
  }
  if (epochAnchor < 1700000000) return 0;
  unsigned long up = millis();
  long long delta = (long long)up - (long long)anchorMillis;
  if (delta < 0) delta = up;
  return (time_t)(epochAnchor + delta / 1000LL);
}

static void dropExpired() {
  time_t now = estimatedEpoch();
  if (now < 1700000000) return;  // no usable clock yet
  time_t cutoff = now - (time_t)SHIFT_TTL_SEC;
  int keep = 0;
  for (int i = 0; i < shiftCount; i++) {
    if (shiftBuf[i].capturedAt >= cutoff) {
      shiftBuf[keep++] = shiftBuf[i];
    } else {
      droppedShifts++;
      Serial.printf("Dropped expired tap %s\n", shiftBuf[i].eventId.c_str());
    }
  }
  if (keep != shiftCount) {
    shiftCount = keep;
    saveQueue();
  }
}

void queueShift(const String& uid) {
  if (uid == lastUid && millis() - lastTapMs < 30000) return;  // debounce
  lastUid = uid;
  lastTapMs = millis();

  // Capture the wall clock at tap time, not at flush time, so an offline
  // tap keeps its true occurrence once Wi-Fi returns.
  const time_t captured = estimatedEpoch();
  const bool approxTap = !clockTrusted;
  const bool offlineTap = WiFi.status() != WL_CONNECTED;
  // Sync idempotency key: the server never writes the same tap twice, no
  // matter how often a buffered event is re-posted.
  unsigned char randBytes[8];
  esp_fill_random(randBytes, sizeof(randBytes));
  char hex[17];
  for (int i = 0; i < 8; i++) sprintf(hex + i * 2, "%02x", randBytes[i]);
  String eventId = String(DEVICE_ID) + "-" + String((unsigned int)captured, HEX) + "-" + String(hex);

  dropExpired();
  if (shiftCount >= QUEUE_MAX) {
    // Drop the oldest so a full queue never blocks a new tap.
    for (int i = 1; i < shiftCount; i++) shiftBuf[i - 1] = shiftBuf[i];
    shiftCount--;
    droppedShifts++;
    Serial.println("Queue full - dropped oldest tap");
  }
  if (shiftCount < QUEUE_MAX) {
    shiftBuf[shiftCount++] = {uid, captured, eventId, approxTap, millis(), offlineTap};
    saveQueue();  // power-loss safe BEFORE the LED goes dark
  }
  // Confirm locally that the tap was recorded — no WiFi needed.
  tapFlashUntil = millis() + 600UL;
  // Blue LED goes OFF while the tap is being handed to the web. It only
  // comes back on steady once the server accepted every buffered event.
  digitalWrite(LED_PIN, LOW);
  Serial.printf("Tap queued for %s (eventId %s)\n", uid.c_str(), eventId.c_str());
  // Push the tap to the server immediately instead of waiting for the flush
  // interval, so the phone the person is holding hears back at once.
  if (WiFi.status() == WL_CONNECTED && flushShifts()) {
    digitalWrite(LED_PIN, HIGH);
  }
}

bool flushShifts() {
  const int BATCH = 10;
  dropExpired();
  while (shiftCount > 0) {
    JsonDocument doc;
    doc["cart_id"] = DEVICE_CART_ID;
    doc["device_id"] = DEVICE_ID;
    JsonArray events = doc["events"].to<JsonArray>();
    int n = shiftCount < BATCH ? shiftCount : BATCH;
    for (int i = 0; i < n; i++) {
      JsonObject e = events.add<JsonObject>();
      e["staff_uid"] = shiftBuf[i].uid;
      e["event"] = "next";  // the server decides IN vs OUT from attendance state
      e["eventId"] = shiftBuf[i].eventId;
      e["offline"] = shiftBuf[i].offline;
      // Offline taps used the stale NVS clock, which can be off by the entire
      // unplugged duration. Apply the NTP-learned drift to land on the real
      // wall-clock time of the tap — even across a reboot (millis() resets).
      if (shiftBuf[i].approx && clockDriftSec != 0) {
        shiftBuf[i].capturedAt += clockDriftSec;
        shiftBuf[i].approx = false;
      }
      e["time_approx"] = shiftBuf[i].approx;
      // Only send a timestamp when we have a plausible wall clock.
      if (shiftBuf[i].capturedAt >= 1700000000) {
        char buf[32];
        struct tm t;
        localtime_r(&shiftBuf[i].capturedAt, &t);
        strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S%z", &t);
        e["ts"] = String(buf);
      }
    }
    String body;
    serializeJson(doc, body);
    int code = postBatch("/shifts", body);
    if (code == 401 || code == 403) {
      Serial.printf("AUTH FAILED %d on /shifts - check API_DEVICE_TOKEN\n", code);
      return false;  // keep buffer, don't burn radio retrying a bad token
    }
    if (code >= 400 && code < 500) {
      // The server refuses these taps permanently (bad payload, deactivated
      // account...). Keeping them would repost them forever.
      Serial.printf("Permanent rejection %d on /shifts - dropped %d events\n", code, n);
      removeQueued(n);
      continue;
    }
    if (code < 200 || code >= 300) return false;  // server down or 5xx: retry later
    removeQueued(n);
  }
  return shiftCount == 0;
}

void flushReadings() {
  const int BATCH = 10;
  while (readingCount > 0) {
    JsonDocument doc;
    doc["cart_id"] = DEVICE_CART_ID;
    doc["device_id"] = DEVICE_ID;
    JsonArray arr = doc["readings"].to<JsonArray>();
    int n = readingCount < BATCH ? readingCount : BATCH;
    String ts = nowIso();
    for (int i = 0; i < n; i++) {
      JsonObject r = arr.add<JsonObject>();
      r["channel"] = readingBuf[i].channel;
      r["kg"] = serialized(String(readingBuf[i].kg, 3));
      if (ts.length() > 0) r["ts"] = ts;
    }
    String body;
    serializeJson(doc, body);
    int code = postBatch("/iot/readings", body);
    if (code == 401 || code == 403) {
      Serial.printf("AUTH FAILED %d on /iot/readings - check API_DEVICE_TOKEN\n", code);
      return;
    }
    if (code < 200 || code >= 300) return;
    for (int i = n; i < readingCount; i++) readingBuf[i - n] = readingBuf[i];
    readingCount -= n;
  }
}

void setup() {
  // This cart's USB supply dips below the brownout threshold the instant the
  // Wi-Fi radio powers up, which rebooted the node before it ever connected.
  // Keep the radio running; the proper fix is a beefier 5 V supply / a bulk
  // capacitor on the 3.3 V rail (see hardware notes in README).
  WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);

  Serial.begin(115200);
  delay(1500);   // let the USB-UART bridge settle before printing
  Serial.printf("CartIQ node %s (cart %s)\n", DEVICE_ID, DEVICE_CART_ID);
  Serial.printf("API base: %s\n", API_BASE_URL);
  pinMode(LED_PIN, OUTPUT);

  // Restore the offline queue saved in NVS (survives power loss).
  prefs.begin("cartiq", false);
  epochAnchor = (time_t)prefs.getULong("anchorEpoch", 0);
  clockDriftSec = (time_t)prefs.getLong("clockDrift", 0);
  anchorMillis = 0;  // the anchor is the wall clock at boot time
  loadQueue();
  Serial.printf("[nvs] restored %d queued tap(s), clock anchor %ld\n",
                shiftCount, (long)epochAnchor);

  // The cart's USB port is marginal: with the RFID reader on the 3.3 V rail
  // the Wi-Fi start-up dip trips the brownout detector and the node reboots
  // ("E BOD: Brownout detector was triggered"). Keep the stored config so the
  // radio does not rescan, and turn the TX power down (the router sits right
  // next to the cart).

  // SCK, MISO, MOSI. SS/CS stays -1 because the MFRC522 library drives GPIO5
  // itself. (The ESP32 core default is already -1; being explicit keeps this
  // correct if the core default ever changes.)
  SPI.begin(18, 19, 23, -1);
  for (int attempt = 1; attempt <= 3 && !initReader(); attempt++) {
    delay(300);
  }
  if (!readerOk) {
    Serial.println("Reader missing - will retry every 5s. Check wiring: "
                   "SDA->GPIO5, SCK->GPIO18, MOSI->GPIO23, MISO->GPIO19, "
                   "RST->GPIO22, 3.3V, GND.");
  }
#if USE_LOAD_CELLS
  scaleLpg.begin(LPG_DT_PIN, LPG_SCK_PIN);
  scaleBin.begin(BIN_DT_PIN, BIN_SCK_PIN);
  scaleLpg.set_scale(CAL_FACTOR_LPG);
  scaleBin.set_scale(CAL_FACTOR_BIN);
  if (scaleLpg.is_ready()) scaleLpg.tare();
  if (scaleBin.is_ready()) scaleBin.tare();
  Serial.println("load cells enabled");
#else
  // Never call begin() on an absent HX711: its internal reset blocks forever
  // on a floating DOUT pin. See the note above USE_LOAD_CELLS.
  Serial.println("load cells disabled - RFID only node");
#endif

  // NTP AFTER the network is up. Calling configTime() while the radio is still
  // down means the clock never syncs (NTP needs a route), and every buffered
  // shift would go out without a timestamp. Waiting for the first synced
  // time also keeps the TLS handshake (which checks the clock) sane.
  connectWifi();

  Serial.println("[dbg] before configTime");
  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER);
  for (int i = 0; i < 20 && time(nullptr) < 1700000000; i++) {
    delay(500);
  }
  Serial.println("[dbg] configTime done");
  time_t synced = time(nullptr);
  Serial.printf("[dbg] clock %ld\n", (long)synced);
  if (synced >= 1700000000) {
    // Apply the NTP truth to taps recorded before this sync. Those taps used
    // the stale NVS anchor (off by however long the board was unplugged), so
    // shift them by the difference between the real clock and our estimate.
    time_t estimated = estimatedEpoch();
    if (estimated >= 1700000000) {
      clockDriftSec = synced - estimated;
      prefs.putLong("clockDrift", (long)clockDriftSec);
      Serial.printf("[clock] drift %+lds corrected on queued offline taps\n",
                    (long)clockDriftSec);
    }
    clockTrusted = true;
    epochAnchor = synced;
    anchorMillis = millis();
    prefs.putULong("anchorEpoch", (unsigned long)epochAnchor);
    Serial.println("Clock synced - timestamps are exact");
  } else {
    clockTrusted = false;
    Serial.println("Clock NOT synced - offline taps will be flagged approximate");
  }

  if (WiFi.status() == WL_CONNECTED) {
    wasWifiConnected = true;
    // The antenna is back on after the WiFi attempt (online or offline).
    checkDeviceAuth();
  }
}

void loop() {
  // Track a live WiFi link dropping: give it 30s to come back, then switch to
  // offline-use mode. A fresh boot (replug) is the only thing that retries
  // after that — queued taps are pushed as soon as it reconnects.
  const bool linkUp = WiFi.status() == WL_CONNECTED;
  if (linkUp && !wasWifiConnected) {
    wasWifiConnected = true;
    offlineMode = false;
    wifiLostAt = 0;
    Serial.println("Wi-Fi link (re)established - online mode");
  } else if (!linkUp && wasWifiConnected && wifiLostAt == 0) {
    wasWifiConnected = false;
    wifiLostAt = millis();
    offlineMode = false;
    Serial.println("Wi-Fi link lost - waiting 30s for reconnect...");
  } else if (!linkUp && wifiLostAt > 0 && !offlineMode &&
             millis() - wifiLostAt >= WIFI_LOST_GRACE_MS) {
    offlineMode = true;
    Serial.println("Wi-Fi still down after 30s - OFFLINE MODE: taps will queue; replug to upload");
  }

  // Blue LED: a 2-blink confirmation right after a tap, then the normal state:
  // steady when online and nothing pending, slow blink while the queue still
  // has taps to deliver, OFF when offline with an empty queue.
  if (millis() < tapFlashUntil) {
    unsigned long elapsed = 600UL - (tapFlashUntil - millis());
    digitalWrite(LED_PIN, ((elapsed / 150UL) % 2UL == 0UL) ? HIGH : LOW);
  } else if (shiftCount > 0) {
    digitalWrite(LED_PIN, (millis() % 1500UL) < 150UL ? HIGH : LOW);
  } else if (WiFi.status() == WL_CONNECTED) {
    digitalWrite(LED_PIN, HIGH);
  } else {
    digitalWrite(LED_PIN, LOW);
  }

  if (!readerOk) {
    if (millis() - lastReaderCheck > 5000) {
      lastReaderCheck = millis();
      Serial.println("Reader retry...");
      initReader();
    }
  } else if (rfid.PICC_IsNewCardPresent()) {
    if (!rfid.PICC_ReadCardSerial()) {
      Serial.println("[rfid] card present, read failed");
    } else {
      String uid = "";
      uid.reserve(11);
      for (byte i = 0; i < rfid.uid.size; i++) {
        if (rfid.uid.uidByte[i] < 0x10) uid += "0";
        uid += String(rfid.uid.uidByte[i], HEX);
      }
      uid.toUpperCase();
      rfid.PICC_HaltA();
      queueShift(uid);
    }
  }

  if (millis() - lastHeartbeat > 5000) {
    lastHeartbeat = millis();
    byte tx = rfid.PCD_ReadRegister(MFRC522::TxControlReg);
    Serial.printf("[heartbeat] reader %s antenna=%02X (bits03=%u)\n",
                  readerOk ? "OK" : "MISSING", tx, (unsigned)(tx & 0x03));
  }

  // Keep the wall-clock anchor fresh so a power loss never rewinds the
  // estimate by hours. Saved every minute while running offline.
  if (!clockTrusted && epochAnchor >= 1700000000 &&
      millis() - lastAnchorSave > 60000UL) {
    lastAnchorSave = millis();
    epochAnchor = estimatedEpoch();
    anchorMillis = millis();
    prefs.putULong("anchorEpoch", (unsigned long)epochAnchor);
  }

  // Server liveness every 3s so the app flags a power/Wi-Fi loss within ~5s.
  // Each beat is a Firestore write; 3s keeps detection fast while the server
  // marks the reader offline after 6s (one missed beat plus jitter).
  if (millis() - lastServerHeartbeat > 3000 && WiFi.status() == WL_CONNECTED) {
    lastServerHeartbeat = millis();
    postBatch("/devices/heartbeat", "{}");
  }

  #if USE_LOAD_CELLS
  if (millis() - lastSample > SAMPLE_INTERVAL_MS) {
    lastSample = millis();
    if (scaleLpg.is_ready()) queueReading("LPG_TANK", scaleLpg.get_units(3));
    if (scaleBin.is_ready()) queueReading("CHEESE_BIN", scaleBin.get_units(3));
  }
#endif

  if (millis() - lastFlush > FLUSH_INTERVAL_MS && WiFi.status() == WL_CONNECTED) {
    lastFlush = millis();
    flushShifts();
    flushReadings();
  }

  // A WiFi link that dropped gets a 30s grace; after that the node stays in
  // offline-use mode (no background retries) until it is replugged.
}
