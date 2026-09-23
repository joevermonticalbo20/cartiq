// CartIQ Firestore data layer — Firestore-backed replacement for Prisma/SQLite.
//
// Design constraints (see migration plan):
//  1. API contracts are UNCHANGED: numeric integer IDs, ISO date strings,
//     pagination envelopes, unique-field errors (P2002), missing-record
//     errors (P2025). Routes keep identical logic; most only swap the import.
//  2. ZERO composite indexes required: every query uses at most ONE
//     server-side equality filter (single-field indexes always exist); all
//     other filtering / ordering / pagination happens in code. Data volume
//     is tiny (thousands of docs), so this is cheap and can never fail
//     with FAILED_PRECONDITION the way multi-filter queries can.
//  3. In-memory read-through cache (60s TTL, invalidated on any write to
//     the collection) so the dashboard's 10s polling doesn't burn the
//     Spark free-tier read quota. Transaction internals bypass the cache.
//  4. Firestore transactions require ALL reads before ALL writes — the
//     three handlers that interleave reads/writes (POST /orders,
//     POST /iot/readings, POST /shifts) were restructured read-phase first,
//     write-phase second, with identical responses.
//
// Env (first match wins):
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080  -> local emulator (no creds)
//   FIREBASE_SERVICE_ACCOUNT_JSON='<whole JSON>' -> hosted envs with no key
//     file (e.g. Supabase dashboard Secrets); the JSON content of a service-account key
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
//   FIREBASE_PROJECT_ID (default "cartiq-8e46f")
import { createRequire } from "node:module";

// firebase-admin v14 is modular (firebase-admin/app + firebase-admin/firestore);
// createRequire loads it correctly regardless of CJS/ESM packaging.
const require = createRequire(import.meta.url);
const { initializeApp, getApps, applicationDefault, cert, deleteApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "cartiq-8e46f";

if (getApps().length === 0) {
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    initializeApp({ projectId: PROJECT_ID });
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    initializeApp({
      credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)),
      projectId: PROJECT_ID,
    });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    initializeApp({
      credential: applicationDefault(),
      projectId: PROJECT_ID,
    });
  } else {
    // Lets local boot/health report db:fail instead of crashing when no
    // credentials are configured; routes surface 503 via /api/health.
    initializeApp({ projectId: PROJECT_ID });
  }
}

const fs = getFirestore();
const now = () => new Date();
const toTs = (v) => (v instanceof Date ? Timestamp.fromDate(v) : v);
const toDate = (v) => (v instanceof Timestamp ? v.toDate() : v);

// Strip `undefined` (Firestore rejects it) while keeping explicit nulls.
function clean(obj) {
  if (Array.isArray(obj)) return obj.map(clean);
  if (obj && typeof obj === "object" && !(obj instanceof Date) && !(obj instanceof Timestamp)) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== undefined) out[k] = clean(v);
    }
    return out;
  }
  return obj;
}

// ---------- model registry ----------
// numeric: doc ID is String(numeric id), allocated from _counters.
// defaults: applied on create (functions evaluated per-create).
// autoUpdatedAt: set to now() on every update (Prisma @updatedAt parity).
const MODELS = {
  users: {
    numeric: true,
    defaults: () => ({ role: "STAFF", active: true, rfidUid: null, locationId: null, createdAt: now() }),
    uniques: ["username", "rfidUid"],
  },
  refreshTokens: {
    numeric: true,
    defaults: () => ({ createdAt: now() }),
    uniques: ["token"],
  },
  locations: {
    numeric: true,
    defaults: () => ({ address: null, status: "ACTIVE" }),
    uniques: ["code"],
  },
  devices: {
    numeric: true,
    defaults: () => ({ active: true, lastSeenAt: null }),
    uniques: ["deviceId"],
  },
  products: {
    numeric: true,
    defaults: () => ({ category: "Fries", flavorIds: [] }),
    uniques: ["name"],
  },
  flavors: {
    numeric: true,
    defaults: () => ({}),
    uniques: ["name"],
  },
  // No numeric id in any response; Firestore auto-ID docs.
  ingredientMaps: { numeric: false, defaults: () => ({ flavor: "" }), uniques: [] },
  inventoryItems: {
    numeric: true,
    defaults: () => ({ unit: "pcs", threshold: 0, source: "MANUAL", updatedAt: now() }),
    uniques: [],
    autoUpdatedAt: "updatedAt",
  },
  stockAdjustments: {
    numeric: true,
    defaults: () => ({ reason: null, createdAt: now() }),
    uniques: [],
  },
  orders: {
    numeric: true,
    defaults: () => ({
      status: "PAID",
      paymentMethod: null,
      voidedBy: null,
      voidedAt: null,
      voidReason: null,
      staffId: null,
      items: [],
      createdAt: now(),
      syncedAt: now(),
    }),
    uniques: ["clientRef"],
  },
  shifts: {
    numeric: true,
    defaults: () => ({ staffId: null, staffName: null, deviceId: null, uploadedAt: now() }),
    uniques: [],
  },
  sensorReadings: {
    numeric: true,
    defaults: () => ({ deviceId: null, uploadedAt: now() }),
    uniques: [],
  },
  expenses: {
    numeric: true,
    defaults: () => ({
      locationId: null,
      source: "MANUAL",
      category: "Supplies",
      note: null,
      lines: null,
      createdAt: now(),
    }),
    uniques: [],
  },
  suppliers: {
    numeric: true,
    defaults: () => ({ contact: null, notes: null }),
    uniques: ["name"],
  },
  alerts: {
    numeric: true,
    defaults: () => ({
      payload: null,
      isRead: false,
      ackedBy: null,
      ackedAt: null,
      ackedByName: null,
      createdAt: now(),
    }),
    uniques: [],
  },
};

