/**
 * route-cli. Programmatic test harness for ariadne-nyc routing.
 *
 * Boots the same RouterService used in the browser, against the same data
 * files in <repo>/data/, and runs a single query with verbose diagnostics.
 *
 * Usage:
 *   npx tsx scripts/route-cli.ts plan "Kew Gardens" "Grand Central" wheelchair
 *   npx tsx scripts/route-cli.ts find "Penn Station" cool_indoor wheelchair
 *   npx tsx scripts/route-cli.ts reach "Penn Station" cool_indoor 15
 *
 * The harness skips WebLLM entirely. Tool calls are constructed directly,
 * so this exercises the deterministic routing path without LLM nondeterminism.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Timetable, StopsIndex, Router as MinotorRouter, Query } from 'minotor';
import type { Stop, Route as MinotorRoute } from 'minotor';

import { RouterService } from '../src/lib/services/router-service.ts';
import type { ComfortFeature } from '../src/lib/domain/poi.ts';
import type { RouterProfileId } from '../src/lib/domain/profile.ts';
import { computeIsochrone } from '../src/lib/isochrone.ts';
import type { WasmEdge, IsochroneResult } from '../src/lib/domain/route.ts';
import type {
  PedestrianRouterAdapter,
  RouteResult,
} from '../src/lib/adapters/pedestrian-router.ts';
import type { TransitRouterAdapter } from '../src/lib/adapters/transit-router.ts';
import { FuseGeocoderAdapter } from '../src/lib/adapters/geocoder.ts';
import type { GeocoderAdapter } from '../src/lib/adapters/geocoder.ts';
import { resolveImpactedInternal } from '../src/lib/adapters/feed-mta-outages.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// app/scripts/route-cli.ts → repo root is two levels up
const REPO_ROOT = path.resolve(__dirname, '../..');
const DATA = path.join(REPO_ROOT, 'data');
const PKG = path.join(REPO_ROOT, 'router/pkg');
const PROFILES_DIR = path.join(REPO_ROOT, 'router/examples');

// ── ANSI helpers ───────────────────────────────────────────────────────────
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
};

function log(...args: unknown[]) { console.log(...args); }
function logSection(title: string) { log(`\n${c.bold(c.blue(`── ${title} ──`))}`); }

// ── Pedestrian (WASM) ──────────────────────────────────────────────────────
async function makePedestrianAdapter(): Promise<PedestrianRouterAdapter & { wasm: any }> {
  log(c.dim(`Loading WASM router from ${path.relative(REPO_ROOT, PKG)}…`));
  const wasmMod = await import(`file://${PKG}/unweaver_wasm.js`);
  const wasmBytes = fs.readFileSync(path.join(PKG, 'unweaver_wasm_bg.wasm'));
  await wasmMod.default({ module_or_path: wasmBytes });

  log(c.dim(`Loading pedestrian graph from ${path.relative(REPO_ROOT, path.join(DATA, 'nyc-pedestrian.bin'))}…`));
  const graphBytes = fs.readFileSync(path.join(DATA, 'nyc-pedestrian.bin'));
  const wasm = wasmMod.Router.fromBinary(new Uint8Array(graphBytes));

  for (const id of ['manual_wheelchair', 'generic_pedestrian', 'low_vision'] as const) {
    const file = path.join(PROFILES_DIR, `profile-${id}.json`);
    wasm.addProfile(id, fs.readFileSync(file, 'utf8'));
  }

  log(c.dim(`Graph: ${wasm.nodeCount().toLocaleString()} nodes, ${wasm.edgeCount().toLocaleString()} edges`));

  function haversineM(a: [number, number], b: [number, number]): number {
    const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(b[1] - a[1]), dLng = toRad(b[0] - a[0]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  return {
    wasm,
    ready: Promise.resolve(),
    route({ from, to, profile }) {
      const json = wasm.shortestPathJSON(profile, from[1], from[0], to[1], to[0], null);
      const res = JSON.parse(json) as { status: string; code?: string; total_cost?: number; edges?: WasmEdge[] };
      if (res.status !== 'Ok' || !res.edges) throw new Error(`No path (${res.code ?? res.status})`);
      const coords: [number, number][] = [];
      for (const e of res.edges) {
        for (const pt of e.geom.coordinates) {
          const last = coords[coords.length - 1];
          if (!last || last[0] !== pt[0] || last[1] !== pt[1]) coords.push(pt);
        }
      }
      const length_m = coords.length > 1
        ? coords.slice(1).reduce((sum, pt, i) => sum + haversineM(coords[i], pt), 0) : 0;
      return { cost: res.total_cost ?? length_m, length_m, coords, nodes: res.edges.length + 1, edges: res.edges } as RouteResult;
    },
    shortestPathTree({ from, profile, maxMinutes }): IsochroneResult | null {
      return computeIsochrone(wasm, profile, from[1], from[0], maxMinutes);
    },
    stats() { return { nodes: wasm.nodeCount(), edges: wasm.edgeCount() }; },
    getRawWasm() { return wasm; },
  };
}

// ── Geocoder (uses the real FuseGeocoderAdapter) ────────────────────────────
async function makeGeocoderAdapter(): Promise<GeocoderAdapter> {
  log(c.dim('Loading POI index via FuseGeocoderAdapter…'));
  // Polyfill fetch() to read POI JSON from disk so we use the real adapter unchanged.
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, _init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('file://') || url.startsWith('/')) {
      const filepath = url.startsWith('file://') ? fileURLToPath(url) : path.join(DATA, path.basename(url));
      const data = await fs.promises.readFile(filepath);
      return new Response(data, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return origFetch(input as any, _init);
  }) as typeof fetch;

  const stubLog = { z1: () => {}, z2: () => {}, z3: () => {} } as any;
  const adapter = new FuseGeocoderAdapter(stubLog);
  const count = await adapter.load(`file://${path.join(DATA, 'nyc-pois.json')}`);
  log(c.dim(`POI index: ${count.toLocaleString()} entries`));
  const streetsPath = path.join(DATA, 'nyc-streets.json');
  if (fs.existsSync(streetsPath) && adapter.loadStreets) {
    const sCount = await adapter.loadStreets(`file://${streetsPath}`);
    log(c.dim(`Street index: ${sCount.toLocaleString()} (street, borough) entries`));
  }
  return adapter;
}

// ── Transit (Minotor) ──────────────────────────────────────────────────────
async function makeTransitAdapter(): Promise<TransitRouterAdapter | undefined> {
  log(c.dim('Loading Minotor transit data…'));
  const ttBuf = fs.readFileSync(path.join(DATA, 'timetable.bin'));
  const stopsBuf = fs.readFileSync(path.join(DATA, 'stops.bin'));
  const adaArr = JSON.parse(fs.readFileSync(path.join(DATA, 'ada-stops.json'), 'utf8')) as string[];

  const timetable = Timetable.fromData(new Uint8Array(ttBuf));
  const stops = StopsIndex.fromData(new Uint8Array(stopsBuf));
  const router = new MinotorRouter(timetable, stops);

  const adaInternalIds = new Set<number>();
  const adaSourceStopIds = new Set<string>(adaArr);
  for (const sid of adaArr) {
    const s = stops.findStopBySourceStopId(sid);
    if (!s) continue;
    const parent = (s.parent ?? s.id) as number;
    const root = stops.findStopById(parent) ?? s;
    adaInternalIds.add(root.id);
    for (const eq of stops.equivalentStops(root.id)) adaInternalIds.add(eq.id);
  }

  log(c.dim(`Transit: ${stops.size().toLocaleString()} stops · ${adaInternalIds.size} ADA`));

  return {
    stopsCount: stops.size(),
    adaInternalIds,
    adaSourceStopIds,
    stops,
    findNearestStops: (lat, lng, maxResults = 3, radiusKm = 0.8) => stops.findStopsByLocation(lat, lng, maxResults, radiusKm),
    findStopById: (id) => stops.findStopById(id),
    route: (fromStopId: number, toStopIds: Set<number>, departureMinutes: number): MinotorRoute | null => {
      const q = new Query.Builder().from(fromStopId).to(toStopIds).departureTime(departureMinutes).maxTransfers(3).build();
      const result = router.route(q);
      return result.bestRoute(toStopIds) ?? null;
    },
    subtractImpactedElevators(gtfsStopIds: Set<string>): number {
      const impacted = resolveImpactedInternal(stops, gtfsStopIds);
      for (const id of impacted) adaInternalIds.delete(id);
      return impacted.size;
    },
  };
}

// ── Comfort features ───────────────────────────────────────────────────────
function loadComfort(): ComfortFeature[] {
  log(c.dim('Loading comfort features…'));
  const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'nyc-comfort.json'), 'utf8'));
  const features = (raw.features ?? raw) as ComfortFeature[];
  log(c.dim(`Comfort features: ${features.length.toLocaleString()}`));
  return features;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || !['plan', 'find', 'reach', 'geocode', 'diagnose'].includes(cmd)) {
    console.error('Usage:');
    console.error('  npx tsx scripts/route-cli.ts plan "<from>" "<to>" [profile]');
    console.error('  npx tsx scripts/route-cli.ts find "<near>" "<resource_type>" [profile]');
    console.error('  npx tsx scripts/route-cli.ts reach "<near>" "<resource_type>" [max_minutes]');
    console.error('  npx tsx scripts/route-cli.ts geocode "<query>"');
    console.error('\nProfiles: generic_pedestrian | wheelchair | low_vision | slow_walker | stroller');
    console.error('Resource types: cool_indoor warm_indoor bathroom seating quiet_indoor wifi_power');
    console.error('               linknyc food_pantry senior_center harm_reduction medical mental_health');
    console.error('               community_center shelter_24h pool_indoor');
    process.exit(1);
  }

  logSection('BOOT');
  const pedestrian = await makePedestrianAdapter();
  const comfort = loadComfort();
  const geocoder = await makeGeocoderAdapter();
  const transit = await makeTransitAdapter();
  const service = new RouterService(geocoder as any, pedestrian, transit, comfort);

  logSection(cmd.toUpperCase());

  if (cmd === 'geocode') {
    const q = rest[0];
    const r = await geocoder.geocodeAsync(q);
    log(r ? c.green('found:') : c.red('miss:'), r ?? '(none)');
    return;
  }

  if (cmd === 'diagnose') {
    const [from, to, profile = 'generic_pedestrian'] = rest;
    log(`from=${c.bold(from)}  to=${c.bold(to)}  profile=${c.bold(profile)}`);

    const a = await geocoder.geocodeAsync(from);
    const b = await geocoder.geocodeAsync(to);
    if (!a) { log(c.red('origin geocode miss')); return; }
    if (!b) { log(c.red('destination geocode miss')); return; }
    log(`origin: ${a.display} @ ${a.lat.toFixed(4)},${a.lng.toFixed(4)}`);
    log(`dest:   ${b.display} @ ${b.lat.toFixed(4)},${b.lng.toFixed(4)}`);

    const PROFILE_MAP: Record<string, RouterProfileId> = {
      wheelchair: 'manual_wheelchair', manual_wheelchair: 'manual_wheelchair',
      slow_walker: 'generic_pedestrian', stroller: 'generic_pedestrian',
      low_vision: 'low_vision', generic_pedestrian: 'generic_pedestrian',
    };
    const p = PROFILE_MAP[profile] ?? 'generic_pedestrian';
    log(`resolved profile: ${p}`);

    log(c.bold('\n[1] walk-only attempt'));
    try {
      const r = pedestrian.route({ from: [a.lng, a.lat], to: [b.lng, b.lat], profile: p, night: false });
      log(c.green(`  ok: ${r.length_m}m, ${(r.length_m / 1.4 / 60).toFixed(0)} min walk`));
    } catch (e) {
      log(c.red(`  fail: ${(e as Error).message}`));
    }

    if (!transit) { log(c.red('no transit adapter')); return; }

    const requireAda = p === 'manual_wheelchair';
    const radius = requireAda ? 4.0 : 2.0;
    log(c.bold(`\n[2] nearest stops (radius=${radius}km, requireAda=${requireAda})`));
    const originRaw = transit.findNearestStops(a.lat, a.lng, 40, radius);
    const destRaw = transit.findNearestStops(b.lat, b.lng, 40, radius);
    log(`  origin candidates raw: ${originRaw.length}`);
    log(`  dest   candidates raw: ${destRaw.length}`);

    function dedupeToParents(s: Stop[]): Stop[] {
      const seen = new Set<number>();
      const out: Stop[] = [];
      for (const x of s) {
        const id = (x.parent ?? x.id) as number;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(transit!.findStopById(id) ?? x);
      }
      return out;
    }
    const originParents = dedupeToParents(originRaw);
    const destParents = dedupeToParents(destRaw);
    log(`  origin parents: ${originParents.length} → ${originParents.slice(0, 5).map((s) => s.name).join(', ')}`);
    log(`  dest   parents: ${destParents.length} → ${destParents.slice(0, 5).map((s) => s.name).join(', ')}`);

    const filterAda = (stops: Stop[]) => {
      if (!transit!.adaInternalIds.size) return stops;
      const accessible = stops.filter((x) => transit!.adaInternalIds.has(x.id));
      return requireAda ? accessible : stops;
    };
    const originAda = filterAda(originParents).slice(0, 6);
    const destAda = filterAda(destParents).slice(0, 6);
    log(`  origin ADA-filtered: ${originAda.length} → ${originAda.map((s) => s.name).join(', ')}`);
    log(`  dest   ADA-filtered: ${destAda.length} → ${destAda.map((s) => s.name).join(', ')}`);

    if (!originAda.length || !destAda.length) {
      log(c.red('  [3] cannot try RAPTOR. Empty origin or dest stop set'));
      return;
    }

    const now = new Date();
    const depMinutes = now.getHours() * 60 + now.getMinutes();
    log(c.bold(`\n[3] RAPTOR (departureMinutes=${depMinutes})`));
    const destSet = new Set(destAda.map((s) => s.id));
    let attempts = 0, hits = 0;
    for (const orig of originAda) {
      attempts++;
      const route = transit!.route(orig.id, destSet, depMinutes);
      if (!route || !route.legs?.length) continue;
      hits++;
      const last = route.legs[route.legs.length - 1];
      const transitMin = (() => { try { return route.arrivalTime() - route.departureTime(); } catch { return -1; } })();
      log(c.green(`  ✓ from ${orig.name} → ${last.to.name} (${route.legs.length} legs, ${transitMin} min transit)`));
    }
    log(`  attempts: ${attempts}, RAPTOR hits: ${hits}`);

    if (!hits) {
      log(c.red('  RAPTOR found no transit route between any origin/dest pair'));
      return;
    }

    log(c.bold('\n[4] walk-in / walk-out feasibility for first RAPTOR hit'));
    for (const orig of originAda) {
      const route = transit!.route(orig.id, destSet, depMinutes);
      if (!route || !route.legs?.length) continue;
      const last = route.legs[route.legs.length - 1];
      const alight = last.to;
      try {
        const walkIn = pedestrian.route({ from: [a.lng, a.lat], to: [orig.lon!, orig.lat!], profile: p, night: false });
        log(c.green(`  walk-in ok: ${a.display} → ${orig.name} (${walkIn.length_m}m)`));
      } catch (e) {
        log(c.red(`  walk-in FAIL: ${a.display} → ${orig.name}: ${(e as Error).message}`));
      }
      try {
        const walkOut = pedestrian.route({ from: [alight.lon!, alight.lat!], to: [b.lng, b.lat], profile: p, night: false });
        log(c.green(`  walk-out ok: ${alight.name} → ${b.display} (${walkOut.length_m}m)`));
      } catch (e) {
        log(c.red(`  walk-out FAIL: ${alight.name} → ${b.display}: ${(e as Error).message}`));
      }
      break;
    }
    return;
  }

  if (cmd === 'plan') {
    const [from, to, profile = 'generic_pedestrian'] = rest;
    log(`from=${c.bold(from)}  to=${c.bold(to)}  profile=${c.bold(profile)}`);
    const result = await service.planRoute({ from, to, profile, night: false });
    printResult(result);
    return;
  }

  if (cmd === 'find') {
    const [near, resourceType, profile = 'generic_pedestrian'] = rest;
    log(`near=${c.bold(near)}  type=${c.bold(resourceType)}  profile=${c.bold(profile)}`);
    const result = await service.findComfortAndRoute({
      near, resource_types: [resourceType], profile, night: false,
    });
    printResult(result);
    return;
  }

  if (cmd === 'reach') {
    const [near, resourceType, maxStr] = rest;
    const args: any = { near, resource_types: [resourceType], profile: 'generic_pedestrian' };
    if (maxStr) args.max_minutes = Number(maxStr);
    log(`near=${c.bold(near)}  type=${c.bold(resourceType)}  max=${args.max_minutes ?? '(default)'}`);
    const result = await service.findReachable(args);
    if (!result.ok) { log(c.red('error:'), result.error); return; }
    log(c.green('ok:'), `${result.pois.length} places within ${result.max_minutes} min of ${result.origin_name}`);
    for (const [i, p] of result.pois.slice(0, 10).entries()) {
      log(`  ${i + 1}. ${p.name} (${p.resource_types.join(',')}). ${p.walk_min} min`);
    }
    return;
  }
}

function printResult(result: any) {
  if (!result.ok) {
    log(c.red('NO PATH:'), result.error);
    return;
  }
  log(c.green('OK'));
  log(`  origin: ${result.origin_name}`);
  log(`  destination: ${result.destination_name}${result.destination_address ? ' · ' + result.destination_address : ''}`);
  log(`  profile: ${result.profile}`);
  log(`  mode: ${result.mode}`);
  if (result.mode === 'walk_transit_walk' && result.picked_stops) {
    log(`  board: ${result.picked_stops.board}`);
    log(`  alight: ${result.picked_stops.alight}`);
    log(`  transit minutes: ${result.transit_minutes}`);
  }
  if (result.transit_warning) log(c.yellow(`  warning: ${result.transit_warning}`));
  log(`  walking_meters: ${result.walking_meters}`);
  log(`  total_seconds: ${result.total_seconds} (${Math.round(result.total_seconds / 60)} min)`);
  log(`  legs: ${result.multimodal_legs?.length ?? 0}`);
  if (result.multimodal_legs) {
    for (const [i, leg] of result.multimodal_legs.entries()) {
      const len = leg.kind === 'walk' ? `${leg.length_m}m` : 'transit';
      log(`    ${i + 1}. [${leg.kind}] ${leg.from} → ${leg.to} (${len})`);
    }
  }
}

main().catch((e) => { console.error(c.red('FATAL:'), e); process.exit(1); });
