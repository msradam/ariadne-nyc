/**
 * Node.js demo (CommonJS): same as demo.mjs but using the nodejs-target package.
 * Run: node demo.cjs
 */

const { readFileSync } = require("fs");
const path = require("path");

const pkgDir = path.resolve(__dirname, "../../pkg-node");
const { Router } = require(pkgDir);

const geojson = readFileSync(
  path.resolve(__dirname, "../../tests/fixtures/small_osw.geojson"),
  "utf8"
);
const router = Router.fromOSWGeoJSON(geojson);
console.log(`Graph loaded: ${router.nodeCount()} nodes, ${router.edgeCount()} edges`);

const profileDir = path.resolve(__dirname, "..");
for (const name of ["generic_pedestrian", "manual_wheelchair", "low_vision"]) {
  const json = readFileSync(`${profileDir}/profile-${name}.json`, "utf8");
  router.addProfile(name, json);
}

const originLat = 40.692, originLon = -73.990;
const destLat   = 40.692, destLon   = -73.988;

for (const profile of ["generic_pedestrian", "manual_wheelchair"]) {
  const json = router.shortestPathJSON(profile, originLat, originLon, destLat, destLon, null);
  const result = JSON.parse(json);
  if (result.status === "Ok") {
    console.log(`[${profile}] total_cost=${result.total_cost.toFixed(1)}m edges=${result.edges.length}`);
  } else {
    console.log(`[${profile}] ${result.code}`);
  }
}
