#!/usr/bin/env node
// API parity check - the production API and the local one must serve the
// same thing the apps actually call.
//
// WHY THIS EXISTS
//
//   api/                          supabase/functions/api/index.ts
//   (Express, local dev + CI)     (Deno Edge Function, PRODUCTION)
//
// Two implementations of the same API, kept in step by hand. CI tests the
// Express copy and never the Edge one, so an Edge-only change ships with no
// test coverage at all - which is exactly what happened with 69b7f78 and
// 82e6c45, both of which touched only the Edge function.
//
// The invariant that actually matters: every endpoint the web dashboard and
// the mobile POS call must be served by BOTH. If an app calls a route only
// the Express copy has, the local dev server works and production 404s. If
// only the Edge copy has it, production works and local dev 404s. Either way
// the app is broken somewhere, and nothing else in CI would notice.
//
// Usage: node scripts/check_api_parity.mjs
// Exit 0 = in step, exit 1 = drift (with the offending routes listed).

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

/**
 * Turn a path template into a concrete path.
 *
 * The apps address the API relative to its base, which already ends in
 * "/api" - the vite dev proxy and the Edge function both strip that prefix
 * before routing. So "/auth/me" in the app is "/api/auth/me" in Express.
 *
 * A $-variable glued to the end of a word is a QUERY string
 * ("/reports/daily$query" -> "/reports/daily"); one after a slash is a path
 * segment ("/orders/$orderId" -> "/orders/1").
 */
function concretise(path) {
  let p = path.split("?")[0];
  p = p.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, (m, off, str) =>
    str[off - 1] === "/" ? "1" : "",
  );
  p = p.replace(/\$\{[^}]*\}/g, (m, off, str) =>
    str[off - 1] === "/" ? "1" : "",
  );
  return p.replace(/\/+$/, "") || "/";
}

/* ------------------------------------------------------------------ */
/* Express: api/src/routes/*.js mounted by api/src/server.js            */
/* ------------------------------------------------------------------ */

function expressRoutes() {
  const server = read("api/src/server.js");

  // import authRoutes from "./routes/auth.js";
  const fileOf = {};
  for (const m of server.matchAll(
    /import\s+(\w+)\s+from\s+["']\.\/routes\/([^"']+)["']/g,
  )) {
    fileOf[m[1]] = `api/src/routes/${m[2]}`;
  }

  // app.use("/api/auth", authRoutes);
  const mounts = [];
  for (const m of server.matchAll(
    /app\.use\(\s*["']([^"']+)["']\s*,\s*(\w+)\s*\)/g,
  )) {
    const [, prefix, variable] = m;
    if (!fileOf[variable]) continue; // a rate limiter, not a router
    mounts.push({ prefix, file: fileOf[variable] });
  }

  const routes = [];
  for (const { prefix, file } of mounts) {
    const src = read(file);
    // router.get("/path", ...) or healthRouter.get("/path", ...) - the path may
    // sit on the next line. Not every route file names its router "router".
    for (const m of src.matchAll(
      /\b\w*[Rr]outer\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g,
    )) {
      let template = (prefix + m[2]).replace(/\/+$/, "") || "/";
      // The apps address the API relative to a base that already ends in
      // "/api", so drop that prefix to compare like with like.
      if (template === "/api") template = "";
      else if (template.startsWith("/api/")) template = template.slice(4);
      routes.push({
        method: m[1].toUpperCase(),
        template: template || "/",
        file,
      });
    }
  }
  return routes;
}

