// Bantay ng CSS parts: bawat selector dapat iisang file lang ang may-ari.
// Run: npm run css:check  (exit 1 pag may lumabag)
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "styles");
const files = readdirSync(dir).filter((f) => f.endsWith(".css") && f !== "index.css");

let failures = 0;

// 1. Bawat part file may PART header.
for (const f of files) {
  const css = readFileSync(join(dir, f), "utf8");
  if (!css.includes("PART:")) {
    console.error(`MISSING PART header: ${f}`);
    failures++;
  }
}

// 2. Walang selector sa 2+ files (keyframes hindi kasali — global namespace sila).
const owners = new Map(); // selector -> file
for (const f of files) {
  const css = readFileSync(join(dir, f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/@keyframes[\s\S]*?^\}/gm, "")
    .replace(/\r\n/g, "\n");
  for (const chunk of css.split("}")) {
    const brace = chunk.lastIndexOf("{");
    if (brace === -1) continue;
    const head = chunk.slice(0, brace).trim().split("\n").pop().trim();
    if (!head || head.startsWith("@")) continue;
    for (const sel of head.split(",").map((s) => s.replace(/\s+/g, " ").trim())) {
      if (!sel || sel.startsWith("@")) continue;
      if (owners.has(sel) && owners.get(sel) !== f) {
        console.error(`DUPLICATE selector "${sel}": ${owners.get(sel)} + ${f}`);
        failures++;
      } else {
        owners.set(sel, f);
      }
    }
  }
}

// 3. index.css naka-import lahat ng part files.
const index = readFileSync(join(dir, "index.css"), "utf8");
for (const f of files) {
  if (!index.includes(`"./${f}"`)) {
    console.error(`NOT IMPORTED in index.css: ${f}`);
    failures++;
  }
}

console.log(failures ? `FAIL: ${failures} paglabag` : `OK: ${files.length} files, ${owners.size} selectors, walang duplikado`);
process.exit(failures ? 1 : 0);
