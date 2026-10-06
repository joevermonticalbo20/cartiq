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

#include "config.h"   // copy config.example.h -> config.h and fill in

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

// How long to wait before re-associating after the link drops.
#ifndef WIFI_RETRY_INTERVAL_MS
#define WIFI_RETRY_INTERVAL_MS 20000UL
#endif

// One association attempt. Kept generous because a weak-signal cart may need
// several seconds to answer the handshake.
#ifndef WIFI_CONNECT_TIMEOUT_MS
#define WIFI_CONNECT_TIMEOUT_MS 30000UL
#endif

MFRC522 rfid(SS_PIN, RST_PIN);
HX711 scaleLpg;
HX711 scaleBin;

struct Reading { String channel; float kg; unsigned long epoch; };
Reading readingBuf[BUF_SIZE];
int readingCount = 0;

struct ShiftEvent { String uid; String event; unsigned long epoch; };
ShiftEvent shiftBuf[BUF_SIZE];
int shiftCount = 0;
unsigned long droppedReadings = 0;
unsigned long droppedShifts = 0;

unsigned long lastSample = 0;
unsigned long lastFlush = 0;
unsigned long wifiAttemptStarted = 0;
String lastUid = "";
unsigned long lastTapMs = 0;

void connectWifi() {
  // Marks the start of this attempt so loop() knows when it is safe to retry.
  wifiAttemptStarted = millis();

  // Drop any in-flight attempt first. Calling begin() while the driver is still
  // associating is rejected with "wifi:sta is connecting, cannot set config".
  WiFi.disconnect(true);
  delay(200);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("Connecting to Wi-Fi ssid=\"%s\"", WIFI_SSID);

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
    digitalWrite(LED_PIN, HIGH);
  } else {
    Serial.printf("\nWi-Fi unavailable (status %d) - buffering offline\n", (int)WiFi.status());
    digitalWrite(LED_PIN, LOW);
  }
}

int postBatch(const char* path, const String& body) {
  HTTPClient http;
  http.begin(String(API_BASE_URL) + path);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + API_DEVICE_TOKEN);
  int code = http.POST(body);
  http.end();
  return code;
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

void queueShift(const String& uid) {
  static bool isOpen = false;
  if (uid == lastUid && millis() - lastTapMs < 30000) return;  // debounce
  lastUid = uid;
  lastTapMs = millis();
  isOpen = !isOpen;

  if (shiftCount < BUF_SIZE) {
    shiftBuf[shiftCount++] = {uid, isOpen ? "IN" : "OUT", millis()};
  } else {
    droppedShifts++;
    Serial.printf("shift buffer full - dropped %lu total\n", droppedShifts);
  }
  digitalWrite(LED_PIN, HIGH);
  delay(80);
  digitalWrite(LED_PIN, LOW);
  Serial.printf("Shift %s queued for %s\n", isOpen ? "IN" : "OUT", uid.c_str());
}

void flushShifts() {
  const int BATCH = 10;
  while (shiftCount > 0) {
    JsonDocument doc;
    doc["cart_id"] = DEVICE_CART_ID;
    doc["device_id"] = DEVICE_ID;
    JsonArray events = doc["events"].to<JsonArray>();
    int n = shiftCount < BATCH ? shiftCount : BATCH;
    String ts = nowIso();
    for (int i = 0; i < n; i++) {
      JsonObject e = events.add<JsonObject>();
      e["staff_uid"] = shiftBuf[i].uid;
      e["event"] = shiftBuf[i].event;
      if (ts.length() > 0) e["ts"] = ts;
    }
    String body;
    serializeJson(doc, body);
    int code = postBatch("/shifts", body);
    if (code == 401 || code == 403) {
      Serial.printf("AUTH FAILED %d on /shifts - check API_DEVICE_TOKEN\n", code);
      return;  // keep buffer, don't burn radio retrying a bad token
    }
    if (code < 200 || code >= 300) return;  // server down: retry later
    for (int i = n; i < shiftCount; i++) shiftBuf[i - n] = shiftBuf[i];
    shiftCount -= n;
  }
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
  Serial.begin(115200);
  delay(1500);   // let the USB-UART bridge settle before printing
  pinMode(LED_PIN, OUTPUT);

  SPI.begin();
  rfid.PCD_Init();

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

  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER);

  connectWifi();
}

void loop() {
  if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
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

  // A marginal signal (a cart parked at the far end of a stall) associates only
  // some of the time, so keep retrying instead of staying offline until a
  // manual reset. Buffered events upload as soon as the link returns.
  if (WiFi.status() != WL_CONNECTED &&
      millis() - wifiAttemptStarted > WIFI_RETRY_INTERVAL_MS) {
    Serial.println("Wi-Fi down - retrying");
    connectWifi();
  }
}