/** Does an Express route serve this method + concrete path? */
function expressServes(routes, method, path) {
  const candidates = routes.filter((r) => r.method === method);
  for (const r of candidates) {
    // /alerts/:id/ack  ->  ^/alerts/[^/]+/ack$
    const pattern = "^" +
      r.template
        .split("/")
        .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        .join("/") +
      "$";
    if (new RegExp(pattern).test(path)) return r;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Edge function: the routing table in supabase/functions/api/index.ts  */
/* ------------------------------------------------------------------ */

function edgeRoutes() {
  const src = read("supabase/functions/api/index.ts");

  // Only the SERVER block routes. Path tests elsewhere in the file are
  // helpers, and they poison this check: toApiPath() normalises a URL and
  // happens to call path.startsWith("/"), which matches every path - so the
  // whole file would report "everything is served" no matter what the
  // router actually did.
  //
  // The health route lives in a helper just above the server, so that
  // helper is included as well.
  const serveAt = src.indexOf("Deno.serve(");
  const healthAt = src.indexOf("function isHealthPath");
  const scope =
    (healthAt >= 0 && serveAt > healthAt ? src.slice(healthAt, serveAt) : "") +
    (serveAt >= 0 ? src.slice(serveAt) : src);

  const patterns = [];

  for (const m of scope.matchAll(/path\s*===\s*["']([^"']+)["']/g)) {
    patterns.push({ kind: "exact", value: m[1] });
  }
  for (const m of scope.matchAll(/path\.startsWith\(\s*["']([^"']+)["']\s*\)/g)) {
    // A one-character prefix is a catch-all, never a real route.
    if (m[1].length < 2) continue;
    patterns.push({ kind: "prefix", value: m[1] });
  }
  for (const m of scope.matchAll(/path\.endsWith\(\s*["']([^"']+)["']\s*\)/g)) {
    patterns.push({ kind: "suffix", value: m[1] });
  }
  for (const m of scope.matchAll(/\/((?:\\.|[^/\\\n])*)\/\.test\(path\)/g)) {
    try {
      patterns.push({ kind: "regex", value: new RegExp(m[1]) });
    } catch {
      /* not a literal regex - ignore */
    }
  }
  return patterns;
}

function edgeServes(patterns, path) {
  for (const p of patterns) {
    if (p.kind === "exact" && path === p.value) return p;
    if (p.kind === "prefix" && path.startsWith(p.value)) return p;
    if (p.kind === "suffix" && path.endsWith(p.value)) return p;
    if (p.kind === "regex" && p.value.test(path)) return p;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The endpoints the apps call                                         */
/* ------------------------------------------------------------------ */

function walk(dir, out = []) {
  for (const entry of readdirSync(join(root, dir))) {
    const rel = join(dir, entry);
    const full = join(root, rel);
    if (statSync(full).isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

function appCalls() {
  const calls = new Map(); // "METHOD path" -> [sources]

  const add = (method, path, source) => {
    const key = `${method} ${path}`;
    if (!calls.has(key)) calls.set(key, new Set());
    calls.get(key).add(source);
  };

  // --- web dashboard: api.get("/path"), api.post(`/path/${id}`) ...
  for (const file of walk("web/src")) {
    if (!/\.(js|jsx)$/.test(file) || file.includes(".test.")) continue;
    const src = read(file);
    for (const m of src.matchAll(
      /\bapi\.(get|post|put|patch|del|delete)\(\s*([`"'])([^`"']+)\2/g,
    )) {
      const method = m[1] === "del" ? "DELETE" : m[1].toUpperCase();
      const raw = m[3];
      if (!raw.startsWith("/")) continue;
      add(method, concretise(raw), file);
    }
  }

  // --- mobile POS: _uri('/path'), final path = '/path?...' ...
  const dart = "mobile/lib/services/api_client.dart";
  const src = read(dart);
  const methodFor = (offset) => {
    const before = src.slice(Math.max(0, offset - 260), offset);
    const hits = [...before.matchAll(/\.(get|post|put|patch|delete)\(/g)];
    if (!hits.length) return "GET";
    const m = hits[hits.length - 1][1];
    return m === "delete" ? "DELETE" : m.toUpperCase();
  };
  for (const m of src.matchAll(/_uri\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const raw = m[1];
    if (!raw.startsWith("/")) continue;
    add(methodFor(m.index), concretise(raw), dart);
  }
  for (const m of src.matchAll(
    /(?:final|var|String)\s+path\s*=\s*[^;]*?['"](\/[^'"]*)['"]/gs,
  )) {
    add(methodFor(m.index), concretise(m[1]), dart);
  }

  return calls;
}

/* ------------------------------------------------------------------ */
/* Compare                                                             */
/* ------------------------------------------------------------------ */

const express = expressRoutes();
const edge = edgeRoutes();
const calls = appCalls();

console.log(
  `express routes: ${express.length}   edge patterns: ${edge.length}   app calls: ${calls.size}`,
);

const problems = [];

for (const [key, sources] of [...calls].sort()) {
  const [method, path] = key.split(" ");
  if (!expressServes(express, method, path)) {
    problems.push(
      `  MISSING in api/ (Express)      ${key}\n      called from: ${[...sources].join(", ")}`,
    );
  }
  if (!edgeServes(edge, path)) {
    problems.push(
      `  MISSING in the Edge function   ${key}\n      called from: ${[...sources].join(", ")}`,
    );
  }
}

if (problems.length) {
  console.error("\nAPI drift - the apps call routes that do not exist:\n");
  for (const p of problems) console.error(p);
  console.error(
    `\n${problems.length} problem(s). Production is the Edge function; the Express copy is what CI tests.`,
  );
  process.exit(1);
}

console.log(
  `OK - all ${calls.size} endpoints the apps call are served by both the Express copy and the Edge function.`,
);
