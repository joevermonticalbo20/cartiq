// CartIQ API on Supabase Edge Functions (Deno).
//
//   web/mobile/iot -> https://<ref>.supabase.co/functions/v1/api/*
//                    -> NATIVE (this file, direct to Firestore REST)
// Firebase (Hosting + Firestore cartiq-8e46f) is untouched. There is no
// Render dependency left: every route below is implemented natively.
//
// Secrets (dashboard: Edge Functions -> Manage secrets):
//   CORS_ORIGINS="https://cartiq-8e46f.web.app,https://cartiq-8e46f.firebaseapp.com"
//   FIREBASE_PROJECT_ID="cartiq-8e46f"
//   FIREBASE_SERVICE_ACCOUNT_JSON='<whole service-account JSON, one line>'
//   JWT_SECRET="<auth secret>"  (+ optional JWT_REFRESH_SECRET)
//
// Deploy: push to main (GitHub Actions deploys supabase/functions/*).
// @ts-nocheck: pure JS + JSDoc so `node --check` can parse it too.

const DEFAULT_ORIGINS = [
  "https://cartiq-8e46f.web.app",
  "https://cartiq-8e46f.firebaseapp.com",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];
const DEFAULT_PROJECT = "cartiq-8e46f";

function env(name) {
  try {
    const v = Deno.env.get(name);
    return v === undefined ? "" : v;
  } catch { return ""; }
}

function getAllowedOrigins() {
  const raw = env("CORS_ORIGINS");
  if (!raw.trim()) return DEFAULT_ORIGINS;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function getProjectId() {
  const v = env("FIREBASE_PROJECT_ID");
  return v && v.trim() ? v.trim() : DEFAULT_PROJECT;
}

function getServiceAccount() {
  const raw = env("FIREBASE_SERVICE_ACCOUNT_JSON");
  if (!raw.trim()) return null;
  try {
    const sa = JSON.parse(raw);
    if (sa && sa.client_email && sa.private_key) return sa;
    return null;
  } catch { return null; }
}

function jwtSecret() { return env("JWT_SECRET"); }
function refreshSecret() { return env("JWT_REFRESH_SECRET") || env("JWT_SECRET"); }

function hasNativeConfig() {
  return !!jwtSecret() && !!getServiceAccount();
}

function corsHeaders(origin) {
  const allowed = getAllowedOrigins();
  const allow = origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "Content-Type,Authorization",
    "access-control-max-age": "86400",
    "vary": "Origin",
  };
}

function jsonRes(origin, obj, status) {
  return Response.json(obj, { status: status || 200, headers: corsHeaders(origin) });
}

/** 404 shape mirrors Express notFound (method + path + correlationId). */
function notFoundRes(origin, req, path) {
  return jsonRes(origin, {
    error: `Not found: ${req.method} /api${path}`,
    correlationId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  }, 404);
}

/** Strip the /functions/v1/api prefix -> path starting with / (no /api prefix). */
function toApiPath(url) {
  const prefix = "/functions/v1/api";
  let path = url.pathname;
  if (path.startsWith(prefix)) path = path.slice(prefix.length);
  if (!path.startsWith("/")) path = "/" + path;
  path = path.replace(/^\/api(?=\/|$)/, "");
  if (path === "") path = "/";
  return path + url.search;
}

// ---------- base64url ----------
function b64urlEncode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- HS256 JWT (matches jsonwebtoken HS256 in api/) ----------
async function signHS256(payload, secret, expSec) {
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expSec };
  const head = b64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const pay = b64urlEncode(new TextEncoder().encode(JSON.stringify(body)));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(head + "." + pay)));
  return head + "." + pay + "." + b64urlEncode(sig);
}

async function verifyHS256(token, secret) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const ok = await crypto.subtle.verify(
      "HMAC", key, b64urlDecode(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1])
    );
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    if (payload.exp !== undefined && Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload;
  } catch { return null; }
}

// ---------- bcrypt (npm in Supabase runtime, harness stub in Node tests) ----------
async function bcryptLib() {
  if (globalThis.__BCRYPT__) return globalThis.__BCRYPT__;
  const m = await import("npm:bcryptjs@3.0.2");
  return m.default ?? m;
}

// ---------- Google OAuth2 (service-account assertion) ----------
let _gTok = null; // { token, expMs }

function pemToDer(pem) {
  const b64 = String(pem).replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function googleAccessToken() {
  if (_gTok && _gTok.expMs - 60000 > Date.now()) return _gTok.token;
  const sa = getServiceAccount();
  if (!sa) throw Object.assign(new Error("Firestore not configured"), { status: 503 });
  const now = Math.floor(Date.now() / 1000);
  const head = b64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = b64urlEncode(new TextEncoder().encode(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })));
  const key = await crypto.subtle.importKey(
    "pkcs8", pemToDer(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head + "." + claims)));
  const assertion = head + "." + claims + "." + b64urlEncode(sig);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") +
      "&assertion=" + encodeURIComponent(assertion),
  });
  if (!res.ok) throw Object.assign(new Error("Google auth failed"), { status: 503 });
  const data = await res.json();
  _gTok = { token: data.access_token, expMs: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  return _gTok.token;
}

// ---------- Firestore REST ----------
function fsDocBase() {
  return "https://firestore.googleapis.com/v1/projects/" + getProjectId() + "/databases/(default)/documents";
}

async function fsFetch(url, opts) {
  const token = await googleAccessToken();
  const res = await fetch(url, {
    ...opts,
    headers: { ...(opts && opts.headers ? opts.headers : {}), Authorization: "Bearer " + token },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    let detail = "";
    let code = "UNKNOWN";
    try {
      const ej = await res.json();
      code = (ej && ej.error && ej.error.status) || code;
      detail = JSON.stringify(ej);
    } catch { detail = await res.text().catch(() => ""); }
    const err = new Error("Firestore error: " + res.status + " " + detail);
    err.status = 503;
    err.code = code;
    throw err;
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) return await res.json();
  return null;
}

function fsDecodeValue(v) {
  if (v === null || v === undefined) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return Number(v.doubleValue);
  if (v.booleanValue !== undefined) return !!v.booleanValue;
  if (v.nullValue !== undefined) return null;
  if (v.timestampValue !== undefined) return new Date(v.timestampValue);
  if (v.arrayValue !== undefined) return (v.arrayValue.values || []).map(fsDecodeValue);
  if (v.mapValue !== undefined) {
    const out = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) out[k] = fsDecodeValue(val);
    return out;
  }
  if (v.bytesValue !== undefined) return v.bytesValue;
  if (v.referenceValue !== undefined) return v.referenceValue;
  if (v.geoPointValue !== undefined) return v.geoPointValue;
  return null;
}

function fsEncodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fsEncodeValue) } };
  if (typeof v === "object") {
    const fields = {};
    for (const [k, val] of Object.entries(v)) {
      if (val !== undefined) fields[k] = fsEncodeValue(val);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function fsEncodeFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v !== undefined) fields[k] = fsEncodeValue(v);
  }
  return fields;
}

/** Decode a REST document -> plain object with numeric id when the doc ID is numeric. */
function fsDecodeDoc(doc) {
  if (!doc || !doc.fields) return null;
  const idPart = String(doc.name || "").split("/").pop();
  const out = {};
  for (const [k, v] of Object.entries(doc.fields)) out[k] = fsDecodeValue(v);
  const asNum = Number(idPart);
  out.id = idPart !== "" && Number.isInteger(asNum) ? asNum : idPart;
  out._name = doc.name;
  out._updateTime = doc.updateTime || null;
  return out;
}

async function fsGet(collection, id) {
  const doc = await fsFetch(fsDocBase() + "/" + collection + "/" + encodeURIComponent(String(id)));
  return fsDecodeDoc(doc);
}

/**
 * Server-side query engine (Phase A perf): filters + orderBy + limit +
 * offset/cursor run in Firestore instead of listing whole collections.
 * Multi-filter queries need the composite indexes in firestore.indexes.json.
 *
 * filters: [{ field, op, value }] op: EQUAL, GREATER_THAN_OR_EQUAL, LESS_THAN
 * orderBy: [{ field, dir }] dir: "ASCENDING" | "DESCENDING" (default DESC for
 *   date fields is the caller's choice; single orderBy shown here)
 * startAt: { values: [encoded...] } cursor (exclusive, before:false)
 */
function fsOpFilter(f) {
  return { fieldFilter: { field: { fieldPath: f.field }, op: f.op, value: fsEncodeValue(f.value) } };
}

async function fsRunQuery(collection, opts) {
  const { filters, orderBy, limit, offset, startAt } = opts || {};
  const q = { from: [{ collectionId: collection }] };
  if (filters && filters.length === 1) {
    q.where = fsOpFilter(filters[0]);
  } else if (filters && filters.length > 1) {
    q.where = { compositeFilter: { op: "AND", filters: filters.map(fsOpFilter) } };
  }
  if (orderBy && orderBy.length > 0) {
    q.orderBy = orderBy.map((o) => ({
      field: { fieldPath: o.field },
      direction: o.dir || "DESCENDING",
    }));
  }
  if (limit !== undefined) q.limit = limit;
  if (offset) q.offset = offset;
  if (startAt) q.startAt = { values: startAt.values, before: false };
  const data = await fsFetch(fsDocBase() + ":runQuery", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: q }),
  });
  const out = [];
  for (const row of data || []) {
    const d = fsDecodeDoc(row.document);
    if (d) out.push(d);
  }
  return out;
}

/** Count aggregation (cheap, index-backed) for list totals. */
async function fsCount(collection, filters) {
  const sq = { from: [{ collectionId: collection }] };
  if (filters && filters.length === 1) sq.where = fsOpFilter(filters[0]);
  else if (filters && filters.length > 1) {
    sq.where = { compositeFilter: { op: "AND", filters: filters.map(fsOpFilter) } };
  }
  const data = await fsFetch(fsDocBase() + ":runAggregationQuery", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredAggregationQuery: {
        structuredQuery: sq,
        aggregations: [{ alias: "total", count: {} }],
      },
    }),
  });
  const agg = data && data[0] && data[0].result && data[0].result.aggregateFields;
  const total = agg && agg.total;
  if (!total) return 0;
  return Number(total.integerValue ?? total.doubleValue ?? 0);
}

/** Sum aggregation for numeric fields. */
async function fsSum(collection, field, filters) {
  const sq = { from: [{ collectionId: collection }] };
  if (filters && filters.length === 1) sq.where = fsOpFilter(filters[0]);
  else if (filters && filters.length > 1) {
    sq.where = { compositeFilter: { op: "AND", filters: filters.map(fsOpFilter) } };
  }
  const data = await fsFetch(fsDocBase() + ":runAggregationQuery", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredAggregationQuery: {
        structuredQuery: sq,
        aggregations: [{ alias: "sum", sum: { field: { fieldPath: field } } }],
      },
    }),
  });
  const agg = data && data[0] && data[0].result && data[0].result.aggregateFields;
  const s = agg && agg.sum;
  if (!s) return 0;
  return Number(s.integerValue ?? s.doubleValue ?? 0);
}

/**
 * Opaque page cursor: { t: createdAt ISO, id } -> base64url.
 * Cursors ride the createdAt DESC ordering; same-ms ties may repeat/skip a
 * row across a page boundary (admin lists only — accepted, documented).
 */
function encodeCursor(doc, dateField) {
  const dt = doc[dateField];
  const payload = {
    t: dt instanceof Date ? dt.toISOString() : new Date(0).toISOString(),
    id: doc.id,
  };
  return b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
}

function decodeCursor(cursor) {
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(cursor)));
    const t = new Date(payload.t);
    if (!Number.isFinite(t.getTime())) return null;
    return { t, id: payload.id };
  } catch {
    return null;
  }
}

/** List every document in a collection (paginated; data is tiny). */
async function fsListAll(collection, pageSize) {
  const out = [];
  let pageToken = "";
  for (let i = 0; i < 50; i++) {
    let url = fsDocBase() + "/" + collection + "?pageSize=" + (pageSize || 300);
    if (pageToken) url += "&pageToken=" + encodeURIComponent(pageToken);
    const data = await fsFetch(url, { method: "GET" });
    if (!data) break;
    for (const doc of data.documents || []) {
      const d = fsDecodeDoc(doc);
      if (d) out.push(d);
    }
    pageToken = (data && data.nextPageToken) || "";
    if (!pageToken) break;
  }
  return out;
}

/** Strip internal fields before responding. */
function cleanDoc(d) {
  if (!d || typeof d !== "object") return d;
  const { _name, _updateTime, ...rest } = d;
  return rest;
}

async function fsQueryEqual(collection, field, value, limit) {
  const data = await fsFetch(fsDocBase() + ":runQuery", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: collection }],
        where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: fsEncodeValue(value) } },
        limit: limit || 10,
      },
    }),
  });
  const out = [];
  for (const row of data || []) {
    const d = fsDecodeDoc(row.document);
    if (d) out.push(d);
  }
  return out;
}

async function fsCreate(collection, docId, obj) {
  const url = fsDocBase() + "/" + collection + (docId ? "?documentId=" + encodeURIComponent(String(docId)) : "");
  const data = await fsFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: fsEncodeFields(obj) }),
  });
  return fsDecodeDoc(data);
}

async function fsDeleteByName(name) {
  await fsFetch("https://firestore.googleapis.com/v1/" + name, { method: "DELETE" });
}

function fsFullName(collection, id) {
  return fsDocBase() + "/" + collection + "/" + encodeURIComponent(String(id));
}

/** Relative resource name for use INSIDE commit bodies (update.name must be
 *  relative — a full HTTPS URL here yields INVALID_ARGUMENT while every
 *  URL-based call keeps working, masking the bug as silent fake-success). */
function fsDocName(collection, id) {
  return "projects/" + getProjectId() + "/databases/(default)/documents/" + collection + "/" + encodeURIComponent(String(id));
}

/** Single-document patch (non-transactional; for low-contention edits). */
async function fsPatch(collection, id, patch) {
  const paths = Object.keys(patch);
  const mask = paths.map((p) => "updateMask.fieldPaths=" + encodeURIComponent(p)).join("&");
  const data = await fsFetch(fsFullName(collection, id) + "?" + mask, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: fsEncodeFields(patch) }),
  });
  return fsDecodeDoc(data);
}

/**
 * Atomic multi-doc commit (all writes apply or none — same guarantee as the
 * Firestore transactions in api/src/firestore.js). Preconditions give
 * optimistic concurrency: guard creates use exists:false, read-modify-write
 * docs use their read-phase updateTime. Throws with .code from the RPC
 * status (FAILED_PRECONDITION / ABORTED / ...) on contention.
 */
async function fsCommit(writes) {
  // NOTE: commit hangs under /documents (…/documents:commit), NOT directly
  // under the database — the latter 404s while every other call keeps working.
  const url = fsDocBase() + ":commit";
  const data = await fsFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ writes }),
  });
  // Never silently succeed: a null here (404/non-JSON) used to fake 201s
  // while nothing persisted. Fail loudly instead.
  if (!data) {
    const err = new Error("Firestore commit failed");
    err.status = 503;
    throw err;
  }
  return data;
}

function createWrite(collection, id, obj) {
  return {
    update: { name: fsDocName(collection, id), fields: fsEncodeFields(obj) },
    currentDocument: { exists: false },
  };
}

function updateWrite(collection, id, patch, updateTime) {
  const w = {
    update: { name: fsDocName(collection, id), fields: fsEncodeFields(patch) },
    updateMask: { fieldPaths: Object.keys(patch) },
  };
  if (updateTime) w.currentDocument = { updateTime };
  return w;
}

const RETRYABLE_CODES = new Set([
  "FAILED_PRECONDITION", "ABORTED", "ALREADY_EXISTS", "UNAVAILABLE",
  "RESOURCE_EXHAUSTED", "INTERNAL", "DEADLINE_EXCEEDED",
]);

function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Contention retry (mirrors db.runTransaction in api/src/firestore.js). */
async function withRetry(fn, attempts) {
  let lastErr = null;
  for (let i = 1; i <= (attempts || 4); i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!e || !RETRYABLE_CODES.has(e.code) || i === (attempts || 4)) throw e;
      await sleepMs(100 * 2 ** (i - 1));
    }
  }
  throw lastErr;
}

// ---------- shared business rules (copies of api/src/services/*.js) ----------
const trim3 = (n) => Number(n.toFixed(3));

function oversellShortage(stock, amountPerUnit, qty) {
  const raw = stock - amountPerUnit * qty;
  return raw < 0 ? trim3(-raw) : 0;
}

function fmtStock(n) { return trim3(n); }

function mapsForOrderLine(maps, productName, flavorKey) {
  const byItem = new Map();
  for (const m of maps) {
    if (m.productName !== productName) continue;
    if (m.flavor !== flavorKey && m.flavor !== "") continue;
    const current = byItem.get(m.itemName);
    if (!current || (m.flavor === flavorKey && current.flavor !== flavorKey)) {
      byItem.set(m.itemName, m);
    }
  }
  return [...byItem.values()];
}

function manilaDayRange(dateStr) {
  const start = new Date(String(dateStr) + "T00:00:00+08:00");
  if (!Number.isFinite(start.getTime())) return null;
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/** Allocate the next numeric ID for a collection via _counters (same scheme as api/src/firestore.js). */
async function allocNumericId(model) {
  const counter = await fsGet("_counters", model);
  const next = counter && counter.next !== undefined ? Number(counter.next) || 1 : 1;
  await fsFetch(fsDocBase() + "/_counters/" + encodeURIComponent(model) + "?updateMask.fieldPaths=next", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { next: { integerValue: String(next + 1) } } }),
  }).catch(() => {
    // Counter doc may not exist yet: create it (first allocation).
    return fsCreate("_counters", model, { next: next + 1 });
  });
  return next;
}

// ---------- auth helpers (mirror api/src/routes/auth.js + middleware/auth.js) ----------
async function publicUser(user) {
  let location = null;
  if (user.locationId !== null && user.locationId !== undefined) {
    const loc = await fsGet("locations", user.locationId).catch(() => null);
    if (loc) location = { id: loc.id, code: loc.code, name: loc.name };
  }
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
    location,
  };
}

async function mintSession(user) {
  const accessToken = await signHS256(
    { sub: user.id, username: user.username, role: user.role, name: user.name, type: "access" },
    jwtSecret(),
    15 * 60
  );
  const refreshToken = await signHS256(
    { sub: user.id, username: user.username, role: user.role, name: user.name, type: "refresh", jti: crypto.randomUUID() },
    refreshSecret(),
    30 * 24 * 60 * 60
  );
  const rid = await allocNumericId("refreshTokens");
  await fsCreate("refreshTokens", String(rid), {
    token: refreshToken,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    userId: user.id,
    createdAt: new Date(),
  });
  return { token: accessToken, refreshToken, user: await publicUser(user) };
}

/** Shared Bearer check: access tokens only, active accounts only (mirrors requireAuth). */
async function authUser(req) {
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return { user: null, error: { status: 401, body: { error: "Missing bearer token" } } };
  const payload = await verifyHS256(token, jwtSecret());
  if (!payload || payload.type !== "access" || payload.sub === undefined) {
    return { user: null, error: { status: 401, body: { error: "Invalid or expired token" } } };
  }
  const user = await fsGet("users", payload.sub);
  if (!user) return { user: null, error: { status: 404, body: { error: "User not found" } } };
  if (user.active === false) {
    return { user: null, error: { status: 401, body: { error: "Invalid or disabled account" } } };
  }
  return { user, error: null };
}

async function handleLogin(req, origin) {
  const body = await req.json().catch(() => null);
  const username = body ? body.username : undefined;
  const password = body ? body.password : undefined;
  if (!username || !password) {
    return jsonRes(origin, { error: "username and password are required" }, 400);
  }
  const cleanUsername = String(username).trim();
  const found = await fsQueryEqual("users", "username", cleanUsername, 1);
  const user = found[0] || null;
  if (!user || user.active === false) {
    return jsonRes(origin, { error: "Invalid credentials" }, 401);
  }
  const bl = await bcryptLib();
  if (!(await bl.compare(String(password), user.passwordHash))) {
    return jsonRes(origin, { error: "Invalid credentials" }, 401);
  }
  return jsonRes(origin, await mintSession(user), 200);
}

async function handleMe(req, origin) {
  const auth = await authUser(req);
  if (!auth.user) return jsonRes(origin, auth.error.body, auth.error.status);
  return jsonRes(origin, { user: await publicUser(auth.user) }, 200);
}

async function handleRefresh(req, origin) {
  const body = await req.json().catch(() => null);
  const refreshToken = body ? body.refreshToken : undefined;
  if (!refreshToken) {
    return jsonRes(origin, { error: "Refresh token is required" }, 400);
  }
  const payload = await verifyHS256(refreshToken, refreshSecret());
  if (!payload || payload.type !== "refresh") {
    return jsonRes(origin, { error: "Invalid or expired refresh token" }, 401);
  }
  const found = await fsQueryEqual("refreshTokens", "token", refreshToken, 1);
  const record = found[0] || null;
  if (!record) return jsonRes(origin, { error: "Invalid refresh token record" }, 401);
  if (record.expiresAt instanceof Date && Date.now() > record.expiresAt.getTime()) {
    return jsonRes(origin, { error: "Refresh token expired" }, 401);
  }
  try {
    await fsDeleteByName(record._name);
  } catch (e) {
    return jsonRes(origin, { error: "Session already refreshed - please use the latest tokens" }, 401);
  }
  const user = await fsGet("users", record.userId);
  if (!user) return jsonRes(origin, { error: "User not found" }, 404);
  if (user.active === false) return jsonRes(origin, { error: "Account disabled" }, 401);
  return jsonRes(origin, await mintSession(user), 200);
}

async function handleLogout(req, origin) {
  const body = await req.json().catch(() => null);
  const refreshToken = body ? body.refreshToken : undefined;
  if (!refreshToken) return jsonRes(origin, { loggedOut: true }, 200);
  const found = await fsQueryEqual("refreshTokens", "token", refreshToken, 1).catch(() => []);
  if (found[0]) {
    await fsDeleteByName(found[0]._name).catch(() => {});
  }
  return jsonRes(origin, { loggedOut: true }, 200);
}

// ---------- catalog (mirrors api/src/routes/catalog.js) ----------
// POS bootstrap: always fresh (full list, no cache). A stale catalog would
// sell removed products or wrong prices — correctness beats quota here.
async function handleCatalog(req, origin) {
  const auth = await authUser(req);
  if (!auth.user) return jsonRes(origin, auth.error.body, auth.error.status);
  const [products, locations, flavors] = await Promise.all([
    fsListAll("products"),
    fsListAll("locations"),
    fsListAll("flavors"),
  ]);
  const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""));
  const cleanFlavors = flavors.map(cleanDoc);
  const out = products
    .sort(byName)
    .map((p) => {
      const ids = new Set(p.flavorIds || []);
      const fl = cleanFlavors.filter((f) => ids.has(f.id)).sort(byName);
      const c = cleanDoc(p);
      delete c.flavorIds;
      c.flavors = fl;
      return c;
    });
  const locs = locations
    .filter((l) => l.status === "ACTIVE")
    .sort((a, b) => String(a.code || "").localeCompare(String(b.code || "")))
    .map((l) => ({ id: l.id, code: l.code, name: l.name }));
  return jsonRes(origin, { products: out, locations: locs }, 200);
}

// ---------- orders (mirrors api/src/routes/orders.js) ----------
const ORDER_PAYMENT_METHODS = ["CASH", "GCASH", "CARD"];

/** STAFF cart scoping (mirrors assertOwnLocation): OWNERs bypass. */
function checkOwnLocation(user, locationId) {
  if (user && user.role === "OWNER") return null;
  const own = user ? user.locationId : undefined;
  if (own === null || own === undefined) {
    return { status: 403, body: { error: "Forbidden: no cart assigned to this account" } };
  }
  if (Number(locationId) !== Number(own)) {
    return { status: 403, body: { error: "Forbidden: outside your assigned cart" } };
  }
  return null;
}

async function findOrderByClientRef(ref) {
  const found = await fsQueryEqual("orders", "clientRef", ref, 1);
  return found[0] || null;
}

function orderRefName(ref) {
  return fsDocBase() + "/orderRefs/" + encodeURIComponent(ref);
}