function errDup() {
  const e = new Error("Duplicate record (already exists).");
  e.code = "P2002";
  return e;
}
function errMissing() {
  const e = new Error("Record not found.");
  e.code = "P2025";
  return e;
}

// ---------- snapshot mapping ----------
function fromDoc(model, snap) {
  const data = snap.data();
  if (!data) return null;
  const out = { ...data };
  for (const [k, v] of Object.entries(out)) {
    if (Array.isArray(v)) {
      out[k] = v.map((el) => {
        if (el && typeof el === "object") {
          const c = { ...el };
          for (const [k2, v2] of Object.entries(c)) c[k2] = toDate(v2);
          return c;
        }
        return toDate(el);
      });
    } else {
      out[k] = toDate(v);
    }
  }
  out.id = MODELS[model].numeric ? Number(snap.id) : snap.id;
  return out;
}

// ---------- where matching (in code) ----------
function matchCond(value, cond) {
  if (cond !== null && typeof cond === "object" && !(cond instanceof Date) && !(cond instanceof Timestamp)) {
    for (const [op, operand] of Object.entries(cond)) {
      const v = value instanceof Timestamp ? value.toDate() : value;
      const o = operand instanceof Timestamp ? operand.toDate() : operand;
      const vn = v instanceof Date ? v.getTime() : v;
      const on = o instanceof Date ? o.getTime() : o;
      if (op === "gte" && !(vn >= on)) return false;
      else if (op === "gt" && !(vn > on)) return false;
      else if (op === "lte" && !(vn <= on)) return false;
      else if (op === "lt" && !(vn < on)) return false;
      else if (op === "in" && !o.includes(v)) return false;
      else if (op === "contains" && !(typeof v === "string" && v.includes(o))) return false;
      else if (op === "not" && vn === on) return false;
      else if (!["gte", "gt", "lte", "lt", "in", "contains", "not"].includes(op)) return false;
    }
    return true;
  }
  const v = value instanceof Timestamp ? value.toDate() : value;
  const c = cond instanceof Timestamp ? cond.toDate() : cond;
  if (v instanceof Date || c instanceof Date) {
    return v instanceof Date && c instanceof Date && v.getTime() === c.getTime();
  }
  return v === c;
}

function matchWhere(doc, where) {
  if (!where) return true;
  for (const [field, cond] of Object.entries(where)) {
    if (!matchCond(doc[field], cond)) return false;
  }
  return true;
}

// Resolve relation-object filters used by routes: { location: { code } }.
// Locations are tiny; resolve code -> id via a direct lookup.
async function resolveRelationWhere(model, where, reader) {
  if (!where) return where;
  const out = { ...where };
  if (out.location && typeof out.location === "object" && out.location.code !== undefined) {
    const loc = await reader("locations", { code: String(out.location.code) });
    delete out.location;
    // Unknown code matches zero rows (routes return [] for unknown code).
    out.locationId = loc ? loc.id : -1;
  }
  return out;
}

