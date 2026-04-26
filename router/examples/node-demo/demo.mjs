/**
 * Node.js demo: load an OSW GeoJSON fixture, register two profiles, and
 * compute routes with each. Demonstrates that wheelchair and generic-pedestrian
 * profiles produce different routes on the same graph.
 *
 * Run: node demo.mjs
 */

import { readFileSync } from "fs";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dir, "../../pkg");

// wasm-pack --target web generates ESM. For Node we use the bundler target's
// CommonJS shim, or simply import the .js glue and initialise with the binary.
const { default: init, Router } = await import(`${pkgDir}/unweaver_wasm.js`);
const wasmBytes = readFileSync(`${pkgDir}/unweaver_wasm_bg.wasm`);
await init(wasmBytes);

// ── load graph ───────────────────────────────────────────────────────────────
const geojson = readFileSync(
  resolve(__dir, "../../tests/fixtures/small_osw.geojson"),
  "utf8"
);
const router = Router.fromOSWGeoJSON(geojson);
console.log(`Graph loaded: ${router.nodeCount()} nodes, ${router.edgeCount()} edges`);

// ── register profiles ────────────────────────────────────────────────────────
const profileDir = resolve(__dir, "..");
for (const name of ["generic_pedestrian", "manual_wheelchair", "low_vision"]) {
  const json = readFileSync(`${profileDir}/profile-${name}.json`, "utf8");
  router.addProfile(name, json);
  console.log(`Profile registered: ${name}`);
}

// ── route: A → C ─────────────────────────────────────────────────────────────
// Fixture coords: A = [40.692, -73.990], C = [40.692, -73.988]
const originLat = 40.692, originLon = -73.990;
const destLat   = 40.692, destLon   = -73.988;

for (const profile of ["generic_pedestrian", "manual_wheelchair"]) {
  const json = router.shortestPathJSON(profile, originLat, originLon, destLat, destLon, null);
  const result = JSON.parse(json);
  if (result.status === "Ok") {
    console.log(
      `\n[${profile}] total_cost=${result.total_cost.toFixed(1)}m, edges=${result.edges.length}`
    );
    result.edges.forEach((e, i) => {
      console.log(`  edge ${i + 1}: footway=${e.footway ?? "-"} incline=${e.incline ?? "-"} length=${e.length ?? e.cost?.toFixed(1)}m`);
    });
  } else {
    console.log(`\n[${profile}] ${result.code}`);
  }
}

// ── reachability tree ────────────────────────────────────────────────────────
const treeJson = router.shortestPathTreeJSON(
  "manual_wheelchair", originLat, originLon, 200, null
);
const tree = JSON.parse(treeJson);
console.log(
  `\n[manual_wheelchair] reachability (budget=200m): ` +
  `${tree.node_costs?.features?.length ?? 0} nodes reachable`
);
