# CartIQ Database Schema

Prisma source of truth: [`api/prisma/schema.prisma`](../api/prisma/schema.prisma)

```mermaid
erDiagram
    LOCATION ||--o{ USER : "staff assigned"
    LOCATION ||--o{ ORDER : receives
    LOCATION ||--o{ INVENTORY_ITEM : stocks
    LOCATION ||--o{ SHIFT : logs
    LOCATION ||--o{ SENSOR_READING : senses
    LOCATION ||--o{ EXPENSE : incurs
    LOCATION ||--o{ DEVICE : "hosts node"
    USER ||--o{ ORDER : records
    USER ||--o{ SHIFT : "taps RFID"
    PRODUCT }o--o{ FLAVOR : "offered in"
    ORDER ||--|{ ORDER_ITEM : contains

    LOCATION {
        int id PK
        string code UK
        string name
        enum status
    }
    USER {
        int id PK
        string username UK
        string passwordHash
        enum role "OWNER|STAFF"
        bool active
        string rfidUid UK "nullable, RFID card"
        int locationId FK "null for owner"
    }
    DEVICE {
        int id PK
        string deviceId UK "esp32-cart-0x"
        int locationId FK
        string tokenHash "bcrypt device token"
        bool active
        datetime lastSeenAt "online if <5min"
    }
    PRODUCT {
        int id PK
        string name UK
        float basePrice
    }
    INVENTORY_ITEM {
        int id PK
        int locationId FK
        string name
        float stock
        float threshold
        enum source "MANUAL|SENSOR"
    }
    ORDER {
        int id PK
        string clientRef UK "offline dedupe"
        int locationId FK
        int staffId FK
        float total
        enum status
    }
    ORDER_ITEM {
        int id PK
        int orderId FK
        string productName
        string flavor
        int qty
        float unitPrice
    }
    SHIFT {
        int id PK
        string staffUid "RFID card UID"
        int staffId FK
        int locationId FK
        enum event "IN|OUT"
        datetime ts "device timestamp"
    }
    SENSOR_READING {
        int id PK
        int locationId FK
        enum channel "LPG_TANK|CHEESE_BIN"
        float kg
        datetime ts
    }
    EXPENSE {
        int id PK
        string vendor
        int locationId FK
        float amount
        enum source "OCR|MANUAL"
        string category
    }
    ALERT {
        int id PK
        string type "LOW_STOCK|UNKNOWN_CARD|..."
        string message
        string payload "nullable JSON"
        bool isRead "dedupe: one unread per key"
    }
```

## Design decisions

- **`Order.clientRef`** (unique): mobile queues orders offline; the UUID lets the
  API reject duplicate replays of the same queued sale.
- **Per-cart inventory rows** (`@@unique([locationId, name])`): each cart owns its
  stock, so offline edits across carts can never conflict (last-write-wins per key).
- **Device timestamps** (`Shift.ts`, `SensorReading.ts`) are taken at the cart,
  not upload time, so delayed batch sync stays historically correct. Firmware
  omits `ts` when NTP is unsynced so the server can default to upload time.
- **Alerts** is a generic feed (low-stock, unknown-card, sensor-drift) the
  dashboard polls; keeps business rules server-side. Low-stock alerts dedupe
  to one unread row per item; unknown-card alerts dedupe per UID.
- **`Device`** registry: one ESP32 node per cart, bearer token bcrypt-hashed
  at rest, `lastSeenAt` updated on every reading/shift, `online = lastSeen < 5min`.
- **Sensor → inventory mapping:** `LPG_TANK` mirrors into the `LPG Tank` row,
  `CHEESE_BIN` into `Cheese Powder` (source flips to `SENSOR`). Recipe-tracked
  items (pouches, frozen packs, powders via `IngredientMap`) deduct on POS orders.