async function findByUnique(model, where, reader) {
  const docs = await reader(model, where);
  return docs[0] ?? null;
}

// ---------- ordering / pagination (in code; SQLite null semantics) ----------
function normVal(v) {
  if (v instanceof Timestamp) v = v.toDate();
  if (v instanceof Date) return v.getTime();
  return v;
}
function cmpVals(a, b, dir) {
  a = normVal(a);
  b = normVal(b);
  if (a === null || a === undefined) return dir === "asc" ? -1 : 1;
  if (b === null || b === undefined) return dir === "asc" ? 1 : -1;
  if (a < b) return dir === "asc" ? -1 : 1;
  if (a > b) return dir === "asc" ? 1 : -1;
  return 0;
}
function applyOrderBy(docs, orderBy) {
  if (!orderBy) return docs;
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
  const keys = specs.flatMap((s) => Object.entries(s));
  return [...docs].sort((a, b) => {
    for (const [field, dir] of keys) {
      const c = cmpVals(a[field], b[field], dir);
      if (c !== 0) return c;
    }
    return 0;
  });
}

// ---------- projection ----------
// Supports top-level select and nested select inside include.
function project(obj, select) {
  if (!select || !obj) return obj;
  const out = {};
  for (const [k, v] of Object.entries(select)) {
    if (v) out[k] = obj[k];
  }
  if (obj.id !== undefined && out.id === undefined) out.id = obj.id;
  return out;
}

// ---------- relation includes ----------
async function applyInclude(model, docs, include, reader) {
  if (!include) return docs;
  const out = [];
  for (const doc of docs) {
    const row = { ...doc };
    for (const [rel, spec] of Object.entries(include)) {
      const nestedSelect = spec && typeof spec === "object" && spec.select ? spec.select : null;
      const orderBy = spec && typeof spec === "object" ? spec.orderBy : null;
      if (model === "orders" && rel === "items") {
        row.items = (doc.items ?? []).map((it) => ({ ...it }));
      } else if (rel === "location" && doc.locationId != null) {
        const loc = await reader("locations", { id: doc.locationId });
        row.location = loc ? project({ ...loc }, nestedSelect || null) ?? loc : null;
        if (nestedSelect && row.location) row.location = project(row.location, nestedSelect);
      } else if (rel === "location" && doc.locationId == null) {
        row.location = null;
      } else if ((rel === "staff" || rel === "actor") && doc.staffId != null) {
        const u = await reader("users", { id: doc.staffId });
        row[rel] = u && nestedSelect ? project({ ...u }, nestedSelect) : u ? { ...u } : null;
      } else if ((rel === "staff" || rel === "actor") && doc.staffId == null) {
        row[rel] = null;
      } else if (model === "locations" && rel === "inventory") {
        let items = await cachedRead("inventoryItems", { locationId: doc.id }, undefined, undefined, undefined);
        items = applyOrderBy(items, orderBy ?? { name: "asc" });
        row.inventory = items;
      } else if (model === "products" && rel === "flavors") {
        const ids = new Set(doc.flavorIds ?? []);
        let flavors = (await cachedRead("flavors", null, undefined, undefined, undefined)).filter((f) =>
          ids.has(f.id)
        );
        flavors = applyOrderBy(flavors, orderBy ?? { name: "asc" });
        row.flavors = flavors;
        delete row.flavorIds;
      }
    }
    out.push(row);
  }
  return out;
}