async function handleCreateOrder(req, origin, user) {
  const body = await req.json().catch(() => null);
  const { clientRef, locationCode, locationId, items, paymentMethod } = body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return jsonRes(origin, { error: "items must be a non-empty array" }, 400);
  }
  if (items.length > 100) {
    return jsonRes(origin, { error: "max 100 items per order" }, 400);
  }
  for (const it of items) {
    const qty = +it.qty;
    const price = +it.unitPrice;
    if (typeof it.productName !== "string" || !it.productName.trim() ||
        !Number.isInteger(qty) || qty < 1 || qty > 100 ||
        !Number.isFinite(price) || price < 0 || price > 10000) {
      return jsonRes(origin, {
        error: "each item needs a productName, an integer qty 1-100 and a unitPrice 0-10000",
      }, 400);
    }
  }
  if (locationId === undefined && (locationCode === undefined || locationCode === "")) {
    return jsonRes(origin, { error: "locationCode or locationId is required" }, 400);
  }
  if (locationId !== undefined && !Number.isInteger(+locationId)) {
    return jsonRes(origin, { error: "locationId must be an integer" }, 400);
  }
  if (clientRef !== undefined && String(clientRef).length > 200) {
    return jsonRes(origin, { error: "clientRef is too long (max 200 chars)" }, 400);
  }
  const payMethod =
    paymentMethod === undefined || paymentMethod === null || paymentMethod === ""
      ? null
      : String(paymentMethod).toUpperCase();
  if (payMethod !== null && !ORDER_PAYMENT_METHODS.includes(payMethod)) {
    return jsonRes(origin, { error: "paymentMethod must be one of: CASH, GCASH, CARD" }, 400);
  }

  let location = null;
  if (locationId !== undefined) {
    location = await fsGet("locations", +locationId);
  } else {
    const found = await fsQueryEqual("locations", "code", String(locationCode), 1);
    location = found[0] || null;
  }
  if (!location) return jsonRes(origin, { error: "Location not found" }, 404);
  const scopeErr = checkOwnLocation(user, location.id);
  if (scopeErr) return jsonRes(origin, scopeErr.body, scopeErr.status);

  const ref = clientRef ? String(clientRef) : (crypto.randomUUID ? crypto.randomUUID() : `ref-${Date.now()}`);

  // Fast-path idempotency check (the guard doc below wins any same-ref race).
  const existing = await findOrderByClientRef(ref);
  if (existing) {
    return jsonRes(origin, { duplicate: true, order: cleanDoc(existing), warnings: [] }, 200);
  }

  const outcome = await withRetry(async () => {
    // ---- READ PHASE ----
    const guard = await fsFetch(orderRefName(ref), { method: "GET" }).then(
      (d) => (d && d.fields ? { orderId: Number(d.fields.orderId && (d.fields.orderId.integerValue || 0)) } : null),
      () => null
    );
    if (guard) return { dup: true };
    const [maps, invRows, lowStock, catalogProducts, orderCounter, alertCounter] = await Promise.all([
      fsListAll("ingredientMaps"),
      fsQueryEqual("inventoryItems", "locationId", location.id, 10000),
      fsQueryEqual("alerts", "type", "LOW_STOCK", 10000),
      fsListAll("products"),
      fsGet("_counters", "orders"),
      fsGet("_counters", "alerts"),
    ]);
    const unreadAlerts = lowStock.filter((a) => a.isRead === false);
    const invByName = new Map(invRows.map((r) => [r.name, r]));
    const knownProducts = new Set(catalogProducts.map((p) => p.name));

    // ---- COMPUTE PHASE ----
    const orderTotal = items.reduce((sum, it) => sum + +it.qty * +it.unitPrice, 0);
    const itemRows = items.map((it) => ({
      productName: String(it.productName).trim().slice(0, 120),
      flavor: it.flavor == null ? null : String(it.flavor).slice(0, 80),
      qty: Math.trunc(+it.qty),
      unitPrice: +it.unitPrice,
    }));
    const warnings = [];
    const stockWrites = new Map();
    const createdNeedles = new Set();
    const newAlerts = [];
    for (const row of itemRows) {
      if (!knownProducts.has(row.productName)) {
        warnings.push(`unknown product "${row.productName}" — recorded without deduction`);
        continue;
      }
      const flavorKey = row.flavor ?? "";
      for (const map of mapsForOrderLine(maps, row.productName, flavorKey)) {
        const inv = invByName.get(map.itemName);
        if (!inv) {
          warnings.push(`no inventory row "${map.itemName}" at ${location.code}`);
          continue;
        }
        const base = stockWrites.has(inv.id) ? stockWrites.get(inv.id).newStock : inv.stock;
        const deduction = map.amountPerUnit * row.qty;
        const newStock = Math.max(0, base - deduction);
        const shortage = oversellShortage(base, map.amountPerUnit, row.qty);
        if (shortage > 0) {
          warnings.push(
            `OVERSOLD "${map.itemName}" at ${location.code}: requested ${fmtStock(deduction)} ${inv.unit}, had ${fmtStock(base)}, short ${fmtStock(shortage)}`
          );
        }
        const crossed = base > inv.threshold && newStock <= inv.threshold;
        stockWrites.set(inv.id, { inv, newStock });
        if (crossed) {
          const dedupeKey = `low:${location.id}:${inv.id}`;
          const dup =
            createdNeedles.has(dedupeKey) ||
            unreadAlerts.some((a) => {
              try {
                return JSON.parse(a.payload ?? "{}")?.dedupeKey === dedupeKey;
              } catch {
                return (a.message ?? "").includes(`${inv.name} @ ${location.code}`);
              }
            });
          if (!dup) {
            createdNeedles.add(dedupeKey);
            newAlerts.push({
              type: "LOW_STOCK",
              message: `${inv.name} @ ${location.code} dropped below threshold (${newStock} ${inv.unit} left)`,
              payload: JSON.stringify({
                dedupeKey,
                inventoryItemId: inv.id,
                locationId: location.id,
                stock: newStock,
                threshold: inv.threshold,
                unit: inv.unit,
              }),
            });
          }
        }
      }
    }

    // ---- ID ALLOCATION (from read-phase counters) ----
    const orderNext = orderCounter && orderCounter.next !== undefined ? Number(orderCounter.next) || 1 : 1;
    const alertNext = alertCounter && alertCounter.next !== undefined ? Number(alertCounter.next) || 1 : 1;
    const orderId = orderNext;
    itemRows.forEach((row, i) => { row.id = orderNext + 1 + i; });
    newAlerts.forEach((a, i) => {
      a.id = alertNext + i;
      a.isRead = false;
      a.ackedBy = null;
      a.ackedAt = null;
      a.ackedByName = null;
      a.createdAt = new Date();
    });
    const now = new Date();

    // ---- WRITE PHASE (single atomic commit) ----
    const writes = [
      {
        update: { name: fsDocName("orderRefs", ref), fields: fsEncodeFields({ orderId }) },
        currentDocument: { exists: false },
      },
      createWrite("orders", orderId, {
        id: orderId,
        clientRef: ref,
        locationId: location.id,
        staffId: user.id,
        total: orderTotal,
        status: "PAID",
        paymentMethod: payMethod,
        items: itemRows,
        createdAt: now,
        syncedAt: now,
        voidedBy: null,
        voidedAt: null,
        voidReason: null,
      }),
    ];
    for (const { inv, newStock } of stockWrites.values()) {
      writes.push(updateWrite("inventoryItems", inv.id,
        { stock: newStock, updatedAt: now }, inv._updateTime));
    }
    for (const a of newAlerts) {
      writes.push(createWrite("alerts", a.id, a));
    }
    writes.push(orderCounter && orderCounter._updateTime
      ? updateWrite("_counters", "orders", { next: orderNext + 1 + itemRows.length }, orderCounter._updateTime)
      : createWrite("_counters", "orders", { next: orderNext + 1 + itemRows.length }));
    if (newAlerts.length > 0) {
      writes.push(alertCounter && alertCounter._updateTime
        ? updateWrite("_counters", "alerts", { next: alertNext + newAlerts.length }, alertCounter._updateTime)
        : createWrite("_counters", "alerts", { next: alertNext + newAlerts.length }));
    }
    await fsCommit(writes);
    return {
      dup: false,
      order: {
        id: orderId, clientRef: ref, locationId: location.id, staffId: user.id,
        total: orderTotal, status: "PAID", paymentMethod: payMethod, items: itemRows,
        createdAt: now, syncedAt: now, voidedBy: null, voidedAt: null, voidReason: null,
      },
      warnings,
    };
  }, 4);

  if (outcome.dup) {
    const winner = await findOrderByClientRef(ref);
    if (winner) {
      return jsonRes(origin, { duplicate: true, order: cleanDoc(winner), warnings: [] }, 200);
    }
    return jsonRes(origin, { error: "Order commit did not persist" }, 500);
  }
  return jsonRes(origin, { duplicate: false, order: outcome.order, warnings: outcome.warnings, locationCode: location.code }, 201);
}

function emptyOrderMeta(page, pageSize) {
  return { total: 0, page, pageSize, totalPages: 1 };
}

