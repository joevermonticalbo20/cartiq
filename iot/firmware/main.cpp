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

MFRC522 rfid(SS_PIN, RST_PIN);
HX711 scaleLpg;
HX711 scaleBin;

struct Reading { String channel; float kg; unsigned long epoch; };
Reading readingBuf[BUF_SIZE];
int readingCount = 0;

struct ShiftEvent { String uid; String event; unsigned long epoch; };
ShiftEvent shiftBuf[BUF_SIZE];
int shiftCount = 0;

unsigned long lastSample = 0;
unsigned long lastFlush = 0;
String lastUid = "";
unsigned long lastTapMs = 0;

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Connecting to Wi-Fi");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(400);
    Serial.print(".");
  }
  Serial.println(WiFi.status() == WL_CONNECTED ? "\nWi-Fi OK" : "\nWi-Fi unavailable - buffering offline");
}

bool postBatch(const char* path, const String& body) {
  HTTPClient http;
  http.begin(String(API_BASE_URL) + path);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + API_DEVICE_TOKEN);
  int code = http.POST(body);
  http.end();
  return code >= 200 && code < 300;
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
  }
  digitalWrite(LED_PIN, HIGH);
  delay(80);
  digitalWrite(LED_PIN, LOW);
  Serial.printf("Shift %s queued for %s\n", isOpen ? "IN" : "OUT", uid.c_str());
}

void flushShifts() {
  while (shiftCount > 0) {
    JsonDocument doc;
    doc["cart_id"] = DEVICE_CART_ID;
    doc["device_id"] = DEVICE_ID;
    JsonArray events = doc["events"].to<JsonArray>();
    JsonObject e = events.add<JsonObject>();
    e["staff_uid"] = shiftBuf[shiftCount - 1].uid;
    e["event"] = shiftBuf[shiftCount - 1].event;
    e["ts"] = nowIso();
    String body;
    serializeJson(doc, body);
    if (!postBatch("/api/shifts", body)) return;  // server down: retry later
    shiftCount--;
  }
}

void flushReadings() {
  while (readingCount > 0) {
    JsonDocument doc;
    doc["cart_id"] = DEVICE_CART_ID;
    doc["device_id"] = DEVICE_ID;
    JsonArray arr = doc["readings"].to<JsonArray>();
    JsonObject r = arr.add<JsonObject>();
    r["channel"] = readingBuf[readingCount - 1].channel;
    r["kg"] = serialized(String(readingBuf[readingCount - 1].kg, 3));
    r["ts"] = nowIso();
    String body;
    serializeJson(doc, body);
    if (!postBatch("/api/iot/readings", body)) return;
    readingCount--;
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);

  SPI.begin();
  rfid.PCD_Init();

  scaleLpg.begin(LPG_DT_PIN, LPG_SCK_PIN);
  scaleBin.begin(BIN_DT_PIN, BIN_SCK_PIN);
  scaleLpg.set_scale(CAL_FACTOR_LPG);
  scaleBin.set_scale(CAL_FACTOR_BIN);

  configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER);

  connectWifi();
}

void loop() {
  if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
    String uid = "";
    for (byte i = 0; i < rfid.uid.size; i++) {
      if (rfid.uid.uidByte[i] < 0x10) uid += "0";
      uid += String(rfid.uid.uidByte[i], HEX);
      uid.toUpperCase();
    }
    rfid.PICC_HaltA();
    queueShift(uid);
  }

  if (millis() - lastSample > SAMPLE_INTERVAL_MS) {
    lastSample = millis();
    if (scaleLpg.is_ready()) queueReading("LPG_TANK", scaleLpg.get_units(3));
    if (scaleBin.is_ready()) queueReading("CHEESE_BIN", scaleBin.get_units(3));
  }

  if (millis() - lastFlush > FLUSH_INTERVAL_MS && WiFi.status() == WL_CONNECTED) {
    lastFlush = millis();
    flushShifts();
    flushReadings();
  }
}