// ---------- read cache (TTL + write invalidation + LRU cap) ----------
const CACHE_TTL_MS = Number(process.env.FIRESTORE_CACHE_TTL_MS) || 60 * 1000;
const CACHE_MAX_KEYS = Number(process.env.FIRESTORE_CACHE_MAX_KEYS) || 500;
const _cache = new Map(); // key -> { exp, value } (insertion-order = LRU)
function cacheGet(key) {
  const rec = _cache.get(key);
  if (!rec) return undefined;
  if (rec.exp <= Date.now()) {
    _cache.delete(key);
    return undefined;
  }
  // LRU touch: re-insert to mark as recently used.
  _cache.delete(key);
  _cache.set(key, rec);
  return rec.value;
}
function cacheSet(key, value) {
  if (_cache.has(key)) _cache.delete(key);
  _cache.set(key, { exp: Date.now() + CACHE_TTL_MS, value });
  while (_cache.size > CACHE_MAX_KEYS) {
    // Evict oldest (first inserted = least recently used).
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}
// Collections whose writes affect joined reads elsewhere (explicit set —
// no fragile regex on cache keys).
const JOIN_DEPENDENTS = new Set(["locations", "users", "flavors", "inventoryItems"]);
function invalidateModel(model) {
  const prefix = `${model}|`;
  for (const key of [..._cache.keys()]) {
    if (key.startsWith(prefix)) _cache.delete(key);
  }
  // Relation dependents: joined reads embed these collections.
  if (JOIN_DEPENDENTS.has(model)) {
    for (const key of [..._cache.keys()]) {
      if (key.includes('"include"')) _cache.delete(key);
    }
  }
}
function stableKey(model, where, orderBy, include, select) {
  return `${model}|${JSON.stringify({ where, orderBy, include, select })}`;
}

// Raw collection read: at most one server-side equality prefilter, rest in code.
async function rawRead(model, where) {
  let q = fs.collection(model);
  let applied = false;
  if (where) {
    for (const [field, cond] of Object.entries(where)) {
      const simple =
        cond !== null &&
        typeof cond !== "object" &&
        !(cond instanceof Date) &&
        field !== "location";
      if (simple && !applied) {
        q = q.where(field, "==", cond);
        applied = true;
      }
    }
  }
  const snap = await q.get();
  let docs = snap.docs.map((d) => fromDoc(model, d));
  if (where) docs = docs.filter((d) => matchWhere(d, where));
  return docs;
}

// Cached read used by all non-transaction paths. Pass nocache:true for
// correctness-critical bootstrap reads (POS catalog) that must never serve
// a stale TTL window after a write on another request.
async function cachedRead(model, rawWhere, orderBy, include, select, nocache) {
  const where = await resolveRelationWhere(model, rawWhere, cachedOne);
  const key = stableKey(model, where, orderBy, include, select);
  let docs = nocache ? undefined : cacheGet(key);
  if (docs === undefined) {
    docs = await rawRead(model, where);
    docs = applyOrderBy(docs, orderBy);
    docs = await applyInclude(model, docs, include, cachedOne);
    if (select) docs = docs.map((d) => project(d, select));
    if (!nocache) cacheSet(key, docs);
  }
  return docs;
}

// Direct (uncached) single read by unique lookup.
async function uniqueRead(model, where) {
  if (!where) return null;
  if (where.id !== undefined && Object.keys(where).length === 1) {
    const snap = await fs.collection(model).doc(String(where.id)).get();
    if (!snap.exists) return null;
    return fromDoc(model, snap);
  }
  const docs = await rawRead(model, where);
  return docs[0] ?? null;
}

// Cached single-row read for relation joins (location/staff per row).
// Without this, every list page would do N+1 uncached reads.
async function cachedOne(model, where) {
  const docs = await cachedRead(model, where, undefined, undefined, undefined);
  return docs[0] ?? null;
}

// ---------- numeric ID allocation ----------
async function allocIds(model, n, txn) {
  const ref = fs.collection("_counters").doc(model);
  if (txn) {
    const snap = await txn.get(ref);
    const next = snap.exists ? Number(snap.data().next) || 1 : 1;
    txn.set(ref, { next: next + n }, { merge: true });
    return Array.from({ length: n }, (_, i) => next + i);
  }
  const ids = await fs.runTransaction(async (t) => {
    const snap = await t.get(ref);
    const next = snap.exists ? Number(snap.data().next) || 1 : 1;
    t.set(ref, { next: next + n }, { merge: true });
    return Array.from({ length: n }, (_, i) => next + i);
  });
  return ids;
}

// ---------- per-model API ----------
function modelApi(model, ctx) {
  const cfg = MODELS[model];
  const isTxn = !!ctx?.txn;
  const touched = ctx?.touched;
  const mark = () => {
    if (touched) touched.add(model);
    else invalidateModel(model);
  };
  // Transaction reads bypass cache and use the transaction object.
  async function txnDocs(where) {
    const resolved = await resolveRelationWhere(model, where, async (m, w) => {
      if (w.id !== undefined && Object.keys(w).length === 1) {
        const s = await ctx.txn.get(fs.collection(m).doc(String(w.id)));
        return s.exists ? fromDoc(m, s) : null;
      }
      const snap = await ctx.txn.get(fs.collection(m));
      const all = snap.docs.map((d) => fromDoc(m, d));
      return all.filter((d) => matchWhere(d, w))[0] ?? null;
    });
    // Prefer a single-equality server filter when available.
    let snap;
    let serverFiltered = false;
    if (resolved) {
      for (const [field, cond] of Object.entries(resolved)) {
        if (cond !== null && typeof cond !== "object" && !(cond instanceof Date) && field !== "location") {
          snap = await ctx.txn.get(fs.collection(model).where(field, "==", cond));
          serverFiltered = true;
          break;
        }
      }
    }
    if (!serverFiltered) snap = await ctx.txn.get(fs.collection(model));
    let docs = snap.docs.map((d) => fromDoc(model, d));
    if (resolved) docs = docs.filter((d) => matchWhere(d, resolved));
    return docs;
  }

  async function readMany(args = {}) {
    const { where, orderBy, include, select, nocache } = args;
    if (isTxn) {
      let docs = await txnDocs(where);
      docs = applyOrderBy(docs, orderBy);
      docs = await applyInclude(model, docs, include, async (m, w) => {
        if (w.id !== undefined && Object.keys(w).length === 1) {
          const s = await ctx.txn.get(fs.collection(m).doc(String(w.id)));
          return s.exists ? fromDoc(m, s) : null;
        }
        const snap = await ctx.txn.get(fs.collection(m));
        return snap.docs.map((d) => fromDoc(m, d)).filter((d) => matchWhere(d, w))[0] ?? null;
      });
      if (select) docs = docs.map((d) => project(d, select));
      return docs;
    }
    return cachedRead(model, where, orderBy, include, select, nocache);
  }

  return {
    async findMany(args = {}) {
      const { skip, take, ...rest } = args;
      let docs = await readMany(rest);
      if (skip) docs = docs.slice(skip);
      if (take !== undefined) docs = docs.slice(0, take);
      return docs;
    },
    async findFirst(args = {}) {
      const docs = await readMany(args);
      return docs[0] ?? null;
    },
    async findUnique(args = {}) {
      const docs = await readMany({ where: args.where, include: args.include, select: args.select });
      return docs[0] ?? null;
    },
    async count(args = {}) {
      const docs = await readMany({ where: args?.where });
      return docs.length;
    },
    async aggregate(args = {}) {
      const docs = await readMany({ where: args?.where });
      const out = {};
      if (args._count) out._count = docs.length;
      if (args._sum) {
        out._sum = {};
        for (const field of Object.keys(args._sum)) {
          out._sum[field] = docs.reduce((s, d) => s + (Number(d[field]) || 0), 0);
        }
      }
      return out;
    },
    async groupBy(args = {}) {
      const docs = await readMany({ where: args?.where });
      const groups = new Map();
      for (const d of docs) {
        const key = args.by.map((f) => JSON.stringify(d[f] ?? null)).join("|");
        if (!groups.has(key)) {
          const base = {};
          for (const f of args.by) base[f] = d[f] ?? null;
          groups.set(key, { ...base, _docs: [] });
        }
        groups.get(key)._docs.push(d);
      }
      const rows = [];
      for (const g of groups.values()) {
        const row = { ...g };
        delete row._docs;
        if (args._sum) {
          row._sum = {};
          for (const field of Object.keys(args._sum)) {
            row._sum[field] = g._docs.reduce((s, d) => s + (Number(d[field]) || 0), 0);
          }
        }
        if (args._count) row._count = g._docs.length;
        rows.push(row);
      }
      return rows;
    },
    async create(args = {}) {
      const data = { ...cfg.defaults(), ...clean(args.data ?? {}) };
      // Enforce declared unique fields (Prisma P2002 parity) on direct
      // writes. Inside transactions this check is SKIPPED: Firestore
      // forbids reads after any write, so callers verify uniqueness with
      // read-phase guards instead (e.g. the orderRefs doc for clientRef).
      if (!isTxn) {
        for (const field of cfg.uniques ?? []) {
          if (data[field] !== null && data[field] !== undefined) {
            const clash = await uniqueRead(model, { [field]: data[field] });
            if (clash) throw errDup();
          }
        }
      }
      let id = data.id;
      if (cfg.numeric) {
        if (id === undefined) {
          if (isTxn) {
            // Auto-allocation reads the counter, which is illegal after any
            // staged write. Callers must allocate up front (tx.allocIds) and
            // pass an explicit id — fail loudly instead of surfacing a
            // cryptic Firestore error.
            throw new Error(
              `db.${model}.create inside a transaction requires an explicit numeric id (allocate with tx.allocIds first)`
            );
          }
          [id] = await allocIds(model, 1);
        }
        data.id = id;
      }
      const stored = {};
      for (const [k, v] of Object.entries(data)) stored[k] = v instanceof Date ? toTs(v) : v;
      const ref = cfg.numeric
        ? fs.collection(model).doc(String(id))
        : fs.collection(model).doc();
      const write = isTxn ? ctx.txn.set(ref, clean(stored)) : ref.set(clean(stored));
      await write;
      mark();
      let row = fromDoc(model, { id: ref.id, data: () => stored });
      if (args.include) {
        [row] = await applyInclude(model, [row], args.include, cachedOne);
      }
      return row;
    },
    async update(args = {}) {
      // Transaction path is a blind write: pre-reading here would break
      // multi-write transactions (Firestore bans reads after any write).
      // Callers verify existence in the read phase.
      const existing = isTxn
        ? { id: Number(args.where.id) }
        : await uniqueRead(model, { id: args.where.id });
      if (!isTxn && !existing) throw errMissing();
      const patch = clean(args.data ?? {});
      if (cfg.autoUpdatedAt && patch[cfg.autoUpdatedAt] === undefined) {
        patch[cfg.autoUpdatedAt] = toTs(now());
      }
      for (const [k, v] of Object.entries(patch)) {
        if (v instanceof Date) patch[k] = toTs(v);
      }
      const ref = fs.collection(model).doc(String(existing.id));
      if (isTxn) ctx.txn.update(ref, patch);
      else await ref.update(patch);
      mark();
      let row = { ...existing, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, toDate(v)])) };
      if (args.include) {
        [row] = await applyInclude(model, [row], args.include, cachedOne);
      }
      return row;
    },
    async updateMany(args = {}) {
      const where = await resolveRelationWhere(model, args.where, cachedOne);
      const docs = isTxn ? await txnDocs(args.where) : await cachedRead(model, where, undefined, undefined, undefined);
      const patch = clean(args.data ?? {});
      if (cfg.autoUpdatedAt && patch[cfg.autoUpdatedAt] === undefined) {
        patch[cfg.autoUpdatedAt] = toTs(now());
      }
      if (isTxn) {
        for (const d of docs) ctx.txn.update(fs.collection(model).doc(String(d.id)), patch);
      } else if (docs.length > 0) {
        const batch = fs.batch();
        for (const d of docs) batch.update(fs.collection(model).doc(String(d.id)), patch);
        await batch.commit();
      }
      mark();
      return { count: docs.length };
    },
    async delete(args = {}) {
      // Blind in transactions (same reads-before-writes rule as update).
      const existing = isTxn
        ? { id: Number(args.where.id) }
        : await uniqueRead(model, { id: args.where.id });
      if (!isTxn && !existing) throw errMissing();
      const ref = fs.collection(model).doc(String(existing.id));
      if (isTxn) ctx.txn.delete(ref);
      else await ref.delete();
      mark();
      return existing;
    },
    async deleteMany(args = {}) {
      if (isTxn) throw new Error("deleteMany is not supported inside transactions");
      const where = await resolveRelationWhere(model, args.where, cachedOne);
      const docs = await rawRead(model, where);
      for (let i = 0; i < docs.length; i += 400) {
        const batch = fs.batch();
        for (const d of docs.slice(i, i + 400)) {
          batch.delete(fs.collection(model).doc(String(d.id)));
        }
        await batch.commit();
      }
      mark();
      return { count: docs.length };
    },
    // Transaction-only numeric ID block allocation (reads counter early —
    // callers must allocate before any write in the transaction).
    async nextIds(n) {
      if (!isTxn) return allocIds(model, n);
      return allocIds(model, n, ctx.txn);
    },
  };
}