async function handleListOrders(req, origin, url) {
  const params = url.searchParams;
  const location_code = params.get("location_code");
  const date = params.get("date");
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = Math.min(Number(params.get("pageSize")) || 10, 100);
  const cursor = params.get("cursor");
  const filters = [];
  if (location_code) {
    const loc = await fsQueryEqual("locations", "code", String(location_code), 1);
    if (!loc[0]) return jsonRes(origin, { data: [], meta: emptyOrderMeta(page, pageSize) }, 200);
    filters.push({ field: "locationId", op: "EQUAL", value: loc[0].id });
  }
  if (date) {
    const range = manilaDayRange(String(date));
    if (!range) return jsonRes(origin, { error: "date must be YYYY-MM-DD" }, 400);
    filters.push({ field: "createdAt", op: "GREATER_THAN_OR_EQUAL", value: range.start });
    filters.push({ field: "createdAt", op: "LESS_THAN", value: range.end });
  }
  const orderBy = [{ field: "createdAt", dir: "DESCENDING" }];
  const total = await fsCount("orders", filters);
  let slice;
  const decoded = cursor ? decodeCursor(cursor) : null;
  if (decoded) {
    slice = await fsRunQuery("orders", {
      filters,
      orderBy,
      limit: pageSize,
      startAt: { values: [fsEncodeValue(decoded.t)] },
    });
  } else {
    slice = await fsRunQuery("orders", {
      filters,
      orderBy,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
  }
  const [locations, users] = await Promise.all([fsListAll("locations"), fsListAll("users")]);
  const locById = new Map(locations.map((l) => [l.id, l]));
  const userById = new Map(users.map((u) => [u.id, u]));
  const data = slice.map((o) => {
    const c = cleanDoc(o);
    const loc = locById.get(o.locationId);
    const staff = userById.get(o.staffId);
    c.location = loc ? { code: loc.code, name: loc.name } : null;
    c.staff = staff ? { name: staff.name } : null;
    return c;
  });
  const last = slice[slice.length - 1];
  return jsonRes(origin, {
    data,
    meta: { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    ...(last ? { nextCursor: encodeCursor(last, "createdAt") } : {}),
  }, 200);
}

async function handlePatchOrder(req, origin, orderId, user) {
  if (user.role !== "OWNER") {
    return jsonRes(origin, { error: "Forbidden: insufficient role" }, 403);
  }
  const body = await req.json().catch(() => null);
  const { status, reason, paymentMethod } = body || {};
  if (status !== undefined && status !== "VOID") {
    return jsonRes(origin, { error: 'only status "VOID" is supported (omit status to edit payment method)' }, 400);
  }
  const existing = await fsGet("orders", orderId);
  if (!existing) return jsonRes(origin, { error: "Order not found" }, 404);

  // Payment-method correction on a PAID order (stock untouched).
  if (status === undefined) {
    if (paymentMethod === undefined) {
      return jsonRes(origin, { error: "provide paymentMethod or status VOID" }, 400);
    }
    if (existing.status === "VOID") {
      return jsonRes(origin, { error: "VOID orders cannot be edited" }, 400);
    }
    const payMethod = String(paymentMethod).toUpperCase();
    if (!ORDER_PAYMENT_METHODS.includes(payMethod)) {
      return jsonRes(origin, { error: "paymentMethod must be one of: CASH, GCASH, CARD" }, 400);
    }
    await fsPatch("orders", existing.id, { paymentMethod: payMethod });
    const updated = await fsGet("orders", existing.id);
    return jsonRes(origin, { order: cleanDoc(updated) }, 200);
  }

  // VOID flow.
  if (existing.status === "VOID") {
    return jsonRes(origin, { error: "Order is already void" }, 400);
  }
  if (env("VOID_RESTORE") === "false") {
    await fsPatch("orders", existing.id, {
      status: "VOID",
      voidedBy: user.id,
      voidedAt: new Date(),
      voidReason: reason ? String(reason).slice(0, 500) : null,
    });
    const updated = await fsGet("orders", existing.id);
    return jsonRes(origin, { order: cleanDoc(updated), restored: [], warnings: [] }, 200);
  }

  const outcome = await withRetry(async () => {
    const fresh = await fsGet("orders", existing.id);
    if (!fresh) {
      throw Object.assign(new Error("Order not found"), { status: 404 });
    }
    if (fresh.status === "VOID") {
      throw Object.assign(new Error("Order is already void"), { status: 409 });
    }
    const [maps, invRows, adjCounter] = await Promise.all([
      fsListAll("ingredientMaps"),
      fsQueryEqual("inventoryItems", "locationId", fresh.locationId, 10000),
      fsGet("_counters", "stockAdjustments"),
    ]);
    const invByName = new Map(invRows.map((r) => [r.name, r]));
    const warnings = [];
    const restores = new Map();
    for (const row of fresh.items || []) {
      const flavorKey = row.flavor ?? "";
      const byItem = new Map();
      for (const m of maps) {
        if (m.productName !== row.productName) continue;
        if (m.flavor !== flavorKey && m.flavor !== "") continue;
        const current = byItem.get(m.itemName);
        if (!current || (m.flavor === flavorKey && current.flavor !== flavorKey)) {
          byItem.set(m.itemName, m);
        }
      }
      for (const map of byItem.values()) {
        const inv = invByName.get(map.itemName);
        if (!inv) {
          warnings.push(`no inventory row "${map.itemName}" at void — restore skipped`);
          continue;
        }
        const add = map.amountPerUnit * row.qty;
        const prev = restores.has(inv.id) ? restores.get(inv.id).newStock : inv.stock;
        restores.set(inv.id, { inv, newStock: prev + add, added: (restores.get(inv.id)?.added ?? 0) + add });
      }
    }
    const adjNext = adjCounter && adjCounter.next !== undefined ? Number(adjCounter.next) || 1 : 1;
    const now = new Date();
    const writes = [];
    let i = 0;
    const restored = [];
    for (const { inv, newStock, added } of restores.values()) {
      writes.push(updateWrite("inventoryItems", inv.id,
        { stock: newStock, updatedAt: now }, inv._updateTime));
      writes.push(createWrite("stockAdjustments", adjNext + i, {
        id: adjNext + i,
        inventoryItemId: inv.id,
        locationId: inv.locationId,
        actorId: user.id,
        before: inv.stock,
        after: newStock,
        reason: `VOID order #${existing.id}: restored ${added} ${inv.unit}${reason ? ` — ${String(reason).slice(0, 200)}` : ""}`.slice(0, 500),
        createdAt: now,
      }));
      restored.push({ item: inv.name, restored: added, stock: newStock });
      i++;
    }
    if (restores.size > 0) {
      writes.push(adjCounter && adjCounter._updateTime
        ? updateWrite("_counters", "stockAdjustments", { next: adjNext + restores.size }, adjCounter._updateTime)
        : createWrite("_counters", "stockAdjustments", { next: adjNext + restores.size }));
    }
    writes.push(updateWrite("orders", fresh.id, {
      status: "VOID",
      voidedBy: user.id,
      voidedAt: now,
      voidReason: reason ? String(reason).slice(0, 500) : null,
    }, fresh._updateTime));
    await fsCommit(writes);
    return { warnings, restored };
  }, 4);

  const order = await fsGet("orders", existing.id);
  return jsonRes(origin, { order: cleanDoc(order), restored: outcome.restored, warnings: outcome.warnings }, 200);
}

// ---------- locations + devices (mirror api/src/routes/locations.js, devices.js) ----------
const CODE_RE = /^[A-Z0-9-]{3,12}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{3,40}$/;

const INVENTORY_TEMPLATE = [
  { name: "LPG Tank", unit: "kg", stock: 11.0, threshold: 2.5, source: "SENSOR" },
  { name: "Cheese Powder", unit: "kg", stock: 3.0, threshold: 1.0, source: "SENSOR" },
  { name: "Sour Cream Powder", unit: "kg", stock: 2.0, threshold: 1.0, source: "MANUAL" },
  { name: "BBQ Powder", unit: "kg", stock: 2.0, threshold: 1.0, source: "MANUAL" },
  { name: "Sinigang Powder", unit: "kg", stock: 2.0, threshold: 1.0, source: "MANUAL" },
  { name: "Fries (frozen packs)", unit: "packs", stock: 12, threshold: 4, source: "MANUAL" },
  { name: "Pouches", unit: "pcs", stock: 150, threshold: 50, source: "MANUAL" },
];

function countLetters(s) {
  const m = String(s ?? "").match(/\p{L}/gu);
  return m ? m.length : 0;
}

function randomHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** OWNER gate (mirrors requireRole("OWNER")). */
function requireOwner(user) {
  if (!user || user.role !== "OWNER") {
    return { status: 403, body: { error: "Forbidden: insufficient role" } };
  }
  return null;
}

/** Read several _counters docs at once (read phase). */
async function readCounters(models) {
  const out = {};
  await Promise.all(models.map(async (m) => { out[m] = await fsGet("_counters", m); }));
  return out;
}

/**
 * Allocate numeric ID blocks from read-phase counters.
 * Returns { ids, writes } — caller appends writes to its atomic commit and
 * runs everything inside withRetry so counter races recompute cleanly.
 */
function counterWritesFor(counters, alloc) {
  const ids = {};
  const writes = [];
  for (const [model, n] of Object.entries(alloc)) {
    if (!n) { ids[model] = []; continue; }
    const c = counters[model];
    const next = c && c.next !== undefined ? Number(c.next) || 1 : 1;
    ids[model] = Array.from({ length: n }, (_, i) => next + i);
    writes.push(c && c._updateTime
      ? updateWrite("_counters", model, { next: next + n }, c._updateTime)
      : createWrite("_counters", model, { next: next + n }));
  }
  return { ids, writes };
}

function deviceOnline(lastSeenAt) {
  if (lastSeenAt === null || lastSeenAt === undefined) return false;
  const t = lastSeenAt instanceof Date ? lastSeenAt.getTime() : new Date(lastSeenAt).getTime();
  return Date.now() - t < 5 * 60 * 1000;
}

async function handleListLocations(origin) {
  const [locations, items, devices] = await Promise.all([
    fsListAll("locations"),
    fsListAll("inventoryItems"),
    fsListAll("devices"),
  ]);
  const itemCount = new Map();
  for (const it of items) itemCount.set(it.locationId, (itemCount.get(it.locationId) ?? 0) + 1);
  const deviceByLoc = new Map(devices.map((d) => [d.locationId, d]));
  locations.sort((a, b) => String(a.code || "").localeCompare(String(b.code || "")));
  return {
    data: locations.map((loc) => {
      const dev = deviceByLoc.get(loc.id) ?? null;
      return {
        id: loc.id,
        code: loc.code,
        name: loc.name,
        address: loc.address ?? null,
        status: loc.status ?? "ACTIVE",
        itemCount: itemCount.get(loc.id) ?? 0,
        device: dev
          ? { deviceId: dev.deviceId, active: dev.active, online: deviceOnline(dev.lastSeenAt) }
          : null,
      };
    }),
  };
}

async function handleCreateLocation(req, origin) {
  const body = await req.json().catch(() => null);
  const { code, name, address, seedInventory = true } = body || {};
  const cartCode = String(code ?? "").trim().toUpperCase();
  if (!CODE_RE.test(cartCode)) {
    return { status: 400, body: { error: "code must be 3-12 chars: A-Z, 0-9, dash (e.g. CART-04)" } };
  }
  const cartName = String(name ?? "").trim();
  if (cartName.length < 2 || cartName.length > 120 || countLetters(cartName) < 2) {
    return { status: 400, body: { error: "name needs at least 2 letters (max 120 characters)" } };
  }
  if (await fsQueryEqual("locations", "code", cartCode, 1).then((r) => r[0])) {
    return { status: 409, body: { error: `Cart "${cartCode}" already exists` } };
  }
  const deviceId = `esp32-${cartCode.toLowerCase()}`;
  if (await fsQueryEqual("devices", "deviceId", deviceId, 1).then((r) => r[0])) {
    return { status: 409, body: { error: `Device "${deviceId}" already exists` } };
  }
  const bl = await bcryptLib();
  const deviceToken = `dev-${cartCode}-${randomHex(4)}`;
  const tokenHash = await bl.hash(deviceToken, 10);
  const rows = seedInventory === false ? [] : INVENTORY_TEMPLATE;
  const now = new Date();

  const result = await withRetry(async () => {
    const counters = await readCounters(["locations", "inventoryItems", "devices"]);
    const { ids, writes } = counterWritesFor(counters, {
      locations: 1, inventoryItems: rows.length, devices: 1,
    });
    const [locationId] = ids.locations;
    const [deviceRowId] = ids.devices;
    const location = {
      id: locationId, code: cartCode, name: cartName,
      address: address ? String(address).slice(0, 200) : null, status: "ACTIVE",
    };
    writes.push(createWrite("locations", locationId, location));
    const items = rows.map((row, i) => ({
      id: ids.inventoryItems[i], locationId, ...row, updatedAt: now,
    }));
    for (const it of items) writes.push(createWrite("inventoryItems", it.id, it));
    const device = { id: deviceRowId, deviceId, locationId, tokenHash, active: true, lastSeenAt: null };
    writes.push(createWrite("devices", deviceRowId, device));
    await fsCommit(writes);
    return { location, items, device };
  }, 4);

  return {
    status: 201,
    body: {
      location: cleanDoc(result.location),
      items: result.items.map(cleanDoc),
      device: { deviceId: result.device.deviceId, active: result.device.active },
      deviceToken,
    },
  };
}

async function handlePatchLocation(req, origin, id) {
  const body = await req.json().catch(() => null);
  const { name, address, status } = body || {};
  if (name === undefined && address === undefined && status === undefined) {
    return { status: 400, body: { error: "provide name, address, or status" } };
  }
  const existing = await fsGet("locations", id);
  if (!existing) return { status: 404, body: { error: "Location not found" } };
  const data = {};
  if (name !== undefined) {
    const cartName = String(name).trim();
    if (cartName.length < 2 || cartName.length > 120 || countLetters(cartName) < 2) {
      return { status: 400, body: { error: "name needs at least 2 letters (max 120 characters)" } };
    }
    data.name = cartName;
  }
  if (address !== undefined) {
    data.address = address === null || address === "" ? null : String(address).slice(0, 200);
  }
  if (status !== undefined) {
    const st = String(status).toUpperCase();
    if (!["ACTIVE", "INACTIVE"].includes(st)) {
      return { status: 400, body: { error: 'status must be "ACTIVE" or "INACTIVE"' } };
    }
    data.status = st;
  }
  await fsPatch("locations", existing.id, data);
  return { status: 200, body: { location: cleanDoc(await fsGet("locations", existing.id)) } };
}

async function handleListDevices() {
  const [devices, locations] = await Promise.all([fsListAll("devices"), fsListAll("locations")]);
  const locById = new Map(locations.map((l) => [l.id, l]));
  devices.sort((a, b) => String(a.deviceId || "").localeCompare(String(b.deviceId || "")));
  return {
    data: devices.map((d) => {
      const loc = locById.get(d.locationId);
      return {
        id: d.id,
        device_id: d.deviceId,
        cart: loc ? loc.code : "-",
        cart_name: loc ? loc.name : "",
        active: d.active,
        last_seen_at: d.lastSeenAt ?? null,
        online: deviceOnline(d.lastSeenAt),
      };
    }),
  };
}

async function handleCreateDevice(req) {
  const body = await req.json().catch(() => null);
  const { deviceId, cart } = body || {};
  const cleanId = String(deviceId ?? "").trim();
  if (!DEVICE_ID_RE.test(cleanId)) {
    return { status: 400, body: { error: "deviceId must be 3-40 chars: letters, digits, _ or -" } };
  }
  if (await fsQueryEqual("devices", "deviceId", cleanId, 1).then((r) => r[0])) {
    return { status: 409, body: { error: `Device "${cleanId}" already exists` } };
  }
  let locationId = null;
  if (cart) {
    const loc = await fsQueryEqual("locations", "code", String(cart), 1).then((r) => r[0]);
    if (!loc) return { status: 404, body: { error: "Location not found" } };
    locationId = loc.id;
  }
  const bl = await bcryptLib();
  const deviceToken = `dev-${randomHex(8)}`;
  const tokenHash = await bl.hash(deviceToken, 10);
  const device = await withRetry(async () => {
    const counters = await readCounters(["devices"]);
    const { ids, writes } = counterWritesFor(counters, { devices: 1 });
    const doc = { id: ids.devices[0], deviceId: cleanId, locationId, tokenHash, active: true, lastSeenAt: null };
    writes.push(createWrite("devices", doc.id, doc));
    await fsCommit(writes);
    return doc;
  }, 4);
  return {
    status: 201,
    body: { device: { id: device.id, deviceId: device.deviceId, active: device.active }, deviceToken },
  };
}

async function handlePatchDevice(req, id) {
  const body = await req.json().catch(() => null);
  const { cart, active } = body || {};
  const device = await fsGet("devices", id);
  if (!device) return { status: 404, body: { error: "Device not found" } };
  const data = {};
  if (cart !== undefined) {
    if (cart === null || cart === "") {
      data.locationId = null;
    } else {
      const loc = await fsQueryEqual("locations", "code", String(cart), 1).then((r) => r[0]);
      if (!loc) return { status: 404, body: { error: "Location not found" } };
      data.locationId = loc.id;
    }
  }
  if (active !== undefined) data.active = Boolean(active);
  await fsPatch("devices", device.id, data);
  const updated = await fsGet("devices", device.id);
  return { status: 200, body: { device: { id: updated.id, deviceId: updated.deviceId, active: updated.active } } };
}

async function handleDeleteDevice(id) {
  const device = await fsGet("devices", id);
  if (!device) return { status: 404, body: { error: "Device not found" } };
  await fsFetch("https://firestore.googleapis.com/v1/" + device._name, { method: "DELETE" });
  return { status: 200, body: { deleted: true } };
}

// ---------- inventory (mirror api/src/routes/inventory.js) ----------
function stockStatus(stock, threshold) {
  if (stock <= threshold / 2) return "critical";
  if (stock <= threshold) return "low";
  return "ok";
}

function decorateItems(items) {
  return items.map((it) => {
    const c = cleanDoc(it);
    c.status = stockStatus(it.stock, it.threshold);
    return c;
  });
}

async function resolveLocation(locationId, locationCode) {
  if (locationId !== undefined) {
    return await fsGet("locations", +locationId);
  }
  const found = await fsQueryEqual("locations", "code", String(locationCode), 1);
  return found[0] || null;
}

async function handleListInventory(url) {
  const code = url.searchParams.get("code");
  let locations;
  if (code) {
    locations = await fsQueryEqual("locations", "code", String(code), 1);
  } else {
    locations = await fsListAll("locations");
    locations.sort((a, b) => String(a.code || "").localeCompare(String(b.code || "")));
  }
  const items = await fsListAll("inventoryItems");
  const byLoc = new Map();
  for (const it of items) {
    if (!byLoc.has(it.locationId)) byLoc.set(it.locationId, []);
    byLoc.get(it.locationId).push(it);
  }
  return {
    locations: locations.map((loc) => ({
      id: loc.id,
      code: loc.code,
      name: loc.name,
      items: decorateItems((byLoc.get(loc.id) || []).sort((a, b) =>
        String(a.name || "").localeCompare(String(b.name || "")))),
    })),
  };
}

async function handleInventoryNames() {
  const rows = await fsListAll("inventoryItems");
  const byName = new Map();
  for (const r of rows) {
    const name = String(r.name ?? "").trim();
    if (!name) continue;
    let hit = byName.get(name);
    if (!hit) { hit = { name, units: new Map() }; byName.set(name, hit); }
    hit.units.set(r.unit, (hit.units.get(r.unit) ?? 0) + 1);
  }
  return {
    data: [...byName.values()]
      .map(({ name, units }) => ({
        name,
        unit: [...units.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function handleCreateInventoryItem(req) {
  const body = await req.json().catch(() => null);
  const { locationCode, locationId, name, unit, stock, threshold, source } = body || {};
  if (locationId === undefined && (locationCode === undefined || locationCode === "")) {
    return { status: 400, body: { error: "locationCode or locationId is required" } };
  }
  if (locationId !== undefined && !Number.isInteger(+locationId)) {
    return { status: 400, body: { error: "locationId must be an integer" } };
  }
  const itemName = String(name ?? "").trim().slice(0, 120);
  if (!itemName) {
    return { status: 400, body: { error: "name is required" } };
  }
  const unitStr = String(unit ?? "pcs").trim().slice(0, 20) || "pcs";
  const stockNum = stock === undefined || stock === "" ? 0 : +stock;
  const thresholdNum = threshold === undefined || threshold === "" ? 0 : +threshold;
  if (!Number.isFinite(stockNum) || stockNum < 0 || stockNum > 100000 ||
      !Number.isFinite(thresholdNum) || thresholdNum < 0 || thresholdNum > 100000) {
    return { status: 400, body: { error: "stock and threshold must be 0-100000" } };
  }
  const src = source === "SENSOR" ? "SENSOR" : "MANUAL";
  const location = await resolveLocation(locationId, locationCode);
  if (!location) return { status: 404, body: { error: "Location not found" } };
  const siblings = await fsQueryEqual("inventoryItems", "locationId", location.id, 10000);
  if (siblings.some((s) => s.name === itemName)) {
    return { status: 409, body: { error: `Item "${itemName}" already exists at ${location.code}` } };
  }
  const created = await withRetry(async () => {
    const counters = await readCounters(["inventoryItems"]);
    const { ids, writes } = counterWritesFor(counters, { inventoryItems: 1 });
    const doc = {
      id: ids.inventoryItems[0], locationId: location.id, name: itemName,
      unit: unitStr, stock: stockNum, threshold: thresholdNum, source: src, updatedAt: new Date(),
    };
    writes.push(createWrite("inventoryItems", doc.id, doc));
    await fsCommit(writes);
    return doc;
  }, 4);
  return { status: 201, body: { item: decorateItems([created])[0], locationCode: location.code } };
}

async function handlePatchInventoryItem(req, id) {
  const body = await req.json().catch(() => null);
  const { threshold } = body || {};
  if (threshold === undefined || !Number.isFinite(+threshold) || +threshold < 0 || +threshold > 100000) {
    return { status: 400, body: { error: "threshold must be 0-100000" } };
  }
  const item = await fsGet("inventoryItems", id);
  if (!item) return { status: 404, body: { error: "Inventory item not found" } };
  await fsPatch("inventoryItems", item.id, { threshold: +threshold });
  return { status: 200, body: { item: decorateItems([await fsGet("inventoryItems", item.id)])[0] } };
}

async function handleDeleteInventoryItem(id) {
  const existing = await fsGet("inventoryItems", id);
  if (!existing) return { status: 404, body: { error: "Inventory item not found" } };
  if (existing.source === "SENSOR") {
    return { status: 409, body: { error: `Cannot delete "${existing.name}": sensor-managed stock row` } };
  }
  const maps = await fsQueryEqual("ingredientMaps", "itemName", existing.name, 10000);
  if (maps.length > 0) {
    return {
      status: 409,
      body: { error: `Cannot delete "${existing.name}": referenced by ${maps.length} recipe row(s)`, recipeRows: maps.length },
    };
  }
  await fsFetch("https://firestore.googleapis.com/v1/" + existing._name, { method: "DELETE" });
  return { status: 200, body: { deleted: true } };
}

async function handleInventoryAdjustment(req, user) {
  const body = await req.json().catch(() => null);
  const { inventoryItemId, newStock, reason } = body || {};
  if (!Number.isInteger(+inventoryItemId) || !Number.isFinite(+newStock) || +newStock < 0 || +newStock > 100000) {
    return { status: 400, body: { error: "inventoryItemId and newStock 0-100000 are required" } };
  }
  if (user.role !== "OWNER" && !String(reason ?? "").trim()) {
    return { status: 400, body: { error: "reason is required for staff adjustments" } };
  }
  const item = await fsGet("inventoryItems", +inventoryItemId);
  if (!item) return { status: 404, body: { error: "Inventory item not found" } };

  let outcome;
  try {
    outcome = await withRetry(async () => {
      // Re-read INSIDE the attempt: the outside read can be stale when a POS
      // sale deducts concurrently — `before` below is the true pre-write stock.
      const fresh = await fsGet("inventoryItems", item.id);
      if (!fresh) {
        throw Object.assign(new Error("Inventory item not found"), { status: 404 });
      }
      const scopeErr = checkOwnLocation(user, fresh.locationId);
      if (scopeErr) throw Object.assign(new Error(scopeErr.body.error), { status: scopeErr.status });
      const counters = await readCounters(["stockAdjustments"]);
      const { ids, writes } = counterWritesFor(counters, { stockAdjustments: 1 });
      const now = new Date();
      writes.push(updateWrite("inventoryItems", fresh.id,
        { stock: +newStock, updatedAt: now }, fresh._updateTime));
      const adj = {
        id: ids.stockAdjustments[0], inventoryItemId: fresh.id, locationId: fresh.locationId,
        actorId: user.id, before: fresh.stock, after: +newStock,
        reason: reason ? String(reason).slice(0, 500) : null, createdAt: now,
      };
      writes.push(createWrite("stockAdjustments", adj.id, adj));
      await fsCommit(writes);
      return { updated: { ...fresh, stock: +newStock, updatedAt: now }, adjustment: adj };
    }, 4);
  } catch (e) {
    if (e && (e.status === 404 || e.status === 403)) {
      return { status: e.status, body: { error: String((e && e.message) || "Error") } };
    }
    throw e;
  }
  const { updated, adjustment } = outcome;

  if (updated.stock <= updated.threshold) {
    const counters = await readCounters(["alerts"]).catch(() => ({}));
    const { ids, writes } = counterWritesFor(counters, { alerts: 1 });
    const alert = {
      id: ids.alerts[0],
      type: "LOW_STOCK",
      message: `${item.name} @ manual adjustment set to ${updated.stock} ${item.unit} (threshold ${updated.threshold})`,
      payload: JSON.stringify({
        dedupeKey: `low:${item.locationId}:${item.id}:manual:${Date.now()}`,
        inventoryItemId: item.id,
        locationId: item.locationId,
        reason: reason ?? null,
      }),
      isRead: false, ackedBy: null, ackedAt: null, ackedByName: null, createdAt: new Date(),
    };
    writes.push(createWrite("alerts", alert.id, alert));
    await fsCommit(writes).catch(() => {});
  }
  return {
    status: 200,
    body: {
      item: decorateItems([updated])[0],
      adjustment: {
        id: adjustment.id, actorId: adjustment.actorId,
        before: adjustment.before, after: adjustment.after, reason: adjustment.reason,
      },
    },
  };
}

// ---------- alerts + reports (mirror api/src/routes/alerts.js, reports.js) ----------
async function handleListAlerts(url) {
  const unreadOnly = url.searchParams.get("unread_only") === "true";
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const pageSize = Math.min(Number(url.searchParams.get("pageSize")) || 10, 100);
  const cursor = url.searchParams.get("cursor");
  const filters = unreadOnly ? [{ field: "isRead", op: "EQUAL", value: false }] : [];
  const orderBy = [{ field: "createdAt", dir: "DESCENDING" }];
  const total = await fsCount("alerts", filters);
  const decoded = cursor ? decodeCursor(cursor) : null;
  const slice = decoded
    ? await fsRunQuery("alerts", { filters, orderBy, limit: pageSize, startAt: { values: [fsEncodeValue(decoded.t)] } })
    : await fsRunQuery("alerts", { filters, orderBy, limit: pageSize, offset: (page - 1) * pageSize });
  const last = slice[slice.length - 1];
  return {
    data: slice.map(cleanDoc),
    meta: { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    ...(last ? { nextCursor: encodeCursor(last, "createdAt") } : {}),
  };
}

async function handleAlertsReadAll(req) {
  const body = await req.json().catch(() => null);
  const ids = body && Array.isArray(body.ids)
    ? body.ids.map(Number).filter((n) => Number.isInteger(n))
    : null;
  const idSet = ids && ids.length > 0 ? new Set(ids) : null;
  const alerts = await fsListAll("alerts");
  const targets = alerts.filter((a) => a.isRead === false && (!idSet || idSet.has(Number(a.id))));
  const writes = targets.map((a) =>
    updateWrite("alerts", String(a._name.split("/").pop()), { isRead: true }, a._updateTime));
  for (let i = 0; i < writes.length; i += 400) {
    const chunk = writes.slice(i, i + 400);
    if (chunk.length > 0) await fsCommit(chunk).catch(() => {});
  }
  // Fallback for docs whose precondition write raced: patch them directly.
  let updated = 0;
  for (const a of targets) {
    const fresh = await fsGet("alerts", a.id).catch(() => null);
    if (fresh && fresh.isRead === false) {
      await fsPatch("alerts", fresh.id, { isRead: true }).catch(() => {});
    }
    updated++;
  }
  return { updated };
}

async function handleAlertReadOne(id) {
  const alert = await fsGet("alerts", id);
  if (!alert) return { status: 404, body: { error: "Alert not found" } };
  await fsPatch("alerts", alert.id, { isRead: true });
  return { status: 200, body: { alert: cleanDoc(await fsGet("alerts", alert.id)) } };
}

async function handleAlertAck(req, id, user) {
  const alert = await fsGet("alerts", id);
  if (!alert) return { status: 404, body: { error: "Alert not found" } };
  await fsPatch("alerts", alert.id, {
    ackedBy: user.id,
    ackedAt: new Date(),
    ackedByName: user.name ?? user.username,
  });
  return { status: 200, body: { alert: cleanDoc(await fsGet("alerts", alert.id)) } };
}

function manilaDayStart(daysAgo) {
  const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
  const manilaNow = new Date(Date.now() + MANILA_OFFSET_MS);
  manilaNow.setUTCHours(0, 0, 0, 0);
  manilaNow.setUTCDate(manilaNow.getUTCDate() - (daysAgo || 0));
  return new Date(manilaNow.getTime() - MANILA_OFFSET_MS);
}

async function handleDailyReport(url) {
  const params = url.searchParams;
  const date = params.get("date");
  const code = params.get("code");
  const daysAgo = params.get("daysAgo");
  let day, nextDay;
  if (date) {
    const range = manilaDayRange(String(date));
    if (!range) return { status: 400, body: { error: "date must be YYYY-MM-DD" } };
    day = range.start;
    nextDay = range.end;
  } else if (daysAgo != null) {
    const n = Number(daysAgo);
    if (!Number.isInteger(n) || n < 0) {
      return { status: 400, body: { error: "daysAgo must be an integer >= 0" } };
    }
    day = manilaDayStart(n);
    nextDay = new Date(day.getTime() + 24 * 60 * 60 * 1000);
  } else {
    day = manilaDayStart(0);
    nextDay = new Date(day.getTime() + 24 * 60 * 60 * 1000);
  }
  let orders = await fsListAll("orders");
  orders = orders.filter((o) =>
    o.createdAt instanceof Date && o.createdAt >= day && o.createdAt < nextDay && o.status === "PAID");
  if (code) {
    const loc = await fsQueryEqual("locations", "code", String(code), 1).then((r) => r[0]);
    orders = loc ? orders.filter((o) => Number(o.locationId) === Number(loc.id)) : [];
  }
  const totalSales = orders.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
  const itemCounts = new Map();
  for (const order of orders) {
    for (const item of order.items || []) {
      const key = `${item.productName}|${item.flavor ?? ""}`;
      const current = itemCounts.get(key) ?? { name: item.productName, flavor: item.flavor, qty: 0 };
      current.qty += item.qty;
      itemCounts.set(key, current);
    }
  }
  const topItems = [...itemCounts.values()].sort((a, b) => b.qty - a.qty).slice(0, 5);
  const pad = (n) => String(n).padStart(2, "0");
  const manilaDay = new Date(day.getTime() + 8 * 60 * 60 * 1000);
  return {
    status: 200,
    body: {
      date: `${manilaDay.getUTCFullYear()}-${pad(manilaDay.getUTCMonth() + 1)}-${pad(manilaDay.getUTCDate())}`,
      location: code ?? "ALL",
      total_sales: totalSales,
      orders: orders.length,
      top_items: topItems,
    },
  };
}

// ---------- products + flavors (mirror api/src/routes/products.js) ----------
function validProductName(name) {
  const n = String(name ?? "").trim();
  return n.length >= 2 && n.length <= 120 && countLetters(n) >= 2;
}

function validPrice(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function validRecipeRow(r) {
  const itemName = String(r?.itemName ?? "").trim();
  const amount = Number(r?.amountPerUnit);
  if (!itemName || itemName.length > 120) return null;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return { itemName, amountPerUnit: amount };
}

async function resolveFlavorEntries(entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length > 20) return { error: "at most 20 flavors per product" };
  const flavors = await fsListAll("flavors");
  const byId = new Map(flavors.map((f) => [Number(f.id), f]));
  const byName = new Map(flavors.map((f) => [String(f.name).toLowerCase(), f]));
  const idByName = new Map(flavors.map((f) => [String(f.name).toLowerCase(), Number(f.id)]));
  const ids = [];
  const seen = new Set();
  const created = [];
  for (const e of list) {
    let id = null;
    const asObj = e !== null && typeof e === "object" ? e : null;
    const rawId = asObj ? (asObj.flavorId ?? asObj.id) : e;
    if (typeof rawId === "number" || (typeof rawId === "string" && /^\d+$/.test(rawId.trim()))) {
      id = Number(rawId);
      if (!byId.has(id)) return { error: "One or more flavors not found" };
    } else {
      const name = String(asObj ? (asObj.name ?? "") : (e ?? "")).trim();
      if (!name || name.length > 60) {
        return { error: "flavor name must be 1-60 characters" };
      }
      const hit = byName.get(name.toLowerCase());
      if (hit) {
        id = Number(hit.id);
      } else {
        const counters = await readCounters(["flavors"]);
        const { ids: newIds, writes } = counterWritesFor(counters, { flavors: 1 });
        const doc = { id: newIds.flavors[0], name };
        writes.push(createWrite("flavors", doc.id, doc));
        await fsCommit(writes);
        const f = await fsGet("flavors", doc.id);
        byId.set(Number(f.id), f);
        byName.set(name.toLowerCase(), f);
        idByName.set(name.toLowerCase(), Number(f.id));
        created.push(f);
        id = Number(f.id);
      }
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return { ids, byId, idByName, created };
}

async function flavorIdsExist(ids) {
  if (!ids || ids.length === 0) return true;
  const flavors = await fsListAll("flavors");
  const have = new Set(flavors.map((f) => Number(f.id)));
  return ids.every((id) => have.has(Number(id)));
}

/** Upsert recipe rows for one (productName, flavorName) pair. Returns { created } or { error }. */
async function upsertRecipeRows(productName, flavorName, rows) {
  let created = 0;
  const existing = await fsQueryEqual("ingredientMaps", "productName", productName, 10000);
  for (const r of rows ?? []) {
    const row = validRecipeRow(r);
    if (!row) return { error: `recipe rows need itemName (1-120 chars) and amountPerUnit > 0` };
    const match = existing.filter((m) => m.flavor === flavorName && m.itemName === row.itemName);
    if (match.length > 0) {
      for (const m of match) {
        await fsPatch("ingredientMaps", String(m._name.split("/").pop()), { amountPerUnit: row.amountPerUnit });
      }
    } else {
      await fsCreate("ingredientMaps", null, {
        productName, flavor: flavorName, itemName: row.itemName, amountPerUnit: row.amountPerUnit,
      });
      created += 1;
    }
  }
  return { created };
}

function attachFlavors(product, flavors, maps, orders, invNames) {
  const flavorPrices = product.flavorPrices ?? {};
  const flavorKey = (pn, f) => JSON.stringify([pn, f ?? ""]);
  const recipeByFlavor = new Map();
  const itemsByFlavor = new Map();
  const rowsByFlavor = new Map();
  for (const m of maps.filter((m) => m.productName === product.name)) {
    const key = flavorKey(m.productName, m.flavor);
    recipeByFlavor.set(key, (recipeByFlavor.get(key) ?? 0) + 1);
    if (!itemsByFlavor.has(key)) itemsByFlavor.set(key, []);
    itemsByFlavor.get(key).push(m.itemName);
    if (!rowsByFlavor.has(key)) rowsByFlavor.set(key, []);
    rowsByFlavor.get(key).push({ itemName: m.itemName, amountPerUnit: m.amountPerUnit });
  }
  const ids = new Set((product.flavorIds ?? []).map(Number));
  const linked = flavors.filter((f) => ids.has(Number(f.id)))
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  let orderLines = 0;
  for (const o of orders) {
    for (const it of o.items ?? []) {
      if (it.productName === product.name) orderLines += it.qty;
    }
  }
  return {
    id: product.id,
    name: product.name,
    category: product.category,
    basePrice: product.basePrice,
    flavorPrices,
    flavors: linked.map((f) => ({
      id: f.id,
      name: f.name,
      unitPrice: Number(flavorPrices[f.name] ?? product.basePrice),
      hasCustomPrice: flavorPrices[f.name] !== undefined,
      recipeCount: recipeByFlavor.get(flavorKey(product.name, f.name)) ?? 0,
      recipes: rowsByFlavor.get(flavorKey(product.name, f.name)) ?? [],
      missingItems: (itemsByFlavor.get(flavorKey(product.name, f.name)) ?? [])
        .filter((item) => !invNames.has(String(item ?? "").trim())),
    })),
    recipeCount: maps.filter((m) => m.productName === product.name).length,
    orderLines,
  };
}

async function handleListProducts() {
  const [products, maps, orders, invRows] = await Promise.all([
    fsListAll("products"),
    fsListAll("ingredientMaps"),
    fsListAll("orders"),
    fsListAll("inventoryItems"),
  ]);
  const invNames = new Set(invRows.map((r) => String(r.name ?? "").trim()).filter(Boolean));
  const flavors = await fsListAll("flavors");
  products.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  return { data: products.map((p) => attachFlavors(cleanDoc(p), flavors, maps, orders, invNames)) };
}

async function handleCreateProduct(req) {
  const body = await req.json().catch(() => null);
  const { name, category, basePrice, flavorIds, flavors } = body || {};
  if (!validProductName(name)) {
    return { status: 400, body: { error: "name needs at least 2 letters (max 120 characters)" } };
  }
  const price = validPrice(basePrice);
  if (price === null) {
    return { status: 400, body: { error: "basePrice must be a positive number" } };
  }
  const legacyIds = Array.isArray(flavorIds) ? [...new Set(flavorIds.map(Number))] : [];
  if (!(await flavorIdsExist(legacyIds))) {
    return { status: 404, body: { error: "One or more flavors not found" } };
  }
  const resolved = await resolveFlavorEntries(flavors ?? []);
  if (resolved.error) {
    const status = /not found/i.test(resolved.error) ? 404 : 400;
    return { status, body: { error: resolved.error } };
  }
  const ids = [...new Set([...legacyIds, ...resolved.ids])];
  const priceById = new Map();
  const recipesById = new Map();
  for (const e of Array.isArray(flavors) ? flavors : []) {
    if (e === null || typeof e !== "object") continue;
    const rawId = e.flavorId ?? e.id;
    let key = null;
    if (typeof rawId === "number" || (typeof rawId === "string" && /^\d+$/.test(rawId.trim()))) {
      key = Number(rawId);
    } else if (e.name !== undefined) {
      key = resolved.idByName.get(String(e.name).trim().toLowerCase()) ?? null;
    }
    if (key === null || !ids.includes(Number(key))) continue;
    if (e.unitPrice !== undefined) {
      const unit = validPrice(e.unitPrice);
      if (unit === null) {
        return { status: 400, body: { error: `unitPrice for a flavor must be a positive number` } };
      }
      priceById.set(Number(key), unit);
    }
    if (e.recipes !== undefined) {
      if (!Array.isArray(e.recipes)) {
        return { status: 400, body: { error: `recipes for a flavor must be an array` } };
      }
      const rows = [];
      for (const r of e.recipes) {
        const row = validRecipeRow(r);
        if (!row) {
          return { status: 400, body: { error: `recipe rows need itemName (1-120 chars) and amountPerUnit > 0` } };
        }
        rows.push(row);
      }
      recipesById.set(Number(key), rows);
    }
  }
  const productName = String(name).trim();
  const clash = await fsListAll("products");
  if (clash.some((p) => String(p.name).toLowerCase() === productName.toLowerCase())) {
    return { status: 409, body: { error: `Product "${productName}" already exists` } };
  }
  const flavorPrices = {};
  for (const [id, unit] of priceById) {
    const f = resolved.byId.get(Number(id));
    if (f && unit !== price) flavorPrices[f.name] = unit;
  }
  const counters = await readCounters(["products"]);
  const { ids: newIds, writes } = counterWritesFor(counters, { products: 1 });
  const doc = {
    id: newIds.products[0],
    name: productName,
    category: category ? String(category).slice(0, 60) : "Fries",
    basePrice: price,
    ...(ids.length ? { flavorIds: ids } : {}),
    ...(Object.keys(flavorPrices).length ? { flavorPrices } : {}),
  };
  writes.push(createWrite("products", doc.id, doc));
  try {
    await fsCommit(writes);
  } catch (e) {
    if (e && RETRYABLE_CODES.has(e.code)) {
      return { status: 409, body: { error: "Product already exists" } };
    }
    throw e;
  }
  const created = await fsGet("products", doc.id);
  const linked = (created.flavorIds ?? []).map((id) => resolved.byId.get(Number(id))).filter(Boolean);
  let recipesCreated = 0;
  const unmatchedItems = [];
  const invNames = new Set(
    (await fsListAll("inventoryItems")).map((r) => String(r.name ?? "").trim()).filter(Boolean)
  );
  for (const [id, rows] of recipesById) {
    const f = resolved.byId.get(Number(id));
    if (!f || rows.length === 0) continue;
    for (const r of rows) {
      if (!invNames.has(r.itemName)) unmatchedItems.push({ flavor: f.name, itemName: r.itemName });
    }
    const out = await upsertRecipeRows(productName, f.name, rows);
    if (out.error) return { status: 400, body: { error: out.error } };
    recipesCreated += out.created;
  }
  return {
    status: 201,
    body: {
      product: { ...cleanDoc(created), flavors: linked.map(cleanDoc), flavorPrices },
      flavorsCreated: resolved.created.length,
      recipesCreated,
      unmatchedItems,
    },
  };
}

async function handlePatchProduct(req, id) {
  const body = await req.json().catch(() => null);
  const { category, basePrice, addFlavorIds, removeFlavorIds, flavorPrices, addRecipes, removeRecipes } = body || {};
  if (
    category === undefined && basePrice === undefined &&
    addFlavorIds === undefined && removeFlavorIds === undefined &&
    flavorPrices === undefined && addRecipes === undefined && removeRecipes === undefined
  ) {
    return { status: 400, body: { error: "provide category, basePrice, flavorIds, flavorPrices, or recipes" } };
  }
  const existing = await fsGet("products", id);
  if (!existing) return { status: 404, body: { error: "Product not found" } };
  const data = {};
  if (category !== undefined) data.category = String(category).slice(0, 60) || "Fries";
  if (basePrice !== undefined) {
    const price = validPrice(basePrice);
    if (price === null) {
      return { status: 400, body: { error: "basePrice must be a positive number" } };
    }
    data.basePrice = price;
  }
  const allFlavors = await fsListAll("flavors");
  const byId = new Map(allFlavors.map((f) => [Number(f.id), f]));
  const linkedIds = new Set((existing.flavorIds ?? []).map(Number));
  const linkedFlavors = [...linkedIds].map((fid) => byId.get(fid)).filter(Boolean);
  if (addFlavorIds !== undefined || removeFlavorIds !== undefined) {
    const adds = Array.isArray(addFlavorIds) ? addFlavorIds.map(Number) : [];
    const removes = new Set(Array.isArray(removeFlavorIds) ? removeFlavorIds.map(Number) : []);
    if (!(await flavorIdsExist(adds))) {
      return { status: 404, body: { error: "One or more flavors not found" } };
    }
    if (removes.size > 0) {
      const maps = await fsQueryEqual("ingredientMaps", "productName", existing.name, 10000);
      const guarded = [...removes]
        .map((rid) => linkedFlavors.find((f) => Number(f.id) === Number(rid)))
        .filter((f) => f && maps.some((m) => m.flavor === f.name))
        .map((f) => f.name);
      if (guarded.length > 0) {
        return {
          status: 409,
          body: {
            error: `Cannot remove flavor(s) ${guarded.join(", ")}: recipe rows still reference them — delete the rows first`,
            flavors: guarded,
          },
        };
      }
    }
    for (const aid of adds) linkedIds.add(Number(aid));
    for (const rid of removes) linkedIds.delete(Number(rid));
    data.flavorIds = [...linkedIds];
    const removedNames = new Set(
      [...removes].map((rid) => linkedFlavors.find((f) => Number(f.id) === Number(rid))?.name).filter(Boolean)
    );
    if (removedNames.size > 0) {
      const merged = { ...(data.flavorPrices ?? existing.flavorPrices ?? {}) };
      for (const n of removedNames) delete merged[n];
      data.flavorPrices = merged;
    }
  }
  if (flavorPrices !== undefined) {
    if (flavorPrices === null || typeof flavorPrices !== "object" || Array.isArray(flavorPrices)) {
      return { status: 400, body: { error: "flavorPrices must be an object of flavor name to price" } };
    }
    const merged = { ...(existing.flavorPrices ?? {}) };
    const byName = new Map(allFlavors.map((f) => [String(f.name).toLowerCase(), f]));
    for (const [rawName, rawPrice] of Object.entries(flavorPrices)) {
      const name = String(rawName).trim();
      const hit = byName.get(name.toLowerCase());
      if (!hit || !linkedIds.has(Number(hit.id))) {
        return { status: 404, body: { error: `Flavor "${name}" is not linked to this product` } };
      }
      if (rawPrice === null) {
        delete merged[hit.name];
      } else {
        const unit = validPrice(rawPrice);
        if (unit === null) {
          return { status: 400, body: { error: `unitPrice for "${hit.name}" must be a positive number` } };
        }
        const base = data.basePrice ?? existing.basePrice;
        if (unit === base) delete merged[hit.name];
        else merged[hit.name] = unit;
      }
    }
    data.flavorPrices = merged;
  }
  let product;
  if (Object.keys(data).length > 0) {
    await fsPatch("products", existing.id, data);
    product = await fsGet("products", existing.id);
  } else {
    product = existing;
  }
  let recipesChanged = 0;
  const unmatchedItems = [];
  if (addRecipes !== undefined) {
    if (!Array.isArray(addRecipes)) {
      return { status: 400, body: { error: "addRecipes must be an array" } };
    }
    const byFlavor = new Map();
    for (const r of addRecipes) {
      const row = validRecipeRow(r);
      const flavor = String(r?.flavor ?? "").trim();
      if (!row || !flavor) {
        return { status: 400, body: { error: "addRecipes entries need flavor, itemName (1-120 chars), amountPerUnit > 0" } };
      }
      if (!byFlavor.has(flavor)) byFlavor.set(flavor, []);
      byFlavor.get(flavor).push(row);
    }
    const invNames = new Set(
      (await fsListAll("inventoryItems")).map((r) => String(r.name ?? "").trim()).filter(Boolean)
    );
    for (const [flavor, rows] of byFlavor) {
      for (const r of rows) {
        if (!invNames.has(r.itemName)) unmatchedItems.push({ flavor, itemName: r.itemName });
      }
      const out = await upsertRecipeRows(existing.name, flavor, rows);
      if (out.error) return { status: 400, body: { error: out.error } };
      recipesChanged += out.created;
    }
  }
  if (removeRecipes !== undefined) {
    if (!Array.isArray(removeRecipes)) {
      return { status: 400, body: { error: "removeRecipes must be an array" } };
    }
    const maps = await fsQueryEqual("ingredientMaps", "productName", existing.name, 10000);
    for (const r of removeRecipes) {
      const flavor = String(r?.flavor ?? "").trim();
      const itemName = String(r?.itemName ?? "").trim();
      if (!flavor || !itemName) {
        return { status: 400, body: { error: "removeRecipes entries need flavor and itemName" } };
      }
      for (const m of maps.filter((x) => x.flavor === flavor && x.itemName === itemName)) {
        await fsFetch("https://firestore.googleapis.com/v1/" + m._name, { method: "DELETE" }).catch(() => {});
      }
    }
  }
  return { status: 200, body: { product: cleanDoc(product), recipesChanged, unmatchedItems } };
}

async function handleRenameProduct(req, id) {
  const body = await req.json().catch(() => null);
  const { name } = body || {};
  if (!validProductName(name)) {
    return { status: 400, body: { error: "name needs at least 2 letters (max 120 characters)" } };
  }
  const existing = await fsGet("products", id);
  if (!existing) return { status: 404, body: { error: "Product not found" } };
  const nextName = String(name).trim();
  if (nextName.toLowerCase() === String(existing.name).toLowerCase()) {
    return { status: 400, body: { error: "New name is the same as the current name" } };
  }
  const clash = await fsListAll("products");
  if (clash.some((p) => p.id !== existing.id && String(p.name).toLowerCase() === nextName.toLowerCase())) {
    return { status: 409, body: { error: `Product "${nextName}" already exists` } };
  }
  const outcome = await withRetry(async () => {
    const maps = await fsQueryEqual("ingredientMaps", "productName", existing.name, 10000);
    const writes = [updateWrite("products", existing.id, { name: nextName }, existing._updateTime)];
    for (const m of maps) {
      writes.push(updateWrite("ingredientMaps", String(m._name.split("/").pop()),
        { productName: nextName }, m._updateTime));
    }
    await fsCommit(writes);
    return { mapsUpdated: maps.length };
  }, 4);
  const updated = await fsGet("products", existing.id);
  return { status: 200, body: { product: cleanDoc(updated), mapsUpdated: outcome.mapsUpdated } };
}

async function handleDeleteProduct(id) {
  const existing = await fsGet("products", id);
  if (!existing) return { status: 404, body: { error: "Product not found" } };
  const [maps, orders] = await Promise.all([
    fsQueryEqual("ingredientMaps", "productName", existing.name, 10000),
    fsListAll("orders"),
  ]);
  const usedInOrders = orders.reduce(
    (n, o) => n + (o.items ?? []).filter((it) => it.productName === existing.name).length, 0);
  if (usedInOrders > 0 || maps.length > 0) {
    return {
      status: 409,
      body: {
        error: `Cannot delete "${existing.name}": referenced by ${usedInOrders} order line(s) and ${maps.length} recipe row(s)`,
        orderLines: usedInOrders,
        recipeRows: maps.length,
      },
    };
  }
  await fsFetch("https://firestore.googleapis.com/v1/" + existing._name, { method: "DELETE" });
  return { status: 200, body: { deleted: true } };
}

async function handleListFlavors() {
  const flavors = await fsListAll("flavors");
  flavors.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  return { data: flavors.map(cleanDoc) };
}

async function handleCreateFlavor(req) {
  const body = await req.json().catch(() => null);
  const flavorName = String(body?.name ?? "").trim();
  if (flavorName.length < 1 || flavorName.length > 60) {
    return { status: 400, body: { error: "name must be 1-60 characters" } };
  }
  const existing = await fsListAll("flavors");
  if (existing.some((f) => String(f.name).toLowerCase() === flavorName.toLowerCase())) {
    return { status: 409, body: { error: `Flavor "${flavorName}" already exists` } };
  }
  const counters = await readCounters(["flavors"]);
  const { ids, writes } = counterWritesFor(counters, { flavors: 1 });
  const doc = { id: ids.flavors[0], name: flavorName };
  writes.push(createWrite("flavors", doc.id, doc));
  try {
    await fsCommit(writes);
  } catch (e) {
    if (e && RETRYABLE_CODES.has(e.code)) {
      return { status: 409, body: { error: "Flavor already exists" } };
    }
    throw e;
  }
  return { status: 201, body: { flavor: cleanDoc(await fsGet("flavors", doc.id)) } };
}

async function handleRenameFlavor(req, id) {
  const body = await req.json().catch(() => null);
  const nextName = String(body?.name ?? "").trim();
  if (!nextName || nextName.length > 60) {
    return { status: 400, body: { error: "name must be 1-60 characters" } };
  }
  const existing = await fsGet("flavors", id);
  if (!existing) return { status: 404, body: { error: "Flavor not found" } };
  if (nextName.toLowerCase() === String(existing.name).toLowerCase()) {
    return { status: 400, body: { error: "New name is the same as the current name" } };
  }
  const clash = await fsListAll("flavors");
  if (clash.some((f) => f.id !== existing.id && String(f.name).toLowerCase() === nextName.toLowerCase())) {
    return { status: 409, body: { error: `Flavor "${nextName}" already exists` } };
  }
  const outcome = await withRetry(async () => {
    const [maps, products] = await Promise.all([
      fsQueryEqual("ingredientMaps", "flavor", existing.name, 10000),
      fsListAll("products"),
    ]);
    const writes = [updateWrite("flavors", existing.id, { name: nextName }, existing._updateTime)];
    for (const m of maps) {
      writes.push(updateWrite("ingredientMaps", String(m._name.split("/").pop()),
        { flavor: nextName }, m._updateTime));
    }
    let pricesRewritten = 0;
    for (const p of products) {
      if (p.flavorPrices && p.flavorPrices[existing.name] !== undefined) {
        const merged = { ...p.flavorPrices };
        merged[nextName] = merged[existing.name];
        delete merged[existing.name];
        writes.push(updateWrite("products", p.id, { flavorPrices: merged }, p._updateTime));
        pricesRewritten += 1;
      }
    }
    await fsCommit(writes);
    return { mapsUpdated: maps.length, pricesRewritten };
  }, 4);
  const updated = await fsGet("flavors", existing.id);
  return {
    status: 200,
    body: { flavor: cleanDoc(updated), mapsUpdated: outcome.mapsUpdated, pricesRewritten: outcome.pricesRewritten },
  };
}

async function handleDeleteFlavor(id) {
  const existing = await fsGet("flavors", id);
  if (!existing) return { status: 404, body: { error: "Flavor not found" } };
  const [products, maps] = await Promise.all([
    fsListAll("products"),
    fsQueryEqual("ingredientMaps", "flavor", existing.name, 10000),
  ]);
  const linked = products
    .filter((p) => (p.flavorIds ?? []).map(Number).includes(Number(existing.id)))
    .map((p) => p.name);
  if (linked.length > 0 || maps.length > 0) {
    return {
      status: 409,
      body: {
        error: `Cannot delete flavor "${existing.name}": used by ${linked.length} product(s) and ${maps.length} recipe row(s)`,
        products: linked,
        recipeRows: maps.length,
      },
    };
  }
  await fsFetch("https://firestore.googleapis.com/v1/" + existing._name, { method: "DELETE" });
  return { status: 200, body: { deleted: true } };
}

// ---------- iot + shifts (mirror api/src/routes/iot.js) ----------
const IOT_CHANNELS = {
  LPG_TANK: "LPG Tank",
  CHEESE_BIN: "Cheese Powder",
};
const SHIFT_EVENTS = ["IN", "OUT"];

function asArray(body, key) {
  if (Array.isArray(body)) return body;
  return Array.isArray(body?.[key]) ? body[key] : null;
}

/** Device (ESP32) auth (mirrors middleware/device.js). User JWTs 401 here by design. */
async function authDevice(req) {
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return { device: null, error: { status: 401, body: { error: "Missing device token" } } };
  const [devices, locations] = await Promise.all([fsListAll("devices"), fsListAll("locations")]);
  const locById = new Map(locations.map((l) => [l.id, l]));
  const bl = await bcryptLib();
  for (const device of devices.filter((d) => d.active === true)) {
    if (!device.tokenHash) continue;
    let match = false;
    try {
      match = await bl.compare(token, device.tokenHash);
    } catch {
      continue;
    }
    if (match) {
      const location = locById.get(device.locationId) || null;
      if (!location) {
        return { device: null, error: { status: 403, body: { error: "Device has no assigned cart" } } };
      }
      return { device: { ...device, location }, error: null };
    }
  }
  return { device: null, error: { status: 401, body: { error: "Unknown or inactive device" } } };
}

async function handleIotReadings(req, origin, device) {
  const body = await req.json().catch(() => null);
  const rows = asArray(body, "readings");
  if (!rows || rows.length === 0) {
    return { status: 400, body: { error: "readings array is required" } };
  }
  if (rows.length > 200) {
    return { status: 400, body: { error: "max 200 readings per request" } };
  }
  const location = device.location;
  if (body?.cart_id && String(body.cart_id) !== location.code) {
    return { status: 400, body: { error: `cart_id "${body.cart_id}" does not match device location "${location.code}"` } };
  }

  const outcome = await withRetry(async () => {
    const accepted = [];
    const rejected = [];
    const [invRows, lowStock] = await Promise.all([
      fsQueryEqual("inventoryItems", "locationId", location.id, 10000),
      fsQueryEqual("alerts", "type", "LOW_STOCK", 10000),
    ]);
    const unreadAlerts = lowStock.filter((a) => a.isRead === false);
    const invByName = new Map(invRows.map((r) => [r.name, r]));

    const plans = [];
    const createdNeedles = new Set();
    const newAlerts = [];
    for (const r of rows) {
      const itemName = IOT_CHANNELS[r.channel];
      const kg = Number(r.kg);
      if (!itemName || !Number.isFinite(kg) || kg < 0 || kg > 1000) {
        rejected.push({ channel: r.channel ?? null, reason: "invalid channel or kg" });
        continue;
      }
      const ts = r.ts ? new Date(r.ts) : new Date();
      if (!Number.isFinite(ts.getTime())) {
        rejected.push({ channel: r.channel ?? null, reason: "invalid ts" });
        continue;
      }
      const inv = invByName.get(itemName) ?? null;
      if (!inv) {
        plans.push({ row: r, itemName, kg, ts, inv });
        rejected.push({ channel: r.channel, reason: `no inventory row "${itemName}"` });
      } else if (inv.updatedAt && ts.getTime() < new Date(inv.updatedAt).getTime() - 60 * 1000) {
        plans.push({ row: r, itemName, kg, ts, inv: null, staleInv: inv });
        rejected.push({ channel: r.channel, reason: "stale ts older than current stock" });
      } else {
        plans.push({ row: r, itemName, kg, ts, inv });
        accepted.push({ channel: r.channel, kg, ts: ts.toISOString() });
      }
    }

    const running = new Map();
    for (const plan of plans) {
      if (!plan.inv) continue;
      const base = running.has(plan.inv.id) ? running.get(plan.inv.id) : plan.inv.stock;
      running.set(plan.inv.id, plan.kg);
      if (base > plan.inv.threshold && plan.kg <= plan.inv.threshold) {
        const dedupeKey = `low:${location.id}:${plan.inv.id}`;
        const dup =
          createdNeedles.has(dedupeKey) ||
          unreadAlerts.some((a) => {
            try {
              return JSON.parse(a.payload ?? "{}")?.dedupeKey === dedupeKey;
            } catch {
              return (a.message ?? "").includes(`${plan.inv.name} @ ${location.code}`);
            }
          });
        if (!dup) {
          createdNeedles.add(dedupeKey);
          newAlerts.push({
            type: "LOW_STOCK",
            message: `${plan.inv.name} @ ${location.code} dropped below threshold (${plan.kg} ${plan.inv.unit} left)`,
            payload: JSON.stringify({
              dedupeKey,
              inventoryItemId: plan.inv.id,
              locationId: location.id,
              stock: plan.kg,
              threshold: plan.inv.threshold,
              unit: plan.inv.unit,
            }),
          });
        }
      }
    }

    const counters = await readCounters(["sensorReadings", "alerts"]);
    const { ids, writes } = counterWritesFor(counters, {
      sensorReadings: plans.length, alerts: newAlerts.length,
    });
    const now = new Date();
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i];
      writes.push(createWrite("sensorReadings", ids.sensorReadings[i], {
        id: ids.sensorReadings[i],
        locationId: location.id,
        channel: plan.row.channel,
        kg: plan.kg,
        ts: plan.ts,
        deviceId: device.deviceId,
        uploadedAt: now,
      }));
      if (plan.inv) {
        writes.push(updateWrite("inventoryItems", plan.inv.id,
          { stock: plan.kg, updatedAt: now }, plan.inv._updateTime));
      }
    }
    newAlerts.forEach((a, i) => {
      a.id = ids.alerts[i];
      a.isRead = false;
      a.ackedBy = null;
      a.ackedAt = null;
      a.ackedByName = null;
      a.createdAt = now;
      writes.push(createWrite("alerts", a.id, a));
    });
    writes.push(updateWrite("devices", device.id, { lastSeenAt: now }, null));
    await fsCommit(writes);
    return { accepted, rejected };
  }, 4);

  return { status: 201, body: { accepted: outcome.accepted, rejected: outcome.rejected } };
}

async function handleDeviceShifts(req, origin, device) {
  const body = await req.json().catch(() => null);
  const rows = asArray(body, "events");
  if (!rows || rows.length === 0) {
    return { status: 400, body: { error: "events array is required" } };
  }
  if (rows.length > 200) {
    return { status: 400, body: { error: "max 200 events per request" } };
  }
  const location = device.location;
  if (body?.cart_id && String(body.cart_id) !== location.code) {
    return { status: 400, body: { error: `cart_id "${body.cart_id}" does not match device location "${location.code}"` } };
  }

  const outcome = await withRetry(async () => {
    const accepted = [];
    const rejected = [];
    const [users, unknownAlerts] = await Promise.all([
      fsListAll("users"),
      fsQueryEqual("alerts", "type", "UNKNOWN_CARD", 10000),
    ]);
    const unreadAlerts = unknownAlerts.filter((a) => a.isRead === false);
    const byUid = new Map(users.filter((u) => u.rfidUid).map((u) => [u.rfidUid, u]));

    const plans = [];
    const createdNeedles = new Set();
    const newAlerts = [];
    for (const e of rows) {
      const uid = String(e.staff_uid ?? "").trim();
      const event = String(e.event ?? "").toUpperCase();
      if (!uid || uid.length > 64 || !SHIFT_EVENTS.includes(event)) {
        rejected.push({ staff_uid: uid || null, reason: "invalid uid or event" });
        continue;
      }
      const ts = e.ts ? new Date(e.ts) : new Date();
      if (!Number.isFinite(ts.getTime())) {
        rejected.push({ staff_uid: uid || null, reason: "invalid ts" });
        continue;
      }
      const user = byUid.get(uid) ?? null;
      plans.push({ uid, event, ts, user });
      if (!user) {
        const dedupeKey = `unknown:${location.id}:${uid}`;
        const dup =
          createdNeedles.has(dedupeKey) ||
          unreadAlerts.some((a) => {
            try {
              if (JSON.parse(a.payload ?? "{}")?.dedupeKey === dedupeKey) return true;
            } catch { /* fall through to message check */ }
            return (a.message ?? "").includes(`Unknown RFID card ${uid}`);
          });
        if (!dup) {
          createdNeedles.add(dedupeKey);
          newAlerts.push({
            type: "UNKNOWN_CARD",
            message: `Unknown RFID card ${uid} tapped at ${location.code} - register this card`,
            payload: JSON.stringify({ dedupeKey, uid, locationId: location.id, locationCode: location.code }),
          });
        }
      }
      accepted.push({ staff_uid: uid, event, matched: user ? user.name : null });
    }

    const counters = await readCounters(["shifts", "alerts"]);
    const { ids, writes } = counterWritesFor(counters, {
      shifts: plans.length, alerts: newAlerts.length,
    });
    const now = new Date();
    for (let i = 0; i < plans.length; i++) {
      const plan = plans[i];
      writes.push(createWrite("shifts", ids.shifts[i], {
        id: ids.shifts[i],
        staffUid: plan.uid,
        staffId: plan.user?.id ?? null,
        staffName: plan.user?.name ?? null,
        locationId: location.id,
        event: plan.event,
        ts: plan.ts,
        deviceId: device.deviceId,
        uploadedAt: now,
      }));
    }
    newAlerts.forEach((a, i) => {
      a.id = ids.alerts[i];
      a.isRead = false;
      a.ackedBy = null;
      a.ackedAt = null;
      a.ackedByName = null;
      a.createdAt = now;
      writes.push(createWrite("alerts", a.id, a));
    });
    writes.push(updateWrite("devices", device.id, { lastSeenAt: now }, null));
    await fsCommit(writes);
    return { accepted, rejected };
  }, 4);

  return { status: 201, body: { accepted: outcome.accepted, rejected: outcome.rejected } };
}

async function handleManualShift(req) {
  const body = await req.json().catch(() => null);
  const { staffId, locationCode, event, ts } = body || {};
  const ev = String(event ?? "").toUpperCase();
  if (!["IN", "OUT"].includes(ev)) {
    return { status: 400, body: { error: 'event must be "IN" or "OUT"' } };
  }
  if (locationCode === undefined || locationCode === "") {
    return { status: 400, body: { error: "locationCode is required" } };
  }
  if (staffId === undefined || staffId === "" || staffId === null) {
    return { status: 400, body: { error: "staffId is required" } };
  }
  const [user, location] = await Promise.all([
    fsGet("users", Number(staffId)),
    fsQueryEqual("locations", "code", String(locationCode), 1).then((r) => r[0] || null),
  ]);
  if (!user) return { status: 404, body: { error: "Staff not found" } };
  if (!location) return { status: 404, body: { error: "Location not found" } };
  const at = ts ? new Date(ts) : new Date();
  if (!Number.isFinite(at.getTime())) {
    return { status: 400, body: { error: "ts must be a valid date" } };
  }
  const shift = await withRetry(async () => {
    const counters = await readCounters(["shifts"]);
    const { ids, writes } = counterWritesFor(counters, { shifts: 1 });
    const doc = {
      id: ids.shifts[0],
      staffUid: user.rfidUid ?? `MANUAL-${user.id}`,
      staffId: user.id,
      staffName: user.name,
      locationId: location.id,
      event: ev,
      ts: at,
      deviceId: "MANUAL",
      uploadedAt: new Date(),
    };
    writes.push(createWrite("shifts", doc.id, doc));
    await fsCommit(writes);
    return doc;
  }, 4);
  return { status: 201, body: { shift: cleanDoc(shift) } };
}

async function handlePatchShift(req, id) {
  const body = await req.json().catch(() => null);
  const { event, locationCode, ts } = body || {};
  if (event === undefined && locationCode === undefined && ts === undefined) {
    return { status: 400, body: { error: "provide event, locationCode, or ts" } };
  }
  const existing = await fsGet("shifts", id);
  if (!existing) return { status: 404, body: { error: "Shift not found" } };
  const data = {};
  if (event !== undefined) {
    const ev = String(event).toUpperCase();
    if (!["IN", "OUT"].includes(ev)) {
      return { status: 400, body: { error: 'event must be "IN" or "OUT"' } };
    }
    data.event = ev;
  }
  if (locationCode !== undefined) {
    const location = await fsQueryEqual("locations", "code", String(locationCode), 1).then((r) => r[0]);
    if (!location) return { status: 404, body: { error: "Location not found" } };
    data.locationId = location.id;
  }
  if (ts !== undefined) {
    const at = new Date(ts);
    if (!Number.isFinite(at.getTime())) {
      return { status: 400, body: { error: "ts must be a valid date" } };
    }
    data.ts = at;
  }
  await fsPatch("shifts", existing.id, data);
  const updated = await fsGet("shifts", existing.id);
  const loc = await fsGet("locations", updated.locationId).catch(() => null);
  const out = cleanDoc(updated);
  out.location = loc ? { code: loc.code, name: loc.name } : null;
  return { status: 200, body: { shift: out } };
}

async function handleDeleteShift(id) {
  const existing = await fsGet("shifts", id);
  if (!existing) return { status: 404, body: { error: "Shift not found" } };
  await fsFetch("https://firestore.googleapis.com/v1/" + existing._name, { method: "DELETE" });
  return { status: 200, body: { deleted: true } };
}

async function handleOnShift() {
  const start = manilaDayStart(0);
  let shifts = await fsListAll("shifts");
  shifts = shifts.filter((s) => s.ts instanceof Date && s.ts >= start);
  shifts.sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const locations = await fsListAll("locations");
  const locById = new Map(locations.map((l) => [l.id, l]));
  const withLoc = shifts.map((s) => {
    const c = cleanDoc(s);
    const loc = locById.get(s.locationId);
    c.location = loc ? { code: loc.code, name: loc.name } : { code: "-", name: "" };
    return c;
  });
  const latestByPerson = new Map();
  for (const s of withLoc) {
    latestByPerson.set(`${s.staffUid}|${s.locationId}`, s);
  }
  const onShift = [...latestByPerson.values()]
    .filter((s) => s.event === "IN")
    .map((s) => ({
      name: s.staffName ?? `Unregistered card ${s.staffUid}`,
      registered: Boolean(s.staffName),
      since: s.ts,
      location_code: s.location.code,
      location_name: s.location.name,
    }));
  return { on_shift: onShift, recent_today: withLoc.slice(-20).reverse() };
}

async function handleShiftsHistory(url) {
  const params = url.searchParams;
  const code = params.get("code");
  const date = params.get("date");
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = Math.min(Number(params.get("pageSize")) || 10, 100);
  const cursor = params.get("cursor");
  const filters = [];
  if (code) {
    const loc = await fsQueryEqual("locations", "code", String(code), 1).then((r) => r[0]);
    if (!loc) {
      return { status: 200, body: { data: [], meta: { total: 0, page, pageSize, totalPages: 1 } } };
    }
    filters.push({ field: "locationId", op: "EQUAL", value: loc.id });
  }
  if (date) {
    const range = manilaDayRange(String(date));
    if (!range) return { status: 400, body: { error: "date must be YYYY-MM-DD" } };
    filters.push({ field: "ts", op: "GREATER_THAN_OR_EQUAL", value: range.start });
    filters.push({ field: "ts", op: "LESS_THAN", value: range.end });
  }
  const orderBy = [{ field: "ts", dir: "DESCENDING" }];
  const total = await fsCount("shifts", filters);
  const decoded = cursor ? decodeCursor(cursor) : null;
  const slice = decoded
    ? await fsRunQuery("shifts", { filters, orderBy, limit: pageSize, startAt: { values: [fsEncodeValue(decoded.t)] } })
    : await fsRunQuery("shifts", { filters, orderBy, limit: pageSize, offset: (page - 1) * pageSize });
  const locations = await fsListAll("locations");
  const locById = new Map(locations.map((l) => [l.id, l]));
  const data = slice.map((s) => {
    const c = cleanDoc(s);
    const loc = locById.get(s.locationId);
    c.location = loc ? { code: loc.code, name: loc.name } : null;
    return c;
  });
  const last = slice[slice.length - 1];
  return {
    status: 200,
    body: {
      data,
      meta: { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
      ...(last ? { nextCursor: encodeCursor(last, "ts") } : {}),
    },
  };
}

async function handleReadingsRecent(url) {
  const params = url.searchParams;
  const code = params.get("code") || "CART-01";
  const channel = params.get("channel") || "LPG_TANK";
  const limit = Math.min(Number(params.get("limit")) || 40, 200);
  const loc = await fsQueryEqual("locations", "code", String(code), 1).then((r) => r[0]);
  if (!loc) return { status: 200, body: { readings: [] } };
  let readings = await fsQueryEqual("sensorReadings", "locationId", loc.id, 10000);
  readings = readings.filter((r) => r.channel === String(channel));
  readings.sort((a, b) => {
    const at = a.ts instanceof Date ? a.ts.getTime() : 0;
    const bt = b.ts instanceof Date ? b.ts.getTime() : 0;
    return bt - at;
  });
  return { status: 200, body: { readings: readings.slice(0, limit).map(cleanDoc).reverse() } };
}

// ---------- expenses (mirror api/src/routes/expenses.js) ----------
const EXPENSE_CATEGORIES = ["Supplies", "LPG/Gas", "Maintenance", "Fees/Rent", "Other"];

function decorateExpense(expense) {
  const c = cleanDoc(expense);
  let lines = null;
  if (c.lines) {
    try {
      lines = JSON.parse(c.lines);
    } catch {
      lines = null;
    }
  }
  c.lines = lines;
  return c;
}

function attachExpenseLocation(expense, locById) {
  const c = decorateExpense(expense);
  const loc = locById.get(expense.locationId);
  c.location = loc ? { code: loc.code, name: loc.name } : null;
  return c;
}

function parseExpenseDate(value) {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function manilaMonthRange(month) {
  if (!month || !/^\d{4}-\d{2}$/.test(String(month))) return null;
  const [y, m] = String(month).split("-").map(Number);
  const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
  return {
    start: new Date(Date.UTC(y, m - 1, 1) - MANILA_OFFSET_MS),
    end: new Date(Date.UTC(y, m, 1) - MANILA_OFFSET_MS),
  };
}

async function handleCreateExpense(req, user) {
  const body = await req.json().catch(() => null);
  const { vendor, locationCode, amount, date, source, note, lines, category } = body || {};
  if (!vendor || !Number.isFinite(+amount) || +amount <= 0 || +amount > 10000000) {
    return { status: 400, body: { error: "vendor and amount 0-10000000 are required" } };
  }
  const src = source === "OCR" ? "OCR" : "MANUAL";
  const cat = category ?? "Supplies";
  if (!EXPENSE_CATEGORIES.includes(cat)) {
    return { status: 400, body: { error: `category must be one of: ${EXPENSE_CATEGORIES.join(", ")}` } };
  }
  const parsedDate = date ? parseExpenseDate(date) : new Date();
  if (parsedDate === null) {
    return { status: 400, body: { error: "date must be a valid date" } };
  }
  let locationId = null;
  if (locationCode) {
    const loc = await fsQueryEqual("locations", "code", String(locationCode), 1).then((r) => r[0]);
    if (!loc) return { status: 404, body: { error: "Location not found" } };
    const scopeErr = checkOwnLocation(user, loc.id);
    if (scopeErr) return { status: scopeErr.status, body: scopeErr.body };
    locationId = loc.id;
  }
  const expense = await withRetry(async () => {
    const counters = await readCounters(["expenses"]);
    const { ids, writes } = counterWritesFor(counters, { expenses: 1 });
    const doc = {
      id: ids.expenses[0],
      vendor: String(vendor).slice(0, 120),
      locationId,
      amount: +amount,
      date: date ? parsedDate : new Date(),
      source: src,
      category: cat,
      note: note ? String(note).slice(0, 500) : null,
      lines: Array.isArray(lines) ? JSON.stringify(lines).slice(0, 4000) : null,
      createdAt: new Date(),
    };
    writes.push(createWrite("expenses", doc.id, doc));
    await fsCommit(writes);
    return doc;
  }, 4);
  const loc = locationId !== null ? await fsGet("locations", locationId).catch(() => null) : null;
  const out = decorateExpense(expense);
  out.location = loc ? { code: loc.code, name: loc.name } : null;
  return { status: 201, body: { expense: out } };
}

async function handleListExpenses(url) {
  const params = url.searchParams;
  const code = params.get("code");
  const month = params.get("month");
  const category = params.get("category");
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = Math.min(Number(params.get("pageSize")) || 10, 100);
  const cursor = params.get("cursor");
  const filters = [];
  if (code) {
    const loc = await fsQueryEqual("locations", "code", String(code), 1).then((r) => r[0]);
    if (!loc) {
      return {
        status: 200,
        body: {
          data: [],
          meta: { total: 0, page, pageSize, totalPages: 1 },
          totals: { count: 0, total_amount: 0 },
          by_vendor: [],
          by_category: EXPENSE_CATEGORIES.map((cat) => ({ category: cat, total: 0 })),
          categories: EXPENSE_CATEGORIES,
        },
      };
    }
    filters.push({ field: "locationId", op: "EQUAL", value: loc.id });
  }
  const catFilter = category && EXPENSE_CATEGORIES.includes(String(category)) ? String(category) : null;
  if (catFilter) filters.push({ field: "category", op: "EQUAL", value: catFilter });
  if (month && /^\d{4}-\d{2}$/.test(String(month))) {
    const range = manilaMonthRange(month);
    filters.push({ field: "date", op: "GREATER_THAN_OR_EQUAL", value: range.start });
    filters.push({ field: "date", op: "LESS_THAN", value: range.end });
  }
  const orderBy = [{ field: "date", dir: "DESCENDING" }];
  const [total, sum] = await Promise.all([
    fsCount("expenses", filters),
    fsSum("expenses", "amount", filters),
  ]);
  const decoded = cursor ? decodeCursor(cursor) : null;
  const slice = decoded
    ? await fsRunQuery("expenses", { filters, orderBy, limit: pageSize, startAt: { values: [fsEncodeValue(decoded.t)] } })
    : await fsRunQuery("expenses", { filters, orderBy, limit: pageSize, offset: (page - 1) * pageSize });
  // Breakdowns over the filtered period (ignoring the category filter).
  // Bounded to the 2000 newest rows so giant histories can't blow up one
  // request; pilot-scale data is unaffected (identical results).
  const breakdownFilters = filters.filter((f) => f.field !== "category");
  const bounded = await fsRunQuery("expenses", { filters: breakdownFilters, orderBy, limit: 2000 });
  const vendorTotals = new Map();
  const catTotals = new Map();
  for (const e of bounded) {
    vendorTotals.set(e.vendor, (vendorTotals.get(e.vendor) ?? 0) + (Number(e.amount) || 0));
    catTotals.set(e.category, (catTotals.get(e.category) ?? 0) + (Number(e.amount) || 0));
  }
  const byVendor = [...vendorTotals.entries()]
    .map(([vendor, t]) => ({ vendor, total: Number(t.toFixed(2)) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);
  const byCategory = EXPENSE_CATEGORIES.map((cat) => ({
    category: cat,
    total: Number(((catTotals.get(cat) ?? 0)).toFixed(2)),
  }));
  const locations = await fsListAll("locations");
  const locById = new Map(locations.map((l) => [l.id, l]));
  const last = slice[slice.length - 1];
  return {
    status: 200,
    body: {
      data: slice.map((e) => attachExpenseLocation(e, locById)),
      meta: { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
      totals: { count: total, total_amount: Number(sum.toFixed(2)) },
      by_vendor: byVendor,
      by_category: byCategory,
      categories: EXPENSE_CATEGORIES,
      ...(last ? { nextCursor: encodeCursor(last, "date") } : {}),
    },
  };
}

async function handlePatchExpense(req, id) {
  const body = await req.json().catch(() => null);
  const { vendor, amount, date, note, category } = body || {};
  const data = {};
  if (vendor !== undefined) data.vendor = String(vendor).slice(0, 120);
  if (category !== undefined) {
    if (!EXPENSE_CATEGORIES.includes(category)) {
      return { status: 400, body: { error: `category must be one of: ${EXPENSE_CATEGORIES.join(", ")}` } };
    }
    data.category = category;
  }
  if (amount !== undefined) {
    if (!Number.isFinite(+amount) || +amount <= 0 || +amount > 10000000) {
      return { status: 400, body: { error: "amount must be 0-10000000" } };
    }
    data.amount = +amount;
  }
  if (date !== undefined && date !== "") {
    const parsedDate = parseExpenseDate(date);
    if (parsedDate === null) {
      return { status: 400, body: { error: "date must be a valid date" } };
    }
    data.date = parsedDate;
  }
  if (note !== undefined) data.note = String(note).slice(0, 500);
  const existing = await fsGet("expenses", id);
  if (!existing) return { status: 404, body: { error: "Expense not found" } };
  if (Object.keys(data).length > 0) await fsPatch("expenses", existing.id, data);
  const updated = await fsGet("expenses", existing.id);
  const loc = updated.locationId !== null && updated.locationId !== undefined
    ? await fsGet("locations", updated.locationId).catch(() => null)
    : null;
  const out = decorateExpense(updated);
  out.location = loc ? { code: loc.code, name: loc.name } : null;
  return { status: 200, body: { expense: out } };
}

async function handleDeleteExpense(id) {
  const existing = await fsGet("expenses", id);
  if (!existing) return { status: 404, body: { error: "Expense not found" } };
  await fsFetch("https://firestore.googleapis.com/v1/" + existing._name, { method: "DELETE" });
  return { status: 200, body: { deleted: true } };
}

// ---------- analytics (mirror api/src/routes/analytics.js + services) ----------
const ANALYTICS_CONFIG = {
  MIN_DAYS_FOR_FORECAST: 14,
  HORIZON_DAYS: 7,
  LEAD_TIME_DAYS: 2,
  REVIEW_PERIOD_DAYS: 7,
  SERVICE_Z: 1.65,
};
const DAY_MS = 86400000;
const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function manilaDayKey(date) {
  const m = new Date(new Date(date).getTime() + 8 * 60 * 60 * 1000);
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${m.getUTCFullYear()}-${pad2(m.getUTCMonth() + 1)}-${pad2(m.getUTCDate())}`;
}

function manilaDow(date) {
  return new Date(new Date(date).getTime() + 8 * 60 * 60 * 1000).getUTCDay();
}

function manilaHour(date) {
  return new Date(new Date(date).getTime() + 8 * 60 * 60 * 1000).getUTCHours();
}

function manilaDowOfKey(key) {
  return new Date(`${key}T00:00:00Z`).getUTCDay();
}

function manilaTimeHM(date) {
  const m = new Date(new Date(date).getTime() + 8 * 60 * 60 * 1000);
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${pad2(m.getUTCHours())}:${pad2(m.getUTCMinutes())}`;
}

function manilaCalendarToday() {
  const m = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate()));
}

function movingAverage(values, window) {
  if (values.length === 0) return 0;
  const slice = values.slice(-(window || 7));
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function linearRegression(values) {
  const n = values.length;
  if (n < 2) return { slope: 0, intercept: values[0] ?? 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

function weekdayFactors(dayKeys, values) {
  const sums = Array(7).fill(0);
  const counts = Array(7).fill(0);
  dayKeys.forEach((key, i) => {
    const dow = manilaDowOfKey(key);
    sums[dow] += values[i];
    counts[dow] += 1;
  });
  const overallAvg = values.reduce((a, b) => a + b, 0) / Math.max(values.length, 1);
  if (overallAvg <= 0) return Array(7).fill(1);
  return sums.map((s, i) => {
    if (counts[i] === 0) return 1;
    const f = s / counts[i] / overallAvg;
    return Math.min(1.6, Math.max(0.4, f));
  });
}

function sampleStdDev(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function smape(actual, predicted) {
  const errs = [];
  for (let i = 0; i < Math.min(actual.length, predicted.length); i++) {
    const a = Number(actual[i]);
    const p = Number(predicted[i]);
    if (!Number.isFinite(a) || !Number.isFinite(p) || a < 0 || p < 0) continue;
    if (a === 0 && p === 0) continue;
    errs.push((2 * Math.abs(a - p)) / (Math.abs(a) + Math.abs(p)) * 100);
  }
  if (errs.length === 0) return null;
  return Number((errs.reduce((s, e) => s + e, 0) / errs.length).toFixed(1));
}

async function buildDailyUsage(locationId, windowDays) {
  const since = manilaDayStart(windowDays - 1);
  const [orders, maps] = await Promise.all([
    fsListAll("orders"),
    fsListAll("ingredientMaps"),
  ]);
  const usage = new Map();
  const bump = (itemName, key, amount) => {
    if (!usage.has(itemName)) usage.set(itemName, new Map());
    const dayMap = usage.get(itemName);
    dayMap.set(key, (dayMap.get(key) ?? 0) + amount);
  };
  for (const order of orders) {
    if (Number(order.locationId) !== Number(locationId)) continue;
    if (order.status !== "PAID") continue;
    if (!(order.createdAt instanceof Date) || order.createdAt < since) continue;
    const key = manilaDayKey(order.createdAt);
    for (const item of order.items || []) {
      for (const map of mapsForOrderLine(maps, item.productName, item.flavor ?? "")) {
        bump(map.itemName, key, map.amountPerUnit * item.qty);
      }
    }
  }
  return usage;
}

async function sensorDailyRate(locationId, channel, lookbackDays) {
  const since = manilaDayStart(lookbackDays || 5);
  let readings = await fsListAll("sensorReadings");
  readings = readings.filter((r) =>
    Number(r.locationId) === Number(locationId) && r.channel === channel &&
    r.ts instanceof Date && r.ts >= since);
  readings.sort((a, b) => a.ts.getTime() - b.ts.getTime());
  if (readings.length < 4) return null;
  const first = readings[0];
  const last = readings[readings.length - 1];
  const spanDays = (last.ts - first.ts) / DAY_MS;
  if (spanDays <= 0) return null;
  const used = first.kg - last.kg;
  if (used <= 0) return null;
  return used / spanDays;
}

function daypart(hour) {
  if (hour < 11) return "morning";
  if (hour < 14) return "lunch";
  if (hour < 17) return "afternoon";
  return "evening";
}

function buildHourlyMatrix(orders) {
  const cells = new Map();
  const key = (dow, hour) => `${dow}:${hour}`;
  for (const o of orders) {
    const d = new Date(o.createdAt);
    const k = key(manilaDow(d), manilaHour(d));
    const cell = cells.get(k) ?? { orders: 0, total_sales: 0 };
    cell.orders += 1;
    cell.total_sales += o.total;
    cells.set(k, cell);
  }
  const matrix = [];
  for (let dow = 0; dow < 7; dow++) {
    for (let hour = 0; hour < 24; hour++) {
      const cell = cells.get(key(dow, hour)) ?? { orders: 0, total_sales: 0 };
      matrix.push({
        dow, hour, daypart: daypart(hour), orders: cell.orders,
        total_sales: Number(cell.total_sales.toFixed(2)),
      });
    }
  }
  let peak = { dow: 0, hour: 0, orders: 0, total_sales: 0 };
  for (const c of matrix) {
    if (c.total_sales > peak.total_sales) peak = c;
  }
  const byPart = {};
  for (const c of matrix) {
    const p = byPart[c.daypart] ?? { orders: 0, total_sales: 0 };
    p.orders += c.orders;
    p.total_sales += c.total_sales;
    byPart[c.daypart] = p;
  }
  return {
    matrix,
    peak,
    by_daypart: Object.entries(byPart).map(([part, v]) => ({
      part, orders: v.orders, total_sales: Number(v.total_sales.toFixed(2)),
    })),
  };
}

function buildBasket(paidOrders, voidCount) {
  const totalOrders = paidOrders.length;
  let units = 0;
  let lines = 0;
  const pairCounts = new Map();
  for (const o of paidOrders) {
    const keys = (o.items ?? []).map((it) => `${it.productName}|${it.flavor ?? ""}`);
    units += (o.items ?? []).reduce((s, it) => s + (it.qty ?? 0), 0);
    lines += (o.items ?? []).length;
    const uniq = [...new Set(keys)].sort();
    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const k = `${uniq[i]} + ${uniq[j]}`;
        pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1);
      }
    }
  }
  const topPairs = [...pairCounts.entries()]
    .map(([pair, orders]) => ({
      pair: pair.split(" + ").map((p) => {
        const [name, flavor] = p.split("|");
        return flavor ? `${name} (${flavor})` : name;
      }),
      orders,
      pct: totalOrders > 0 ? Number(((orders / totalOrders) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.orders - a.orders)
    .slice(0, 5);
  const all = totalOrders + voidCount;
  return {
    orders: totalOrders,
    void_orders: voidCount,
    void_rate_pct: all > 0 ? Number(((voidCount / all) * 100).toFixed(1)) : 0,
    avg_units_per_ticket: totalOrders > 0 ? Number((units / totalOrders).toFixed(2)) : 0,
    avg_lines_per_ticket: totalOrders > 0 ? Number((lines / totalOrders).toFixed(2)) : 0,
    top_pairs: topPairs,
  };
}

function forecastForSeries(seriesEntries, { horizon, minDays }) {
  const keys = seriesEntries.map((e) => e.key);
  const values = seriesEntries.map((e) => e.value);
  const totalUse = values.reduce((a, b) => a + b, 0);
  const activeDays = values.filter((v) => v > 0).length;
  if (activeDays < 3 || totalUse <= 0) {
    return {
      data_sufficient: false,
      reason: `only ${activeDays} day(s) with recorded usage - need at least ${minDays}`,
      avg_daily_use: 0,
      forecast: [],
      depletion_days: null,
      risk: "unknown",
      mape: null,
    };
  }
  const factors = weekdayFactors(keys, values);
  const deseasonalized = values.map((v, i) => v / (factors[manilaDowOfKey(keys[i])] || 1));
  let mapeValue = null;
  if (deseasonalized.length >= 6) {
    const trainCut = deseasonalized.length - 3;
    const train = deseasonalized.slice(0, trainCut);
    const { slope, intercept } = linearRegression(train);
    const ma = movingAverage(train);
    const predActual = [];
    const predValues = [];
    for (let d = 0; d < 3; d++) {
      const idx = trainCut + d;
      const dow = manilaDowOfKey(keys[idx]);
      const trend = Math.max(0, intercept + slope * idx);
      const blended = 0.5 * trend + 0.5 * ma;
      predActual.push(values[idx]);
      predValues.push(blended * (factors[dow] || 1));
    }
    mapeValue = smape(predActual, predValues);
  }
  const ma = movingAverage(deseasonalized);
  const { slope, intercept } = linearRegression(deseasonalized);
  const forecast = [];
  const today = manilaCalendarToday();
  for (let h = 1; h <= horizon; h++) {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() + h);
    const dow = date.getUTCDay();
    const trend = Math.max(0, intercept + slope * deseasonalized.length + (h - 1) * slope);
    const blended = 0.5 * trend + 0.5 * ma;
    forecast.push({
      date: date.toISOString().slice(0, 10),
      expected_use: Number((blended * (factors[dow] || 1)).toFixed(3)),
    });
  }
  const avgDailyUse = movingAverage(values);
  return {
    data_sufficient: activeDays >= minDays,
    reason: activeDays >= minDays ? null : `forecast activates after ${minDays} days of data (currently ${activeDays})`,
    avg_daily_use: Number(avgDailyUse.toFixed(3)),
    forecast,
    mape: mapeValue,
  };
}

async function buildForecastForLocation(locationId) {
  const horizon = ANALYTICS_CONFIG.HORIZON_DAYS;
  const windowDays = Math.max(ANALYTICS_CONFIG.MIN_DAYS_FOR_FORECAST + 7, 21);
  const [inventory, usage] = await Promise.all([
    fsQueryEqual("inventoryItems", "locationId", Number(locationId), 10000),
    buildDailyUsage(Number(locationId), windowDays),
  ]);
  inventory.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  const allKeys = [];
  for (let d = windowDays - 1; d >= 0; d--) allKeys.push(manilaDayKey(manilaDayStart(d)));
  const items = [];
  for (const inv of inventory) {
    const dayMap = usage.get(inv.name);
    let series;
    let trackedVia;
    if (dayMap && dayMap.size > 0) {
      trackedVia = "recipes";
      series = allKeys.map((k) => ({ key: k, value: dayMap.get(k) ?? 0 }));
    } else if (inv.source === "SENSOR") {
      trackedVia = "sensor";
      const channel = inv.name === "LPG Tank" ? "LPG_TANK" : "CHEESE_BIN";
      const rate = await sensorDailyRate(Number(locationId), channel, 5);
      if (!rate) {
        items.push({
          name: inv.name, unit: inv.unit, current_stock: inv.stock, threshold: inv.threshold,
          source: inv.source, tracked_via: trackedVia,
          data_sufficient: false, reason: "not enough sensor readings yet",
        });
        continue;
      }
      series = allKeys.map((k) => ({ key: k, value: rate }));
    } else {
      items.push({
        name: inv.name, unit: inv.unit, current_stock: inv.stock, threshold: inv.threshold,
        source: inv.source, tracked_via: "untracked",
        data_sufficient: false, reason: "no recipe or sensor mapping for this item",
      });
      continue;
    }
    const fc = forecastForSeries(series, { horizon, minDays: ANALYTICS_CONFIG.MIN_DAYS_FOR_FORECAST });
    let depletionDays = null;
    let risk = "unknown";
    if (fc.data_sufficient && fc.avg_daily_use > 0) {
      depletionDays = inv.stock / fc.avg_daily_use;
      risk = depletionDays <= ANALYTICS_CONFIG.LEAD_TIME_DAYS ? "high"
        : depletionDays <= ANALYTICS_CONFIG.LEAD_TIME_DAYS * 2.5 ? "medium" : "low";
    }
    items.push({
      name: inv.name, unit: inv.unit, current_stock: inv.stock, threshold: inv.threshold,
      source: inv.source, tracked_via: trackedVia,
      avg_daily_use: fc.avg_daily_use,
      std_dev: Number(sampleStdDev(series.map((s) => s.value)).toFixed(3)),
      data_sufficient: fc.data_sufficient,
      reason: fc.reason,
      forecast: fc.forecast,
      mape_pct: fc.mape,
      depletion_days: depletionDays !== null ? Number(depletionDays.toFixed(1)) : null,
      depletion_date: depletionDays !== null ? manilaDayKey(new Date(Date.now() + depletionDays * DAY_MS)) : null,
      risk,
    });
  }
  return {
    horizon_days: horizon,
    config: ANALYTICS_CONFIG,
    generated_at: new Date().toISOString(),
    items: items.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function getLocationNative(codeOrId) {
  if (codeOrId === undefined || codeOrId === null || codeOrId === "") return null;
  if (/^\d+$/.test(String(codeOrId))) {
    return await fsGet("locations", Number(codeOrId));
  }
  const found = await fsQueryEqual("locations", "code", String(codeOrId), 1);
  return found[0] || null;
}

async function ordersSince(since, locationId, status) {
  let orders = await fsListAll("orders");
  return orders.filter((o) =>
    (!status || o.status === status) &&
    (locationId === null || locationId === undefined || Number(o.locationId) === Number(locationId)) &&
    o.createdAt instanceof Date && o.createdAt >= since);
}

async function handleTrends(url) {
  const params = url.searchParams;
  const days = Math.min(Number(params.get("days")) || 28, 90);
  const location = await getLocationNative(params.get("code"));
  const since = manilaDayStart(days - 1);
  const orders = await ordersSince(since, location ? location.id : null, "PAID");
  const [locations, users] = await Promise.all([fsListAll("locations"), fsListAll("users")]);
  const locById = new Map(locations.map((l) => [l.id, l]));
  const byWeekday = Array.from({ length: 7 }, (_, i) => ({
    dow: i, label: DOW_LABELS[i], total_sales: 0, orders: 0,
  }));
  const dailyMap = new Map();
  const locMap = new Map();
  const itemMap = new Map();
  for (const o of orders) {
    const loc = locById.get(Number(o.locationId)) || { code: "-", name: "" };
    const dow = manilaDow(o.createdAt);
    byWeekday[dow].total_sales += o.total;
    byWeekday[dow].orders += 1;
    const key = manilaDayKey(o.createdAt);
    dailyMap.set(key, (dailyMap.get(key) ?? 0) + o.total);
    const locEntry = locMap.get(loc.code) ?? { code: loc.code, name: loc.name, total_sales: 0, orders: 0 };
    locEntry.total_sales += o.total;
    locEntry.orders += 1;
    locMap.set(loc.code, locEntry);
    for (const it of o.items || []) {
      const ik = `${it.productName}|${it.flavor ?? ""}`;
      const entry = itemMap.get(ik) ?? { name: it.productName, flavor: it.flavor, qty: 0, sales: 0 };
      entry.qty += it.qty;
      entry.sales += it.qty * it.unitPrice;
      itemMap.set(ik, entry);
    }
  }
  const items = [...itemMap.values()].sort((a, b) => b.qty - a.qty);
  const daily_series = [];
  for (let d = days - 1; d >= 0; d--) {
    const key = manilaDayKey(manilaDayStart(d));
    daily_series.push({ date: key, total_sales: Number((dailyMap.get(key) ?? 0).toFixed(2)) });
  }
  return {
    status: 200,
    body: {
      period_days: days,
      location: location?.code ?? "ALL",
      total_sales: Number(orders.reduce((s, o) => s + o.total, 0).toFixed(2)),
      orders: orders.length,
      by_weekday: byWeekday.map((w) => ({ ...w, total_sales: Number(w.total_sales.toFixed(2)) })),
      locations: [...locMap.values()].map((l) => ({ ...l, total_sales: Number(l.total_sales.toFixed(2)) })),
      top_items: items.slice(0, 5),
      slow_items: items.slice(-3).reverse(),
      daily_series,
    },
  };
}

async function handleHourly(url) {
  const params = url.searchParams;
  const days = Math.min(Number(params.get("days")) || 28, 90);
  const location = await getLocationNative(params.get("code"));
  const since = manilaDayStart(days - 1);
  const orders = await ordersSince(since, location ? location.id : null, "PAID");
  return {
    status: 200,
    body: { period_days: days, location: location?.code ?? "ALL", ...buildHourlyMatrix(orders) },
  };
}

async function handleBasket(url) {
  const params = url.searchParams;
  const days = Math.min(Number(params.get("days")) || 28, 90);
  const location = await getLocationNative(params.get("code"));
  const since = manilaDayStart(days - 1);
  const lid = location ? location.id : null;
  let all = await fsListAll("orders");
  all = all.filter((o) =>
    (lid === null || Number(o.locationId) === Number(lid)) &&
    o.createdAt instanceof Date && o.createdAt >= since);
  const paid = all.filter((o) => o.status === "PAID");
  const voidCount = all.filter((o) => o.status === "VOID").length;
  return {
    status: 200,
    body: { period_days: days, location: location?.code ?? "ALL", ...buildBasket(paid, voidCount) },
  };
}

async function handleSalesForecast(url) {
  const params = url.searchParams;
  const days = Math.min(Number(params.get("days")) || 28, 90);
  const horizon = Math.min(Number(params.get("horizon")) || 7, 14);
  const location = await getLocationNative(params.get("code"));
  const since = manilaDayStart(days - 1);
  const orders = await ordersSince(since, location ? location.id : null, "PAID");
  const dailyMap = new Map();
  for (const o of orders) {
    const k = manilaDayKey(o.createdAt);
    dailyMap.set(k, (dailyMap.get(k) ?? 0) + o.total);
  }
  const entries = [];
  for (let d = days - 1; d >= 0; d--) {
    const k = manilaDayKey(manilaDayStart(d));
    entries.push({ key: k, value: Number((dailyMap.get(k) ?? 0).toFixed(2)) });
  }
  const result = forecastForSeries(entries, { horizon, minDays: ANALYTICS_CONFIG.MIN_DAYS_FOR_FORECAST });
  return {
    status: 200,
    body: { period_days: days, horizon_days: horizon, location: location?.code ?? "ALL", ...result },
  };
}

async function handleForecast(url) {
  const location = await getLocationNative(url.searchParams.get("code") ?? "CART-01");
  if (!location) return { status: 404, body: { error: "Location not found" } };
  const result = await buildForecastForLocation(location.id);
  return { status: 200, body: { code: location.code, ...result } };
}

async function handleReorderSuggestions(url) {
  const location = await getLocationNative(url.searchParams.get("code") ?? "CART-01");
  if (!location) return { status: 404, body: { error: "Location not found" } };
  const forecast = await buildForecastForLocation(location.id);
  const lead = ANALYTICS_CONFIG.LEAD_TIME_DAYS;
  const suggestions = [];
  for (const item of forecast.items) {
    if (!item.data_sufficient) {
      suggestions.push({
        item: item.name,
        unit: item.unit,
        current_stock: item.current_stock,
        urgency: item.current_stock <= item.threshold ? "manual_check" : "none",
        suggested_qty: null,
        reorder_point: null,
        reason: item.reason ?? "insufficient history - follow static threshold and manual counts",
      });
      continue;
    }
    const safetyStock = ANALYTICS_CONFIG.SERVICE_Z * (item.std_dev ?? 0) * Math.sqrt(lead);
    const reorderPoint = item.avg_daily_use * lead + safetyStock;
    const targetCycle = item.avg_daily_use * (lead + ANALYTICS_CONFIG.REVIEW_PERIOD_DAYS);
    const suggestedQty = Math.max(0, Math.ceil(targetCycle - item.current_stock));
    let urgency = "ok";
    let reason = `stock healthy (${item.depletion_days} days to depletion at current usage)`;
    if (item.risk === "high") {
      urgency = "immediate";
      reason = `projected depletion ${item.depletion_date} is within the ${lead}-day supplier lead time`;
    } else if (item.risk === "medium" || item.current_stock <= item.threshold) {
      urgency = "this_week";
      reason = `approaching reorder point (${reorderPoint.toFixed(1)} ${item.unit})`;
    }
    suggestions.push({
      item: item.name,
      unit: item.unit,
      current_stock: item.current_stock,
      avg_daily_use: item.avg_daily_use,
      reorder_point: Number(reorderPoint.toFixed(2)),
      safety_stock: Number(safetyStock.toFixed(2)),
      suggested_qty: suggestedQty,
      urgency,
      reason,
      mape_pct: item.mape_pct,
      depletion_days: item.depletion_days ?? null,
      depletion_date: item.depletion_date ?? null,
    });
  }
  const order = { immediate: 0, this_week: 1, manual_check: 2, ok: 3, none: 4 };
  suggestions.sort((a, b) => (order[a.urgency] ?? 9) - (order[b.urgency] ?? 9));
  const alerts = suggestions
    .filter((s) => s.urgency === "immediate" || s.urgency === "this_week")
    .map((s) => ({
      severity: s.urgency === "immediate" ? "critical" : "warning",
      item: s.item,
      depletion_date: s.depletion_date ?? null,
      message: s.urgency === "immediate"
        ? `${s.item} runs out ${s.depletion_date ?? "soon"} - reorder now`
        : `${s.item} approaching reorder point - order this week`,
    }));
  return {
    status: 200,
    body: {
      code: location.code,
      lead_time_days: lead,
      generated_at: new Date().toISOString(),
      suggestions,
      alerts,
    },
  };
}

async function handleReorderPrep(url) {
  const params = url.searchParams;
  const location = await getLocationNative(params.get("code") ?? "CART-01");
  if (!location) return { status: 404, body: { error: "Location not found" } };
  const days = Math.min(Math.max(Number(params.get("days")) || 3, 1), 7);
  const windowDays = 21;
  const [usage, items, alerts] = await Promise.all([
    buildDailyUsage(Number(location.id), windowDays),
    fsQueryEqual("inventoryItems", "locationId", Number(location.id), 10000),
    fsListAll("alerts"),
  ]);
  const recentLow = alerts.filter((a) =>
    a.type === "LOW_STOCK" && a.createdAt instanceof Date &&
    a.createdAt >= manilaDayStart(30));
  const alertCounts = new Map();
  for (const a of recentLow) {
    try {
      const id = JSON.parse(a.payload ?? "{}")?.inventoryItemId;
      if (Number.isInteger(id)) alertCounts.set(id, (alertCounts.get(id) ?? 0) + 1);
    } catch { /* skip legacy payload */ }
  }
  const todayCal = manilaCalendarToday();
  const upcoming = [];
  for (let h = 0; h < days; h++) {
    const d = new Date(todayCal);
    d.setUTCDate(d.getUTCDate() + h);
    upcoming.push(d.getUTCDay());
  }
  const prep = [];
  const calibration = [];
  const sorted = [...items].sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  for (const inv of sorted) {
    const dayMap = usage.get(inv.name) ?? new Map();
    const keys = [];
    const values = [];
    for (let d = windowDays - 1; d >= 0; d--) {
      const k = manilaDayKey(manilaDayStart(d));
      keys.push(k);
      values.push(dayMap.get(k) ?? 0);
    }
    const activeDays = values.filter((v) => v > 0).length;
    if (activeDays < 3) {
      prep.push({
        item: inv.name, unit: inv.unit, current_stock: inv.stock,
        expected_use: null, prep_qty: null, shortfall: null,
        data_sufficient: false, reason: "needs at least 3 days of usage history",
      });
    } else {
      const factors = weekdayFactors(keys, values);
      const avg = movingAverage(values);
      const expected = upcoming.reduce((s, dow) => s + avg * (factors[dow] ?? 1), 0);
      const expectedRounded = Math.ceil(expected * 10) / 10;
      prep.push({
        item: inv.name, unit: inv.unit, current_stock: inv.stock,
        expected_use: expectedRounded, prep_qty: expectedRounded,
        shortfall: Number(Math.max(0, expectedRounded - inv.stock).toFixed(1)),
        data_sufficient: true, reason: null,
      });
    }
    const alertCount = alertCounts.get(inv.id) ?? 0;
    if (alertCount >= 3 && inv.stock > inv.threshold) {
      calibration.push({
        inventory_item_id: inv.id,
        item: inv.name,
        alerts_30d: alertCount,
        current_threshold: inv.threshold,
        verdict: "noisy",
        suggested_threshold: Math.max(1, Math.ceil(inv.threshold / 2)),
        reason: `alerted ${alertCount}x in 30d while stock stayed healthy - threshold likely too high`,
      });
    } else if (alertCount === 0 && inv.stock <= inv.threshold) {
      calibration.push({
        inventory_item_id: inv.id,
        item: inv.name,
        alerts_30d: 0,
        current_threshold: inv.threshold,
        verdict: "silent",
        suggested_threshold: inv.threshold,
        reason: "at/below threshold but never alerted - counts may bypass adjustments (e.g. sensor updates)",
      });
    }
  }
  prep.sort((a, b) => (b.shortfall ?? -1) - (a.shortfall ?? -1));
  return {
    status: 200,
    body: { code: location.code, days, generated_at: new Date().toISOString(), prep, calibration },
  };
}

async function handleStaffPerformance(url) {
  const days = Math.min(Number(url.searchParams.get("days")) || 28, 90);
  const since = manilaDayStart(days - 1);
  const [orders, shifts, users] = await Promise.all([
    fsListAll("orders"),
    fsListAll("shifts"),
    fsListAll("users"),
  ]);
  const userById = new Map(users.map((u) => [Number(u.id), u]));
  const paid = orders.filter((o) =>
    o.status === "PAID" && o.createdAt instanceof Date && o.createdAt >= since);
  const recent = shifts.filter((s) => s.ts instanceof Date && s.ts >= since);
  const byStaff = new Map();
  for (const o of paid) {
    const staff = userById.get(Number(o.staffId));
    if (!staff) continue;
    const entry = byStaff.get(staff.id) ?? {
      staff_id: staff.id, name: staff.name, username: staff.username,
      orders: 0, total_sales: 0, avg_ticket: 0, items_sold: 0,
    };
    entry.orders += 1;
    entry.total_sales += o.total;
    byStaff.set(staff.id, entry);
  }
  for (const s of recent) {
    const staff = userById.get(Number(s.staffId));
    if (!staff) continue;
    const entry = byStaff.get(staff.id) ?? {
      staff_id: staff.id, name: staff.name, username: staff.username,
      orders: 0, total_sales: 0, avg_ticket: 0, items_sold: 0,
    };
    if (s.event === "IN") entry.shifts_in = (entry.shifts_in ?? 0) + 1;
    if (s.event === "OUT") entry.shifts_out = (entry.shifts_out ?? 0) + 1;
    byStaff.set(staff.id, entry);
  }
  const summary = [...byStaff.values()].map((e) => ({
    ...e,
    avg_ticket: e.orders > 0 ? Number((e.total_sales / e.orders).toFixed(2)) : 0,
    total_sales: Number(e.total_sales.toFixed(2)),
    shifts_completed: Math.min(e.shifts_in ?? 0, e.shifts_out ?? 0),
  }));
  summary.sort((a, b) => b.total_sales - a.total_sales);
  return {
    status: 200,
    body: { period_days: days, generated_at: new Date().toISOString(), staff: summary },
  };
}

async function handleProfit(url) {
  const params = url.searchParams;
  const days = Math.min(Number(params.get("days")) || 30, 90);
  const location = await getLocationNative(params.get("code"));
  const since = manilaDayStart(days - 1);
  const lid = location ? Number(location.id) : null;
  const [orders, expenses] = await Promise.all([fsListAll("orders"), fsListAll("expenses")]);
  const paid = orders.filter((o) =>
    o.status === "PAID" && o.createdAt instanceof Date && o.createdAt >= since &&
    (lid === null || Number(o.locationId) === lid));
  const inWindow = expenses.filter((e) =>
    e.date instanceof Date && e.date >= since &&
    (lid === null || Number(e.locationId) === lid));
  const categories = EXPENSE_CATEGORIES;
  const categoryMap = new Map();
  categories.forEach((c) => categoryMap.set(c, 0));
  let totalExpenses = 0;
  for (const e of inWindow) {
    const cat = categories.includes(e.category) ? e.category : "Other";
    categoryMap.set(cat, categoryMap.get(cat) + Number(e.amount));
    totalExpenses += Number(e.amount);
  }
  const expensesByCategory = categories.map((cat) => ({
    category: cat,
    amount: Number(categoryMap.get(cat).toFixed(2)),
    pct: totalExpenses > 0 ? Number(((categoryMap.get(cat) / totalExpenses) * 100).toFixed(2)) : 0,
  }));
  const revenueByDay = new Map();
  for (const o of paid) {
    const key = manilaDayKey(o.createdAt);
    revenueByDay.set(key, (revenueByDay.get(key) ?? 0) + o.total);
  }
  const expenseByDay = new Map();
  for (const e of inWindow) {
    const key = manilaDayKey(e.date);
    expenseByDay.set(key, (expenseByDay.get(key) ?? 0) + Number(e.amount));
  }
  const dailyProfit = [];
  for (let i = days - 1; i >= 0; i--) {
    const localKey = manilaDayKey(manilaDayStart(i));
    const rev = Number((revenueByDay.get(localKey) ?? 0).toFixed(2));
    const exp = Number((expenseByDay.get(localKey) ?? 0).toFixed(2));
    dailyProfit.push({ date: localKey, revenue: rev, expenses: exp, profit: Number((rev - exp).toFixed(2)) });
  }
  const revenue = Number((paid.reduce((s, o) => s + o.total, 0) || 0).toFixed(2));
  const grossProfit = Number((revenue - totalExpenses).toFixed(2));
  const margin = revenue > 0 ? Number(((grossProfit / revenue) * 100).toFixed(2)) : 0;
  return {
    status: 200,
    body: {
      period_days: days,
      location: location?.code ?? "ALL",
      revenue,
      total_expenses: Number(totalExpenses.toFixed(2)),
      gross_profit: grossProfit,
      margin_pct: margin,
      order_count: paid.length,
      expense_count: inWindow.length,
      expenses_by_category: expensesByCategory,
      daily_profit: dailyProfit,
    },
  };
}

// ---------- mini xlsx (zero-dep export; replaces exceljs which can't bundle) ----------
// Uncompressed ZIP + inline strings + one header style. Enough for the five
// export datasets; verified by reading the output back with real exceljs.
function xlsxEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

const _crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32Bytes(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = _crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u16(n) {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
}

function u32(n) {
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

function concatBytes(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** ZIP with stored (uncompressed) entries — valid for Excel. */
function zipStore(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameB = enc.encode(f.name);
    const crc = crc32Bytes(f.data);
    const local = concatBytes([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(f.data.length), u32(f.data.length), u16(nameB.length), u16(0), nameB,
    ]);
    chunks.push(local, f.data);
    central.push({ nameB, crc, len: f.data.length, offset });
    offset += local.length + f.data.length;
  }
  const cdParts = [];
  let cdLen = 0;
  for (const c of central) {
    const rec = concatBytes([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(c.crc), u32(c.len), u32(c.len), u16(c.nameB.length),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(c.offset), c.nameB,
    ]);
    cdParts.push(rec);
    cdLen += rec.length;
  }
  const cdStart = offset;
  return concatBytes([...chunks, ...cdParts,
    concatBytes([u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
      u32(cdLen), u32(cdStart), u16(0)]),
  ]);
}

function colLetters(i) {
  let s = "";
  i++;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

function sheetXml(sheet) {
  const cols = sheet.columns.map((c, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${c.width || 12}" customWidth="1"/>`).join("");
  let rows = "";
  sheet.rows.forEach((row, ri) => {
    const r = ri + 1;
    let cells = "";
    row.forEach((v, ci) => {
      if (v === null || v === undefined || v === "") return;
      const ref = colLetters(ci) + r;
      const style = r === 1 && sheet.headerStyled ? ` s="1"` : "";
      if (typeof v === "number" && Number.isFinite(v)) {
        cells += `<c r="${ref}"${style}><v>${v}</v></c>`;
      } else {
        cells += `<c r="${ref}" t="inlineStr"${style}><is><t>${xlsxEscape(v)}</t></is></c>`;
      }
    });
    rows += `<row r="${r}">${cells}</row>`;
  });
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="A1:${colLetters(Math.max(sheet.columns.length - 1, 0))}${sheet.rows.length}"/>` +
    `<sheetViews><sheetView workbookViewId="0"/></sheetViews>` +
    `<sheetFormat defaultRowHeight="15"/>` +
    (cols ? `<cols>${cols}</cols>` : "") +
    `<sheetData>${rows}</sheetData></worksheet>`;
}

/** Minimal workbook: header row (bold + fill, like the old styleHeader). */
class MiniWorkbook {
  constructor() {
    this.creator = "CartIQ";
    this.sheets = [];
  }
  addWorksheet(name) {
    const sheet = {
      name,
      columns: [],
      rows: [],
      headerStyled: false,
      addRow: (obj) => {
        sheet.rows.push(sheet.columns.map((c) => obj[c.key]));
      },
      getRow: (n) => ({
        // styleHeader sets font/fill on row 1 -> remember to style it.
        set font(v) { if (n === 1) sheet.headerStyled = true; },
        set fill(v) { if (n === 1) sheet.headerStyled = true; },
      }),
    };
    this.sheets.push(sheet);
    return sheet;
  }
  get xlsx() {
    const self = this;
    return {
      async writeBuffer() {
        const enc = new TextEncoder();
        const str = (s) => enc.encode(s);
        // Header row values come from columns (ExcelJS behavior).
        for (const sh of self.sheets) {
          sh.rows.unshift(sh.columns.map((c) => c.header ?? ""));
        }
        const files = [
          { name: "[Content_Types].xml", data: str(
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
            `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
            `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
            `<Default Extension="xml" ContentType="application/xml"/>` +
            `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
            self.sheets.map((_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
            ).join("") +
            `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
            `</Types>`) },
          { name: "_rels/.rels", data: str(
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
            `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
            `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
            `</Relationships>`) },
          { name: "xl/workbook.xml", data: str(
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
            `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
            `<sheets>` +
            self.sheets.map((sh, i) =>
              `<sheet name="${xlsxEscape(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
            `</sheets></workbook>`) },
          { name: "xl/_rels/workbook.xml.rels", data: str(
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
            `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
            self.sheets.map((_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
            ).join("") +
            `<Relationship Id="rId${self.sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
            `</Relationships>`) },
          { name: "xl/styles.xml", data: str(
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
            `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
            `<fonts><font><sz val="11"/><name val="Calibri"/></font>` +
            `<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
            `<fills><fill><patternFill patternType="none"/></fill>` +
            `<fill><patternFill patternType="gray125"/></fill>` +
            `<fill><patternFill patternType="solid"><fgColor rgb="FFF4E3D3"/><bgColor indexed="64"/></patternFill></fill></fills>` +
            `<borders><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
            `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
            `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
            `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>` +
            `</styleSheet>`) },
          ...self.sheets.map((sh, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: str(sheetXml(sh)) })),
        ];
        return zipStore(files);
      },
    };
  }
}

// ---------- excel (mirror api/src/routes/excel.js) ----------
const MAX_EXPORT_ROWS = 5000;
const IMPORT_MAX_ROWS = 2000;
const IMPORT_MAX_NAME_LEN = 120;
const IMPORT_MAX_CATEGORY_LEN = 60;
const IMPORT_MAX_PRICE = 10000000;
const IMPORT_MAX_FLAVORS_PER_ROW = 20;
const IMPORT_MAX_FLAVOR_LEN = 60;

/** SheetJS (pure JS, bundles on Edge) for .xlsx IMPORT parsing. */
async function xlsxReadLib() {
  if (globalThis.__XLSX__) return globalThis.__XLSX__;
  const m = await import("npm:xlsx@0.18.5");
  return m.default ?? m;
}

function splitFlavorCell(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  return text.split(/[;,]/).map((f) => f.trim()).filter(Boolean);
}

function validateProductRow({ name, category, basePrice, flavorNames }) {
  if (!name) return "missing name";
  if (name.length > IMPORT_MAX_NAME_LEN) return `name exceeds ${IMPORT_MAX_NAME_LEN} characters`;
  if (!Number.isFinite(basePrice) || basePrice <= 0) return `invalid basePrice "${basePrice}"`;
  if (basePrice > IMPORT_MAX_PRICE) return `basePrice exceeds ${IMPORT_MAX_PRICE.toLocaleString("en-US")}`;
  if ((category ?? "").length > IMPORT_MAX_CATEGORY_LEN) {
    return `category exceeds ${IMPORT_MAX_CATEGORY_LEN} characters`;
  }
  const flavors = flavorNames ?? [];
  if (flavors.length > IMPORT_MAX_FLAVORS_PER_ROW) {
    return `too many flavors (max ${IMPORT_MAX_FLAVORS_PER_ROW} per product)`;
  }
  for (const f of flavors) {
    if (f.length > IMPORT_MAX_FLAVOR_LEN) return `flavor exceeds ${IMPORT_MAX_FLAVOR_LEN} characters`;
  }
  return null;
}

function resolveExportRange(params) {
  const month = params.get("month") ? String(params.get("month")) : undefined;
  const startDate = params.get("startDate") ? String(params.get("startDate")) : undefined;
  const endDate = params.get("endDate") ? String(params.get("endDate")) : undefined;
  if (month) return { range: manilaMonthRange(month) };
  if (startDate === undefined && endDate === undefined) return { range: null };
  if (!startDate || !endDate) {
    return { error: "startDate and endDate are both required for a custom range" };
  }
  const start = manilaDayRange(String(startDate));
  const end = manilaDayRange(String(endDate));
  if (!start || !end) {
    return { error: "startDate/endDate must be YYYY-MM-DD" };
  }
  if (start.start.getTime() > end.start.getTime()) {
    return { error: "startDate must not be after endDate" };
  }
  return { range: { start: start.start, end: end.end } };
}

function styleSheetHeader(sheet) {
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFF4E3D3" },
  };
}

function inRange(dt, range) {
  return dt instanceof Date && (!range || (dt >= range.start && dt < range.end));
}

async function handleExport(origin, inUrl, dataset) {
  const { range, error } = resolveExportRange(inUrl.searchParams);
  if (error) return { status: 400, body: { error }, binary: false };
  const wb = new MiniWorkbook();
  wb.creator = "CartIQ";
  let truncated = false;
  const [locations, users] = await Promise.all([fsListAll("locations"), fsListAll("users")]);
  const locById = new Map(locations.map((l) => [l.id, l]));
  const userById = new Map(users.map((u) => [Number(u.id), u]));

  if (dataset === "sales") {
    let orders = await fsListAll("orders");
    orders = orders.filter((o) => o.status === "PAID" && inRange(o.createdAt, range));
    orders.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const newest = orders.slice(0, MAX_EXPORT_ROWS + 1);
    truncated = newest.length > MAX_EXPORT_ROWS;
    const rows = newest.slice(0, MAX_EXPORT_ROWS).reverse();
    const lines = wb.addWorksheet("Sales Lines");
    lines.columns = [
      { header: "Date", key: "date", width: 12 },
      { header: "Time", key: "time", width: 10 },
      { header: "Cart", key: "cart", width: 10 },
      { header: "Product", key: "product", width: 18 },
      { header: "Flavor", key: "flavor", width: 14 },
      { header: "Qty", key: "qty", width: 6 },
      { header: "Unit Price", key: "unitPrice", width: 11 },
      { header: "Line Total", key: "lineTotal", width: 11 },
      { header: "Staff", key: "staff", width: 20 },
    ];
    const perCart = new Map();
    for (const o of rows) {
      const loc = locById.get(Number(o.locationId)) || { code: "-", name: "" };
      const staff = userById.get(Number(o.staffId));
      const cartTotals = perCart.get(loc.code) ?? { sales: 0, orders: 0 };
      cartTotals.sales += o.total;
      cartTotals.orders += 1;
      perCart.set(loc.code, cartTotals);
      for (const it of o.items || []) {
        lines.addRow({
          date: manilaDayKey(o.createdAt),
          time: manilaTimeHM(o.createdAt),
          cart: loc.code,
          product: it.productName,
          flavor: it.flavor ?? "",
          qty: it.qty,
          unitPrice: it.unitPrice,
          lineTotal: Number((it.qty * it.unitPrice).toFixed(2)),
          staff: staff?.name ?? "",
        });
      }
    }
    styleSheetHeader(lines);
    const summary = wb.addWorksheet("Summary");
    summary.columns = [
      { header: "Cart", key: "cart", width: 12 },
      { header: "Orders", key: "orders", width: 10 },
      { header: "Total Sales", key: "sales", width: 14 },
    ];
    let totalSales = 0;
    let totalOrders = 0;
    for (const [code, v] of perCart) {
      summary.addRow({ cart: code, orders: v.orders, sales: Number(v.sales.toFixed(2)) });
      totalSales += v.sales;
      totalOrders += v.orders;
    }
    summary.addRow({});
    summary.addRow({ cart: "TOTAL", orders: totalOrders, sales: Number(totalSales.toFixed(2)) });
    styleSheetHeader(summary);
  } else if (dataset === "inventory") {
    const items = await fsListAll("inventoryItems");
    const sheet = wb.addWorksheet("Inventory");
    sheet.columns = [
      { header: "Cart", key: "cart", width: 10 },
      { header: "Item", key: "item", width: 24 },
      { header: "Stock", key: "stock", width: 10 },
      { header: "Unit", key: "unit", width: 8 },
      { header: "Threshold", key: "threshold", width: 10 },
      { header: "Source", key: "source", width: 9 },
      { header: "Updated", key: "updated", width: 20 },
    ];
    const sortedLocs = [...locations].sort((a, b) => String(a.code || "").localeCompare(String(b.code || "")));
    for (const loc of sortedLocs) {
      for (const item of items.filter((i) => Number(i.locationId) === Number(loc.id))) {
        sheet.addRow({
          cart: loc.code,
          item: item.name,
          stock: item.stock,
          unit: item.unit,
          threshold: item.threshold,
          source: item.source,
          updated: item.updatedAt instanceof Date ? item.updatedAt.toISOString() : "",
        });
      }
    }
    styleSheetHeader(sheet);
  } else if (dataset === "expenses") {
    let rows = await fsListAll("expenses");
    rows = rows.filter((e) => inRange(e.date, range));
    rows.sort((a, b) => b.date.getTime() - a.date.getTime());
    const newest = rows.slice(0, MAX_EXPORT_ROWS + 1);
    truncated = newest.length > MAX_EXPORT_ROWS;
    const list = newest.slice(0, MAX_EXPORT_ROWS).reverse();
    const sheet = wb.addWorksheet("Expenses");
    sheet.columns = [
      { header: "Date", key: "date", width: 12 },
      { header: "Vendor", key: "vendor", width: 26 },
      { header: "Cart", key: "cart", width: 10 },
      { header: "Amount", key: "amount", width: 12 },
      { header: "Source", key: "source", width: 9 },
      { header: "Note", key: "note", width: 40 },
    ];
    let sum = 0;
    for (const e of list) {
      sum += Number(e.amount) || 0;
      const loc = locById.get(Number(e.locationId));
      sheet.addRow({
        date: manilaDayKey(e.date),
        vendor: e.vendor,
        cart: loc?.code ?? "",
        amount: e.amount,
        source: e.source,
        note: e.note ?? "",
      });
    }
    sheet.addRow({});
    sheet.addRow({ vendor: "TOTAL", amount: Number(sum.toFixed(2)) });
    styleSheetHeader(sheet);
  } else if (dataset === "shifts") {
    let rows = await fsListAll("shifts");
    rows = rows.filter((s) => inRange(s.ts, range));
    rows.sort((a, b) => b.ts.getTime() - a.ts.getTime());
    const newest = rows.slice(0, MAX_EXPORT_ROWS + 1);
    truncated = newest.length > MAX_EXPORT_ROWS;
    const list = newest.slice(0, MAX_EXPORT_ROWS).reverse();
    const sheet = wb.addWorksheet("Shifts");
    sheet.columns = [
      { header: "Date/Time", key: "ts", width: 20 },
      { header: "Staff", key: "staff", width: 22 },
      { header: "RFID UID", key: "uid", width: 14 },
      { header: "Event", key: "event", width: 7 },
      { header: "Cart", key: "cart", width: 10 },
    ];
    for (const s of list) {
      const loc = locById.get(Number(s.locationId));
      sheet.addRow({
        ts: s.ts.toISOString().slice(0, 16).replace("T", " "),
        staff: s.staffName ?? "(unregistered)",
        uid: s.staffUid,
        event: s.event,
        cart: loc?.code ?? "",
      });
    }
    styleSheetHeader(sheet);
  } else if (dataset === "products") {
    const [products, flavors] = await Promise.all([fsListAll("products"), fsListAll("flavors")]);
    const flavorName = new Map(flavors.map((f) => [Number(f.id), f.name]));
    const sheet = wb.addWorksheet("Products");
    sheet.columns = [
      { header: "Name", key: "name", width: 22 },
      { header: "Category", key: "category", width: 14 },
      { header: "Base Price", key: "basePrice", width: 11 },
      { header: "Flavors", key: "flavors", width: 30 },
    ];
    products.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    for (const p of products) {
      sheet.addRow({
        name: p.name,
        category: p.category,
        basePrice: p.basePrice,
        flavors: (p.flavorIds ?? []).map((id) => flavorName.get(Number(id)) ?? id).join("; "),
      });
    }
    styleSheetHeader(sheet);
  } else {
    return { status: 404, body: { error: `Unknown dataset "${dataset}" (sales|inventory|expenses|shifts|products)` }, binary: false };
  }

  const params = inUrl.searchParams;
  const month = params.get("month") ? String(params.get("month")) : undefined;
  const startDate = params.get("startDate") ? String(params.get("startDate")) : undefined;
  const endDate = params.get("endDate") ? String(params.get("endDate")) : undefined;
  const suffix = month ? `-${month}` : startDate && endDate ? `-${startDate}-to-${endDate}` : "";
  const out = await wb.xlsx.writeBuffer();
  const bytes = out instanceof Uint8Array ? out : new Uint8Array(out);
  const headers = {
    ...corsHeaders(origin),
    "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "content-disposition": `attachment; filename="cartiq-${dataset}${suffix}.xlsx"`,
    "access-control-expose-headers": "X-Export-Truncated",
  };
  if (truncated) headers["x-export-truncated"] = "true";
  return { status: 200, binary: true, bytes, headers };
}

/** Minimal multipart parser (single file field). Returns { buffer, filename } or { error }. */
async function parseMultipartFile(req, maxBytes) {
  const ct = req.headers.get("content-type") || "";
  const bm = ct.match(/boundary=([^;]+)/);
  if (!bm) return { error: 'Attach an .xlsx file in the "file" field' };
  const boundary = "--" + bm[1].trim().replace(/^"|"$/g, "");
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > maxBytes) return { error: "file too large (max 5MB)" };
  const bBytes = new TextEncoder().encode(boundary);
  const idx = [];
  outer: for (let i = 0; i + bBytes.length <= buf.length; i++) {
    for (let j = 0; j < bBytes.length; j++) {
      if (buf[i + j] !== bBytes[j]) continue outer;
    }
    idx.push(i);
  }
  const latin = (a, b) => {
    let s = "";
    for (let i = a; i < b; i++) s += String.fromCharCode(buf[i]);
    return s;
  };
  for (let k = 0; k + 1 < idx.length; k++) {
    let start = idx[k] + bBytes.length;
    if (buf[start] === 45 && buf[start + 1] === 45) continue; // closing `--`
    if (buf[start] === 13 && buf[start + 1] === 10) start += 2;
    // headers end at \r\n\r\n
    let hs = -1;
    for (let i = start; i + 3 < idx[k + 1]; i++) {
      if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) {
        hs = i;
        break;
      }
    }
    if (hs < 0) continue;
    const head = latin(start, hs).toLowerCase();
    if (!head.includes('name="file"')) continue;
    let end = idx[k + 1];
    if (buf[end - 2] === 13 && buf[end - 1] === 10) end -= 2;
    return { buffer: buf.slice(hs + 4, end), filename: "upload.xlsx" };
  }
  return { error: 'Attach an .xlsx file in the "file" field' };
}

async function handleImportProducts(req, origin, inUrl) {
  let XLSX;
  try {
    XLSX = await xlsxReadLib();
  } catch {
    return null; // SheetJS unavailable -> caller returns 503
  }
  const parsed = await parseMultipartFile(req, 5 * 1024 * 1024);
  if (parsed.error) return { status: 400, body: { error: parsed.error }, binary: false };
  const commit = inUrl.searchParams.get("dry_run") === "false";

  let rows;
  try {
    const wb = XLSX.read(parsed.buffer, { type: "buffer" });
    const first = wb.SheetNames[0];
    if (!first) return { status: 400, body: { error: "Workbook has no sheets" }, binary: false };
    rows = XLSX.utils.sheet_to_json(wb.Sheets[first], { header: 1, defval: "" });
  } catch {
    return { status: 400, body: { error: "File is not a valid .xlsx workbook" }, binary: false };
  }
  const dataRows = rows.slice(1);
  if (dataRows.length > IMPORT_MAX_ROWS) {
    return { status: 400, body: { error: "max 2000 data rows per import" }, binary: false };
  }

  const errors = [];
  const validRows = [];
  const seenNames = new Set();
  const [products, flavors] = await Promise.all([fsListAll("products"), fsListAll("flavors")]);
  const existingProducts = new Set(products.map((p) => String(p.name).toLowerCase()));
  const existingFlavors = new Map(flavors.map((f) => [String(f.name).toLowerCase(), Number(f.id)]));

  dataRows.forEach((cols, idx) => {
    const rowNumber = idx + 2; // header is row 1
    const name = String(cols[0] ?? "").trim();
    const category = String(cols[1] ?? "").trim() || "Fries";
    const basePriceRaw = cols[2];
    const flavorsRaw = String(cols[3] ?? "").trim();
    if (!name) {
      errors.push({ row: rowNumber, reason: "missing name" });
      return;
    }
    if (seenNames.has(name.toLowerCase()) || existingProducts.has(name.toLowerCase())) {
      errors.push({ row: rowNumber, reason: `duplicate or existing product "${name}"` });
      return;
    }
    const basePrice = Number(basePriceRaw);
    if (!Number.isFinite(basePrice) || basePrice <= 0) {
      errors.push({ row: rowNumber, reason: `invalid basePrice "${basePriceRaw}"` });
      return;
    }
    const flavorNames = splitFlavorCell(flavorsRaw);
    const capReason = validateProductRow({ name, category, basePrice, flavorNames });
    if (capReason) {
      errors.push({ row: rowNumber, reason: capReason });
      return;
    }
    seenNames.add(name.toLowerCase());
    validRows.push({ row: rowNumber, name, category, basePrice, flavorNames });
  });

  const result = {
    rows_total: dataRows.length,
    valid_count: validRows.length,
    errors,
    committed: false,
  };

  if (commit && errors.length === 0 && validRows.length > 0) {
    const unknown = [];
    const seenFlavor = new Set(existingFlavors.keys());
    for (const r of validRows) {
      for (const fname of r.flavorNames) {
        if (!seenFlavor.has(fname.toLowerCase())) {
          seenFlavor.add(fname.toLowerCase());
          unknown.push(fname);
        }
      }
    }
    const counters = await readCounters(["flavors", "products"]);
    const { ids, writes } = counterWritesFor(counters, { flavors: unknown.length, products: validRows.length });
    unknown.forEach((fname, i) => {
      const id = ids.flavors[i];
      writes.push(createWrite("flavors", id, { id, name: fname }));
      existingFlavors.set(fname.toLowerCase(), id);
    });
    validRows.forEach((r, i) => {
      const flavorIds = r.flavorNames.map((fname) => existingFlavors.get(fname.toLowerCase()));
      writes.push(createWrite("products", ids.products[i], {
        id: ids.products[i],
        name: r.name,
        category: r.category,
        basePrice: r.basePrice,
        ...(flavorIds.length ? { flavorIds } : {}),
      }));
    });
    await fsCommit(writes);
    result.committed = true;
  } else if (commit && errors.length > 0) {
    result.error = "cannot commit: fix validation errors first";
  }
  return { status: 200, body: result, binary: false };
}

/** UTF-8 byte length (bcrypt caps passwords at 72 bytes). */
function utf8len(s) {
  return new TextEncoder().encode(String(s)).length;
}

// ---------- staff + password (mirror the rest of api/src/routes/auth.js) ----------
async function handleChangePassword(req, user) {
  const body = await req.json().catch(() => null);
  const { currentPassword, newPassword } = body || {};
  if (
    !currentPassword || !newPassword ||
    String(newPassword).length < 6 ||
    utf8len(String(newPassword)) > 72
  ) {
    return { status: 400, body: { error: "currentPassword and newPassword (6-72 chars) are required" } };
  }
  const full = await fsGet("users", user.id);
  if (!full) return { status: 404, body: { error: "User not found" } };
  const bl = await bcryptLib();
  if (!(await bl.compare(String(currentPassword), full.passwordHash))) {
    return { status: 401, body: { error: "Current password is incorrect" } };
  }
  await fsPatch("users", full.id, { passwordHash: await bl.hash(String(newPassword), 10) });
  const sessions = await fsQueryEqual("refreshTokens", "userId", full.id, 10000);
  for (const s of sessions) {
    await fsFetch("https://firestore.googleapis.com/v1/" + s._name, { method: "DELETE" }).catch(() => {});
  }
  return { status: 200, body: { updated: true, sessionsRevoked: true } };
}

function staffPublic(u, locById) {
  const loc = locById ? locById.get(u.locationId) : null;
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role,
    active: u.active,
    rfidUid: u.rfidUid ?? null,
    location: loc ? { code: loc.code, name: loc.name } : null,
    createdAt: u.createdAt ?? null,
  };
}

async function handleListStaff() {
  const [users, locations] = await Promise.all([fsListAll("users"), fsListAll("locations")]);
  const locById = new Map(locations.map((l) => [l.id, l]));
  users.sort((a, b) => {
    if (a.role !== b.role) return String(a.role) < String(b.role) ? 1 : -1;
    return String(a.username || "").localeCompare(String(b.username || ""));
  });
  return { data: users.map((u) => staffPublic(u, locById)) };
}

async function handleCreateStaff(req) {
  const body = await req.json().catch(() => null);
  const { name, username, password, locationCode, rfidUid } = body || {};
  const cleanUsername = String(username ?? "").trim();
  if (!name || !cleanUsername || !password || String(password).length < 6) {
    return { status: 400, body: { error: "name, username and password (min 6 chars) required" } };
  }
  if (utf8len(String(password)) > 72) {
    return { status: 400, body: { error: "password must be 6-72 chars (bcrypt limit)" } };
  }
  if (await fsQueryEqual("users", "username", cleanUsername, 1).then((r) => r[0])) {
    return { status: 409, body: { error: `Username "${cleanUsername}" already exists` } };
  }
  let locationId = null;
  if (locationCode) {
    const loc = await fsQueryEqual("locations", "code", String(locationCode), 1).then((r) => r[0]);
    if (!loc) return { status: 404, body: { error: "Location not found" } };
    locationId = loc.id;
  }
  if (rfidUid) {
    if (await fsQueryEqual("users", "rfidUid", rfidUid, 1).then((r) => r[0])) {
      return { status: 409, body: { error: "RFID UID already registered" } };
    }
  }
  const bl = await bcryptLib();
  const created = await withRetry(async () => {
    const counters = await readCounters(["users"]);
    const { ids, writes } = counterWritesFor(counters, { users: 1 });
    const doc = {
      id: ids.users[0],
      name,
      username: cleanUsername,
      passwordHash: await bl.hash(String(password), 10),
      role: "STAFF",
      active: true,
      locationId,
      rfidUid: rfidUid ?? null,
      createdAt: new Date(),
    };
    writes.push(createWrite("users", doc.id, doc));
    await fsCommit(writes);
    return doc;
  }, 4);
  return {
    status: 201,
    body: { user: { id: created.id, username: created.username, name: created.name, role: created.role, active: created.active } },
  };
}

async function handlePatchStaff(req, id, me) {
  const body = await req.json().catch(() => null);
  const { active, password, name, locationCode, rfidUid } = body || {};
  const user = await fsGet("users", id);
  if (!user) return { status: 404, body: { error: "User not found" } };
  if (Number(id) === Number(me.id) && active === false) {
    return { status: 400, body: { error: "You cannot deactivate your own account" } };
  }
  const data = {};
  if (active !== undefined) data.active = Boolean(active);
  if (name !== undefined && String(name).trim()) data.name = String(name).trim();
  if (password !== undefined) {
    if (String(password).length < 6) {
      return { status: 400, body: { error: "password min 6 chars" } };
    }
    if (utf8len(String(password)) > 72) {
      return { status: 400, body: { error: "password must be 6-72 chars (bcrypt limit)" } };
    }
    data.passwordHash = await (await bcryptLib()).hash(String(password), 10);
  }
  if (locationCode !== undefined) {
    if (locationCode === null || locationCode === "") {
      data.locationId = null;
    } else {
      const loc = await fsQueryEqual("locations", "code", String(locationCode), 1).then((r) => r[0]);
      if (!loc) return { status: 404, body: { error: "Location not found" } };
      data.locationId = loc.id;
    }
  }
  if (rfidUid !== undefined) {
    if (rfidUid === null || rfidUid === "") {
      data.rfidUid = null;
    } else {
      const all = await fsListAll("users");
      if (all.some((u) => u.rfidUid === rfidUid && Number(u.id) !== Number(user.id))) {
        return { status: 409, body: { error: "RFID UID already registered" } };
      }
      data.rfidUid = rfidUid;
    }
  }
  if (Object.keys(data).length > 0) await fsPatch("users", user.id, data);
  const updated = await fsGet("users", user.id);
  if (data.active === false) {
    const sessions = await fsQueryEqual("refreshTokens", "userId", user.id, 10000);
    for (const s of sessions) {
      await fsFetch("https://firestore.googleapis.com/v1/" + s._name, { method: "DELETE" }).catch(() => {});
    }
  }
  return {
    status: 200,
    body: { user: { id: updated.id, username: updated.username, name: updated.name, active: updated.active, rfidUid: updated.rfidUid ?? null } },
  };
}

// ---------- events: ticket + poll stream (mirror api/src/routes/events.js) ----------
// The Express version broadcasts in-process (single Render instance). Edge
// isolates share no memory, so each stream polls Firestore for new orders /
// alerts and emits them. The web client already auto-reconnects with backoff
// and refetches a fresh ticket per (re)connect — no client change needed.
const TICKET_TTL_MS = 60 * 1000;
const STREAM_MAX_MS = 50 * 1000;
const STREAM_POLL_MS = 5000;

function randomHexToken(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function pruneTickets() {
  const all = await fsListAll("streamTickets").catch(() => []);
  const now = Date.now();
  for (const t of all) {
    const exp = t.exp instanceof Date ? t.exp.getTime() : 0;
    if (exp <= now) {
      await fsFetch("https://firestore.googleapis.com/v1/" + t._name, { method: "DELETE" }).catch(() => {});
    }
  }
}

async function handleEventTicket(req, user) {
  await pruneTickets().catch(() => {});
  const ticket = randomHexToken(32);
  const exp = new Date(Date.now() + TICKET_TTL_MS);
  await fsCreate("streamTickets", null, {
    ticket,
    userId: user.id,
    exp,
    createdAt: new Date(),
  });
  return { status: 200, body: { ticket, expiresAt: exp.toISOString() } };
}

async function ticketUser(ticket) {
  if (typeof ticket !== "string" || !ticket) return null;
  const found = await fsQueryEqual("streamTickets", "ticket", ticket, 1).catch(() => []);
  const rec = found[0] || null;
  if (!rec) return null;
  const exp = rec.exp instanceof Date ? rec.exp.getTime() : 0;
  if (exp <= Date.now()) return null;
  return rec;
}

function sseEncode(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify({ ...data, _time: new Date().toISOString() })}\n\n`;
}

async function handleEventStream(req, origin, inUrl) {
  const ticket = inUrl.searchParams.get("ticket");
  let userId = null;
  if (ticket) {
    const rec = await ticketUser(ticket);
    if (!rec) return jsonRes(origin, { error: "Invalid or expired stream ticket" }, 401);
    userId = rec.userId;
  } else {
    // Fall back to Bearer (mirrors sseAuth trying requireAuth).
    const auth = await authUser(req);
    if (!auth.user) return jsonRes(origin, auth.error.body, auth.error.status);
    userId = auth.user.id;
  }

  const [locations, users] = await Promise.all([
    fsListAll("locations").catch(() => []),
    fsListAll("users").catch(() => []),
  ]);
  const locById = new Map(locations.map((l) => [Number(l.id), l]));
  const userById = new Map(users.map((u) => [Number(u.id), u]));

  // Newest-first by numeric id (single-field index, no full scan).
  const idDesc = [{ field: "id", dir: "DESCENDING" }];
  let lastOrderId = 0;
  let lastAlertId = 0;
  try {
    const [orders, alerts] = await Promise.all([
      fsRunQuery("orders", { orderBy: idDesc, limit: 1 }),
      fsRunQuery("alerts", { orderBy: idDesc, limit: 1 }),
    ]);
    if (orders[0] && Number.isInteger(Number(orders[0].id))) lastOrderId = Number(orders[0].id);
    if (alerts[0] && Number.isInteger(Number(alerts[0].id))) lastAlertId = Number(alerts[0].id);
  } catch { /* start from zero */ }

  const enc = new TextEncoder();
  let timer = null;
  let closed = false;
  const started = Date.now();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (s) => {
        if (!closed) {
          try { controller.enqueue(enc.encode(s)); } catch { closed = true; }
        }
      };
      send(`event: connected\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);
      const poll = async () => {
        if (closed) return;
        if (Date.now() - started > STREAM_MAX_MS) {
          try { controller.close(); } catch { /* noop */ }
          closed = true;
          return;
        }
        try {
          const [orders, alerts] = await Promise.all([
            fsRunQuery("orders", { orderBy: idDesc, limit: 25 }),
            fsRunQuery("alerts", { orderBy: idDesc, limit: 25 }),
          ]);
          const freshOrders = orders
            .filter((o) => Number.isInteger(Number(o.id)) && Number(o.id) > lastOrderId)
            .sort((a, b) => Number(a.id) - Number(b.id));
          for (const o of freshOrders) {
            lastOrderId = Math.max(lastOrderId, Number(o.id));
            const loc = locById.get(Number(o.locationId));
            const staff = userById.get(Number(o.staffId));
            send(sseEncode("order:new", {
              id: o.id,
              total: o.total,
              locationCode: loc ? loc.code : null,
              itemCount: (o.items || []).length,
              staffName: staff ? staff.name : null,
            }));
          }
          const freshAlerts = alerts
            .filter((a) => Number.isInteger(Number(a.id)) && Number(a.id) > lastAlertId)
            .sort((a, b) => Number(a.id) - Number(b.id));
          for (const a of freshAlerts) {
            lastAlertId = Math.max(lastAlertId, Number(a.id));
            send(sseEncode("alert:new", { id: a.id, type: a.type, message: a.message }));
          }
        } catch { /* transient - keep stream alive */ }
        if (!closed) {
          try { controller.enqueue(enc.encode(": heartbeat\n\n")); } catch { closed = true; }
        }
      };
      await poll();
      if (!closed) timer = setInterval(poll, STREAM_POLL_MS);
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
    },
  });
  const headers = {
    ...corsHeaders(origin),
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-expose-headers": "*",
  };
  return new Response(stream, { status: 200, headers });
}

// ---------- health + server ----------
async function handleHealth(origin) {
  const started = Date.now();
  let db = false;
  try {
    await fsFetch(fsDocBase() + "/_counters/refreshTokens", { method: "GET" });
    db = true;
  } catch {
    db = false;
  }
  const envCheck = !!jwtSecret();
  const ok = db && envCheck;
  return jsonRes(origin, {
    ok,
    service: "cartiq-api",
    via: "supabase-edge",
    version: "0.1.0",
    uptimeSec: 0,
    checks: {
      db: { status: db ? "ok" : "fail" },
      env: { status: envCheck ? "ok" : "fail", detail: envCheck ? "JWT_SECRET present" : "JWT_SECRET missing" },
    },
    time: new Date().toISOString(),
    latencyMs: Date.now() - started,
  }, ok ? 200 : 503);
}

function isHealthPath(path) {
  return path === "/health" || path.endsWith("/health");
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") || "";
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  try {
    const inUrl = new URL(req.url);
    const path = toApiPath(inUrl).split("?")[0];
    if (req.method === "GET" && isHealthPath(path)) {
      return await handleHealth(origin);
    }
    // All routes are native (Firestore-backed). Without secrets, only the
    // public auth entry points stay reachable (they report unavailable).
    if (hasNativeConfig()) {
      if (req.method === "POST" && path === "/auth/login") return await handleLogin(req, origin);
      if (req.method === "POST" && path === "/auth/refresh") return await handleRefresh(req, origin);
      if (req.method === "POST" && path === "/auth/logout") return await handleLogout(req, origin);
      if (req.method === "GET" && path === "/auth/me") return await handleMe(req, origin);
      if (req.method === "GET" && path === "/secure-ping") {
        const auth = await authUser(req);
        if (!auth.user) return jsonRes(origin, auth.error.body, auth.error.status);
        const header = req.headers.get("authorization") || "";
        const payload = await verifyHS256(header.slice(7), jwtSecret());
        return jsonRes(origin, { pong: true, user: { ...payload, locationId: auth.user.locationId ?? null } }, 200);
      }
      if (path === "/auth/change-password" || path === "/auth/staff" || path.startsWith("/auth/staff/")) {
        const auth = await authUser(req);
        if (!auth.user) return jsonRes(origin, auth.error.body, auth.error.status);
        if (req.method === "POST" && path === "/auth/change-password") {
          const out = await handleChangePassword(req, auth.user);
          return jsonRes(origin, out.body, out.status);
        }
        const ownErr = requireOwner(auth.user);
        if (ownErr) return jsonRes(origin, ownErr.body, ownErr.status);
        let out;
        if (req.method === "GET" && path === "/auth/staff") out = { status: 200, body: await handleListStaff() };
        else if (req.method === "POST" && path === "/auth/staff") out = await handleCreateStaff(req);
        else if (req.method === "PATCH" && /^\/auth\/staff\/\d+$/.test(path)) {
          out = await handlePatchStaff(req, Number(path.split("/")[3]), auth.user);
        }
        else return notFoundRes(origin, req, path);
        return jsonRes(origin, out.body, out.status);
      }
      if (req.method === "GET" && path === "/catalog") return await handleCatalog(req, origin);
      if (path === "/orders" || path.startsWith("/orders/")) {
        const auth = await authUser(req);
        if (!auth.user) return jsonRes(origin, auth.error.body, auth.error.status);
        if (req.method === "POST" && path === "/orders") return await handleCreateOrder(req, origin, auth.user);
        if (req.method === "GET" && path === "/orders") return await handleListOrders(req, origin, inUrl);
        if (req.method === "PATCH" && path.startsWith("/orders/")) {
          const idPart = path.slice("/orders/".length).split("/")[0].split("?")[0];
          if (!/^\d+$/.test(idPart)) return jsonRes(origin, { error: "Order not found" }, 404);
          try {
            return await handlePatchOrder(req, origin, Number(idPart), auth.user);
          } catch (e) {
            if (e && (e.status === 404 || e.status === 409)) {
              const msg = String((e && e.message) || "Error");
              return jsonRes(origin, { error: msg }, e.status);
            }
            throw e;
          }
        }
        return notFoundRes(origin, req, path);
      }
      // Locations + devices (OWNER only).
      if (path === "/locations" || path.startsWith("/locations/") ||
          path === "/devices" || path.startsWith("/devices/")) {
        const auth = await authUser(req);
        if (!auth.user) return jsonRes(origin, auth.error.body, auth.error.status);
        const ownErr = requireOwner(auth.user);
        if (ownErr) return jsonRes(origin, ownErr.body, ownErr.status);
        let out;
        if (req.method === "GET" && path === "/locations") out = { status: 200, body: await handleListLocations(origin) };
        else if (req.method === "POST" && path === "/locations") out = await handleCreateLocation(req, origin);
        else if (req.method === "PATCH" && path.startsWith("/locations/")) {
          const idPart = path.slice("/locations/".length).split("/")[0].split("?")[0];
          if (!/^\d+$/.test(idPart)) return jsonRes(origin, { error: "Location not found" }, 404);
          out = await handlePatchLocation(req, origin, Number(idPart));
        }
        else if (req.method === "GET" && path === "/devices") out = { status: 200, body: await handleListDevices() };
        else if (req.method === "POST" && path === "/devices") out = await handleCreateDevice(req);
        else if (req.method === "PATCH" && path.startsWith("/devices/")) {
          const idPart = path.slice("/devices/".length).split("/")[0].split("?")[0];
          if (!/^\d+$/.test(idPart)) return jsonRes(origin, { error: "Device not found" }, 404);
          out = await handlePatchDevice(req, Number(idPart));
        }
        else if (req.method === "DELETE" && path.startsWith("/devices/")) {
          const idPart = path.slice("/devices/".length).split("/")[0].split("?")[0];
          if (!/^\d+$/.test(idPart)) return jsonRes(origin, { error: "Device not found" }, 404);
          out = await handleDeleteDevice(Number(idPart));
        }
        else return notFoundRes(origin, req, path);
        return jsonRes(origin, out.body, out.status);
      }
      // Inventory.
      if (path === "/inventory" || path === "/inventory/names" ||
          path === "/inventory/items" || path.startsWith("/inventory/items/") ||
          path === "/inventory/adjustments") {
        const auth = await authUser(req);
        if (!auth.user) return jsonRes(origin, auth.error.body, auth.error.status);
        let out;
        if (req.method === "GET" && path === "/inventory") out = { status: 200, body: await handleListInventory(inUrl) };
        else if (req.method === "GET" && path === "/inventory/names") out = { status: 200, body: await handleInventoryNames() };
        else if (req.method === "POST" && path === "/inventory/items") out = await handleCreateInventoryItem(req);
        else if ((req.method === "PATCH" || req.method === "DELETE") && path.startsWith("/inventory/items/")) {
          const idPart = path.slice("/inventory/items/".length).split("/")[0].split("?")[0];
          if (!/^\d+$/.test(idPart)) return jsonRes(origin, { error: "Inventory item not found" }, 404);
          if (req.method === "PATCH") {
            const ownErr = requireOwner(auth.user);
            if (ownErr) return jsonRes(origin, ownErr.body, ownErr.status);
            out = await handlePatchInventoryItem(req, Number(idPart));
          } else {
            const ownErr = requireOwner(auth.user);
            if (ownErr) return jsonRes(origin, ownErr.body, ownErr.status);
            out = await handleDeleteInventoryItem(Number(idPart));
          }
        }
        else if (req.method === "POST" && path === "/inventory/adjustments") {
          out = await handleInventoryAdjustment(req, auth.user);
        }
        else return notFoundRes(origin, req, path);
        return jsonRes(origin, out.body, out.status);
      }
      // Alerts.
      if (path === "/alerts" || path === "/alerts/read" ||
          /^\/alerts\/\d+\/(read|ack)$/.test(path)) {
        const auth = await authUser(req);
        if (!auth.user) return jsonRes(origin, auth.error.body, auth.error.status);
        let out;
        if (req.method === "GET" && path === "/alerts") out = { status: 200, body: await handleListAlerts(inUrl) };
        else if (req.method === "PATCH" && path === "/alerts/read") {
          const ownErr = requireOwner(auth.user);
          if (ownErr) return jsonRes(origin, ownErr.body, ownErr.status);
          out = { status: 200, body: await handleAlertsReadAll(req) };
        }
        else if (req.method === "PATCH" && path.endsWith("/read")) {
          const ownErr = requireOwner(auth.user);
          if (ownErr) return jsonRes(origin, ownErr.body, ownErr.status);
          out = await handleAlertReadOne(Number(path.split("/")[2]));
        }
        else if (req.method === "PATCH" && path.endsWith("/ack")) {
          out = await handleAlertAck(req, Number(path.split("/")[2]), auth.user);
        }
        else return notFoundRes(origin, req, path);
        return jsonRes(origin, out.body, out.status);
      }
      // Reports.
      if (path === "/reports/daily") {
        const auth = await authUser(req);
        if (!auth.user) return jsonRes(origin, auth.error.body, auth.error.status);
        if (req.method === "GET") {
          const out = await handleDailyReport(inUrl);
          return jsonRes(origin, out.body, out.status);
        }
        return notFoundRes(origin, req, path);
      }
      // Products + flavors.
      if (path === "/products" || path.startsWith("/products/") ||
          path === "/flavors" || path.startsWith("/flavors/")) {
        const auth = await authUser(req);
        if (!auth.user) return jsonRes(origin, auth.error.body, auth.error.status);
        let out;
        if (req.method === "GET" && path === "/products") out = { status: 200, body: await handleListProducts() };
        else if (req.method === "GET" && path === "/flavors") out = { status: 200, body: await handleListFlavors() };
        else {
          const ownErr = requireOwner(auth.user);
          if (ownErr) return jsonRes(origin, ownErr.body, ownErr.status);
          if (req.method === "POST" && path === "/products") out = await handleCreateProduct(req);
          else if (req.method === "PATCH" && /^\/products\/\d+$/.test(path)) {
            out = await handlePatchProduct(req, Number(path.split("/")[2]));
          }
          else if (req.method === "PATCH" && /^\/products\/\d+\/rename$/.test(path)) {
            out = await handleRenameProduct(req, Number(path.split("/")[2]));
          }
          else if (req.method === "DELETE" && /^\/products\/\d+$/.test(path)) {
            out = await handleDeleteProduct(Number(path.split("/")[2]));
          }
          else if (req.method === "POST" && path === "/flavors") out = await handleCreateFlavor(req);
          else if (req.method === "PATCH" && /^\/flavors\/\d+$/.test(path)) {
            out = await handleRenameFlavor(req, Number(path.split("/")[2]));
          }
          else if (req.method === "DELETE" && /^\/flavors\/\d+$/.test(path)) {
            out = await handleDeleteFlavor(Number(path.split("/")[2]));
          }
          else return notFoundRes(origin, req, path);
        }
        return jsonRes(origin, out.body, out.status);
      }
      // IoT readings + device shifts (device-token auth; user JWTs 401 by design).
      if (path === "/iot/readings" || path === "/shifts") {
        const auth = await authDevice(req);
        if (!auth.device) return jsonRes(origin, auth.error.body, auth.error.status);
        let out;
        if (req.method === "POST" && path === "/iot/readings") out = await handleIotReadings(req, origin, auth.device);
        else if (req.method === "POST" && path === "/shifts") out = await handleDeviceShifts(req, origin, auth.device);
        else return notFoundRes(origin, req, path);
        return jsonRes(origin, out.body, out.status);
      }
      // Shifts management + staff/shift reads + sensor reads (user JWT).
      if (path === "/shifts/manual" || path.startsWith("/shifts/") ||
          path === "/staff/on-shift" || path === "/readings/recent") {
        const auth = await authUser(req);
        if (!auth.user) return jsonRes(origin, auth.error.body, auth.error.status);
        let out;
        if (req.method === "POST" && path === "/shifts/manual") {
          const ownErr = requireOwner(auth.user);
          if (ownErr) return jsonRes(origin, ownErr.body, ownErr.status);
          out = await handleManualShift(req);
        }
        else if ((req.method === "PATCH" || req.method === "DELETE") && /^\/shifts\/\d+$/.test(path)) {
          const ownErr = requireOwner(auth.user);
          if (ownErr) return jsonRes(origin, ownErr.body, ownErr.status);
          const sid = Number(path.split("/")[2]);
          if (req.method === "PATCH") out = await handlePatchShift(req, sid);
          else {
            const existing = await fsGet("shifts", sid);
            if (!existing) out = { status: 404, body: { error: "Shift not found" } };
            else out = await handleDeleteShift(sid);
          }
        }
        else if (req.method === "GET" && path === "/staff/on-shift") out = { status: 200, body: await handleOnShift() };
        else if (req.method === "GET" && path === "/shifts/history") {
          out = await handleShiftsHistory(inUrl);
        }
        else if (req.method === "GET" && path === "/readings/recent") {
          out = await handleReadingsRecent(inUrl);
        }
        else return notFoundRes(origin, req, path);
        return jsonRes(origin, out.body, out.status);
      }
      // Expenses.
      if (path === "/expenses" || path.startsWith("/expenses/")) {
        const auth = await authUser(req);
        if (!auth.user) return jsonRes(origin, auth.error.body, auth.error.status);
        let out;
        if (req.method === "POST" && path === "/expenses") out = await handleCreateExpense(req, auth.user);
        else if (req.method === "GET" && path === "/expenses") out = await handleListExpenses(inUrl);
        else if ((req.method === "PATCH" || req.method === "DELETE") && /^\/expenses\/\d+$/.test(path)) {
          const ownErr = requireOwner(auth.user);
          if (ownErr) return jsonRes(origin, ownErr.body, ownErr.status);
          const eid = Number(path.split("/")[2]);
          if (req.method === "PATCH") out = await handlePatchExpense(req, eid);
          else out = await handleDeleteExpense(eid);
        }
        else return notFoundRes(origin, req, path);
        return jsonRes(origin, out.body, out.status);
      }
      // Analytics + reorders (read-only aggregations).
      if (path.startsWith("/analytics/") || path.startsWith("/reorders/")) {
        const auth = await authUser(req);
        if (!auth.user) return jsonRes(origin, auth.error.body, auth.error.status);
        let out;
        if (req.method === "GET" && path === "/analytics/trends") out = await handleTrends(inUrl);
        else if (req.method === "GET" && path === "/analytics/hourly") out = await handleHourly(inUrl);
        else if (req.method === "GET" && path === "/analytics/basket") out = await handleBasket(inUrl);
        else if (req.method === "GET" && path === "/analytics/sales-forecast") out = await handleSalesForecast(inUrl);
        else if (req.method === "GET" && path === "/analytics/forecast") out = await handleForecast(inUrl);
        else if (req.method === "GET" && path === "/reorders/suggestions") out = await handleReorderSuggestions(inUrl);
        else if (req.method === "GET" && path === "/reorders/prep") out = await handleReorderPrep(inUrl);
        else if (req.method === "GET" && path === "/analytics/staff-performance") {
          const ownErr = requireOwner(auth.user);
          if (ownErr) return jsonRes(origin, ownErr.body, ownErr.status);
          out = await handleStaffPerformance(inUrl);
        }
        else if (req.method === "GET" && path === "/analytics/profit") {
          const ownErr = requireOwner(auth.user);
          if (ownErr) return jsonRes(origin, ownErr.body, ownErr.status);
          out = await handleProfit(inUrl);
        }
        else return notFoundRes(origin, req, path);
        return jsonRes(origin, out.body, out.status);
      }
      // Events: ticket (Bearer) + stream (ticket or Bearer).
      if (path === "/events/ticket" || path === "/events") {
        if (req.method === "POST" && path === "/events/ticket") {
          const auth = await authUser(req);
          if (!auth.user) return jsonRes(origin, auth.error.body, auth.error.status);
          const out = await handleEventTicket(req, auth.user);
          return jsonRes(origin, out.body, out.status);
        }
        if (req.method === "GET" && path === "/events") {
          return await handleEventStream(req, origin, inUrl);
        }
        return notFoundRes(origin, req, path);
      }
      // Excel export (native MiniWorkbook) / import (native SheetJS).
      if (path.startsWith("/export/") || path === "/import/products") {
        const auth = await authUser(req);
        if (!auth.user) return jsonRes(origin, auth.error.body, auth.error.status);
        const ownErr = requireOwner(auth.user);
        if (ownErr) return jsonRes(origin, ownErr.body, ownErr.status);
        if (req.method === "GET" && path.startsWith("/export/")) {
          const dataset = path.slice("/export/".length).split("/")[0].split("?")[0];
          const out = await handleExport(origin, inUrl, dataset);
          if (!out.binary) return jsonRes(origin, out.body, out.status);
          return new Response(out.bytes, { status: 200, headers: out.headers });
        }
        if (req.method === "POST" && path === "/import/products") {
          const out = await handleImportProducts(req, origin, inUrl);
          if (!out) return jsonRes(origin, { error: "Import service unavailable" }, 503);
          return jsonRes(origin, out.body, out.status);
        }
        return notFoundRes(origin, req, path);
      }
    } else if (
      (req.method === "POST" && (path === "/auth/login" || path === "/auth/refresh" || path === "/auth/logout")) ||
      (req.method === "GET" && path === "/auth/me")
    ) {
      // Firestore secrets missing: native auth unavailable.
      return jsonRes(origin, { error: "Database unavailable" }, 503);
    }
    return notFoundRes(origin, req, path);
  } catch (e) {
    const status = (e && e.status) || 500;
    return jsonRes(origin, { error: status === 503 ? "Database unavailable" : "Edge function error" }, status);
  }
});
