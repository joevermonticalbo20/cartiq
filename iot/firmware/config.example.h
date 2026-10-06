// Copy this file to config.h and fill in your local values.
// config.h is gitignored so credentials never enter version control.

#pragma once

#define WIFI_SSID       "YOUR_HOTSPOT_OR_HOME_WIFI"
#define WIFI_PASS       "CHANGE_ME"

#define API_BASE_URL    "http://192.168.x.x:4000/api"  // LAN IP of the PC running the CartIQ API (keep trailing /api; firmware paths are "/shifts" and "/iot/readings")
#define API_DEVICE_TOKEN "dev-CART-01-potafries"        // printed by `npm run db:seed` (rotate for deployment)

#define DEVICE_ID       "esp32-cart-01"
#define DEVICE_CART_ID  "CART-01"

// MFRC522 (must be powered at 3.3V only!)
#define SS_PIN          5
#define RST_PIN         22

// HX711 channels
#define USE_LOAD_CELLS  0     // 0 = RFID only, 1 = also report LPG/bin weights
#define LPG_DT_PIN      32
#define LPG_SCK_PIN     33
#define BIN_DT_PIN      25
#define BIN_SCK_PIN     26

#define LED_PIN         2

// Calibrate each cell with a known weight; adjust after tare at install.
#define CAL_FACTOR_LPG  420.0f
#define CAL_FACTOR_BIN  420.0f

#define SAMPLE_INTERVAL_MS  600000UL   // weigh every 10 minutes
#define FLUSH_INTERVAL_MS   30000UL    // try to upload every 30 s
#define BUF_SIZE            64

// NTP so buffered records carry true timestamps
#define GMT_OFFSET_SEC      8 * 3600   // UTC+8 Philippines
#define DAYLIGHT_OFFSET_SEC 0
#define NTP_SERVER          "pool.ntp.org"