// ---------- database handle ----------
// `db` mirrors the Prisma call shapes used across routes so rewrites stay
// mechanical. Prefer `db.collection` for raw escape hatches (orderRefs guard
// docs, _counters) and `db.runTransaction` for complex atomic flows.
// Prisma singular model names -> Firestore collections. Routes keep their
// original `prisma.inventoryItem` / `prisma.order` call sites unchanged.
const MODEL_ALIASES = {
  user: "users",
  refreshToken: "refreshTokens",
  location: "locations",
  device: "devices",
  product: "products",
  flavor: "flavors",
  ingredientMap: "ingredientMaps",
  inventoryItem: "inventoryItems",
  stockAdjustment: "stockAdjustments",
  order: "orders",
  shift: "shifts",
  sensorReading: "sensorReadings",
  expense: "expenses",
  supplier: "suppliers",
  alert: "alerts",
};

function buildDb(ctx) {
  const handle = {};
  for (const model of Object.keys(MODELS)) {
    handle[model] = modelApi(model, ctx);
  }
  for (const [alias, model] of Object.entries(MODEL_ALIASES)) {
    if (!handle[alias]) handle[alias] = handle[model];
  }
  return handle;
}

export const db = {
  ...buildDb(null),
  collection: (name) => fs.collection(name),
  timestampNow: () => Timestamp.now(),
  // Prisma-name alias so swapped imports keep working verbatim.
  $transaction: (fn) => db.runTransaction(fn),
  async runTransaction(fn) {
    // Contention retry: concurrent POS sales serialize on _counters docs.
    // Retry ABORTED/CONTENTION a few times with backoff instead of 500ing.
    const MAX_ATTEMPTS = 4;
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const touched = new Set();
      try {
        const result = await fs.runTransaction(async (txn) => {
      const tx = {
        ...buildDb({ txn, touched }),
        txn,
        _firestore: fs,
        // Raw doc helpers for guard docs outside the model registry
        // (e.g. orderRefs/{clientRef} idempotency guard). Reads here must
        // still precede any write in the transaction.
        async getDoc(collection, id) {
          const s = await txn.get(fs.collection(collection).doc(String(id)));
          if (!s.exists) return null;
          const data = { ...s.data() };
          for (const [k, v] of Object.entries(data)) data[k] = toDate(v);
          return { id: s.id, ...data };
        },
        setDoc(collection, id, data) {
          txn.set(fs.collection(collection).doc(String(id)), clean(data));
        },
        // Batched numeric-ID allocation: { collectionName: count } -> { name: [ids] }.
        // This is the ONLY safe way to allocate multiple ID blocks in one
        // transaction — per-model nextIds() reads AND writes its counter, so
        // calling it twice (or after any other write) throws
        // READ_AFTER_WRITE. Call once, after all data reads, before writes.
        async allocIds(spec) {
          const names = Object.keys(spec).filter((n) => spec[n] > 0);
          const refs = names.map((n) => fs.collection("_counters").doc(n));
          const snaps = await Promise.all(refs.map((r) => txn.get(r)));
          const out = {};
          names.forEach((n, i) => {
            const next = snaps[i].exists ? Number(snaps[i].data().next) || 1 : 1;
            out[n] = Array.from({ length: spec[n] }, (_, k) => next + k);
            txn.set(refs[i], { next: next + spec[n] }, { merge: true });
          });
          return out;
        },
      };
      return fn(tx);
    });
    for (const m of touched) invalidateModel(m);
    return result;
      } catch (err) {
        lastErr = err;
        const msg = String(err?.message ?? "");
        const code = err?.code;
        const retryable =
          code === 10 || // ABORTED
          code === "ABORTED" ||
          /contention|aborted|read.after.write|READ_AFTER_WRITE/i.test(msg);
        if (!retryable || attempt === MAX_ATTEMPTS) throw err;
        await new Promise((r) => setTimeout(r, 100 * 2 ** (attempt - 1)));
      }
    }
    throw lastErr;
  },
  // Read a single doc by ID (orderRefs guard docs, etc.).
  async getDoc(collection, id) {
    const snap = await fs.collection(collection).doc(String(id)).get();
    if (!snap.exists) return null;
    const data = { ...snap.data() };
    for (const [k, v] of Object.entries(data)) data[k] = toDate(v);
    return { id: snap.id, ...data };
  },
  async ping() {
    await fs.collection("_counters").limit(1).get();
    return true;
  },
  async $disconnect() {
    try {
      const { getApp } = require("firebase-admin/app");
      await deleteApp(getApp());
    } catch {
      // already deleted / emulator mode
    }
  },
  // Test/ops escape hatch.
  _invalidateAll() {
    _cache.clear();
  },
  // Invalidate one model's cached reads. Needed after transactions that
  // write a collection through the raw txn handle (tx.txn.update), which
  // bypasses modelApi's write invalidation (e.g. recipe-row rewrites).
  _invalidateModel(model) {
    invalidateModel(model);
  },
};
