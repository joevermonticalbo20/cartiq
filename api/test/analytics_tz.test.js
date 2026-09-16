import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Fixed instants keep these green in ANY server timezone (CI runs UTC,
// dev machines run Asia/Manila). 2026-09-15T18:30:00Z == 2026-09-16 02:30
// Manila (Wednesday); git history confirms Tue Sep 15 2026.
import {
  manilaDayKey,
  manilaDow,
  manilaHour,
  manilaDowOfKey,
  manilaCalendarToday,
  manilaMonthRange,
} from "../src/services/timezone.js";
import { daysAgoStart, buildHourlyMatrix } from "../src/services/analytics_engine.js";
import { mapsForOrderLine } from "../src/services/inventory_rules.js";

const TUE_0230_MANILA = new Date("2026-09-15T18:30:00.000Z");

describe("manila calendar helpers", () => {
  it("dayKey resolves to the Manila calendar date, not UTC", () => {
    assert.equal(manilaDayKey(TUE_0230_MANILA), "2026-09-16");
    assert.equal(manilaDayKey(new Date("2026-09-15T15:59:59.000Z")), "2026-09-15");
  });

  it("dow/hour resolve in Manila wall time", () => {
    assert.equal(manilaDow(TUE_0230_MANILA), 3); // Wednesday
    assert.equal(manilaHour(TUE_0230_MANILA), 2);
  });

  it("dow of a bare calendar key is TZ-safe", () => {
    assert.equal(manilaDowOfKey("2026-09-16"), 3);
    assert.equal(manilaDowOfKey("2026-09-15"), 2);
  });

  it("calendar-today is a UTC-anchored Manila date", () => {
    const cal = manilaCalendarToday();
    assert.equal(cal.toISOString().slice(0, 10), manilaDayKey(new Date()));
    assert.equal(cal.getUTCHours(), 0);
  });

  it("month ranges are Manila-midnight instants", () => {
    const r = manilaMonthRange("2026-09");
    assert.equal(r.start.toISOString(), "2026-08-31T16:00:00.000Z");
    assert.equal(r.end.toISOString(), "2026-09-30T16:00:00.000Z");
    assert.equal(manilaMonthRange("nope"), null);
  });

  it("daysAgoStart stays Manila-midnight aligned", () => {
    const s = daysAgoStart(0);
    assert.equal(manilaDayKey(s), manilaDayKey(new Date()));
  });
});

describe("buildHourlyMatrix Manila bucketing", () => {
  it("buckets a 02:30 Manila sale into Wednesday hour 2", () => {
    const { matrix } = buildHourlyMatrix([{ createdAt: TUE_0230_MANILA, total: 40 }]);
    const cell = matrix.find((c) => c.dow === 3 && c.hour === 2);
    assert.equal(cell.orders, 1);
    assert.equal(cell.total_sales, 40);
  });
});

describe("mapsForOrderLine parity", () => {
  // Seed-like recipe: two generic rows + one flavor-specific row.
  const maps = [
    { productName: "Flavored Fries", flavor: "", itemName: "Pouches", amountPerUnit: 1 },
    { productName: "Flavored Fries", flavor: "", itemName: "Fries (frozen packs)", amountPerUnit: 0.05 },
    { productName: "Flavored Fries", flavor: "Cheese", itemName: "Cheese Powder", amountPerUnit: 0.03 },
  ];

  it("counts every matching generic row, not just the first", () => {
    const got = mapsForOrderLine(maps, "Flavored Fries", "Cheese").map((m) => m.itemName).sort();
    assert.deepEqual(got, ["Cheese Powder", "Fries (frozen packs)", "Pouches"]);
  });

  it("prefers the specific row when an item has both", () => {
    const dup = [
      ...maps,
      { productName: "Flavored Fries", flavor: "", itemName: "Cheese Powder", amountPerUnit: 0.05 },
    ];
    const got = mapsForOrderLine(dup, "Flavored Fries", "Cheese");
    const cheese = got.filter((m) => m.itemName === "Cheese Powder");
    assert.equal(cheese.length, 1);
    assert.equal(cheese[0].flavor, "Cheese");
  });

  it("ignores other products and flavors", () => {
    const got = mapsForOrderLine(maps, "Flavored Fries", "BBQ").map((m) => m.itemName).sort();
    assert.deepEqual(got, ["Fries (frozen packs)", "Pouches"]);
    assert.deepEqual(mapsForOrderLine(maps, "Unknown", "Cheese"), []);
  });
});
