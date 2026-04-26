// RouterService orchestrates geocoding, routing, and comfort lookups.
// No fetch() here. All external I/O is in adapters.

import type { GeocoderAdapter } from '../adapters/geocoder';
import type { GeolocationAdapter } from '../adapters/geolocation';
import type { PedestrianRouterAdapter } from '../adapters/pedestrian-router';
import type { TransitRouterAdapter, Stop } from '../adapters/transit-router';
import type { Landmark } from '../domain/geo';
import { haversineM } from '../domain/geo';
import type { ComfortFeature } from '../domain/poi';
import type {
  ComfortRouteOk, ToolError, ReachableRouteOk, ReachablePoi, MultimodalLeg,
} from '../domain/route';
import { PROFILE_MAP } from '../domain/profile';
import type { RouterProfileId } from '../domain/profile';
import { validateSafetyDestination, safetySummary } from './safety';
import type { ComfortCategory } from '../domain/poi';

// Sentinel + free-form variants meaning "use the user's current location".
// Anything in this set hits geolocation instead of the fuzzy geocoder.
const ME_PATTERNS = /^@?(me|here|my\s*location|current\s*location|i\s*am\s*here)$/i;

/**
 * Error code returned to the LLM/UI layer when an origin couldn't be resolved
 * because the user gave none and we have no location fix. Distinct from
 * "unknown location" so the UI can prompt for a starting point specifically.
 */
export const NO_ORIGIN_ERROR = 'no_origin';

const WALK_MPS = 1.25;
const STATION_OVERHEAD_S = 90;

export class RouterService {
  constructor(
    private geocoder: GeocoderAdapter,
    private pedestrian: PedestrianRouterAdapter,
    private transit: TransitRouterAdapter | null,
    private comfortFeatures: ComfortFeature[],
    private geolocation: GeolocationAdapter | null = null,
  ) {}

  private resolveProfile(profile: string): RouterProfileId {
    return PROFILE_MAP[profile] ?? 'generic_pedestrian';
  }

  /**
   * Resolve an origin/near string to a Landmark. Recognizes the "@me" sentinel
   * (and free-form variants) as a request for the browser's geolocation API.
   * Returns a `NO_ORIGIN_ERROR` ToolError when the user gave nothing AND we
   * couldn't get a fix. The UI translates that into "please give a starting point".
   */
  private async resolveOrigin(near: string | undefined): Promise<Landmark | ToolError> {
    const raw = (near ?? '').trim();
    const wantsMe = !raw || ME_PATTERNS.test(raw);

    if (wantsMe) {
      if (!this.geolocation) {
        return { ok: false, error: NO_ORIGIN_ERROR };
      }
      const fix = await this.geolocation.getCurrentPosition();
      if (!fix.ok) return { ok: false, error: NO_ORIGIN_ERROR };
      return { lat: fix.coords.lat, lng: fix.coords.lng, display: 'Your location' };
    }

    const a = await this.geocoder.geocodeAsync(raw);
    if (!a) return { ok: false, error: `unknown location: "${raw}"` };
    return a;
  }

  async planRoute(args: {
    from: string; to: string; profile: string; night?: boolean;
  }): Promise<ComfortRouteOk | ToolError> {
    const [aRes, bRes] = await Promise.all([
      this.resolveOrigin(args.from),
      this.geocoder.geocodeAsync(args.to),
    ]);
    if ('ok' in aRes && aRes.ok === false) return aRes;
    const a = aRes as Landmark;
    if (!bRes) return { ok: false, error: `unknown destination: "${args.to}"` };
    return this.routeBetween(a, bRes, args.profile, !!args.night, [], null);
  }

  async findComfortAndRoute(args: {
    near: string; resource_types: string[]; profile: string; night?: boolean;
  }): Promise<ComfortRouteOk | ToolError> {
    const aRes = await this.resolveOrigin(args.near);
    if ('ok' in aRes && aRes.ok === false) return aRes;
    const a = aRes as Landmark;
    if (!this.comfortFeatures.length) return { ok: false, error: 'comfort index not loaded' };

    const wanted = new Set(args.resource_types);
    const origin: [number, number] = [a.lng, a.lat];
    const cands: Array<{ feature: ComfortFeature; dist: number }> = [];

    for (const f of this.comfortFeatures) {
      if (!f.properties.resource_types.some((t) => wanted.has(t))) continue;
      if (f.properties.is_temporarily_closed) continue;
      const d = haversineM(origin, f.geometry.coordinates);
      if (d > 3000) continue;
      cands.push({ feature: f, dist: d });
    }
    cands.sort((x, y) => x.dist - y.dist);
    if (!cands.length)
      return { ok: false, error: `no comfort resource within 3 km of ${a.display} for [${[...wanted].join(', ')}]` };

    const pick = cands[0].feature;

    // Safety check for critical resource types
    const safety = validateSafetyDestination(pick, args.resource_types as ComfortCategory[]);
    if (!safety.ok) return { ok: false, error: safetySummary(safety.error) };

    const dest: Landmark = {
      lat: pick.geometry.coordinates[1],
      lng: pick.geometry.coordinates[0],
      display: pick.properties.name,
    };
    return this.routeBetween(a, dest, args.profile, !!args.night, cands, pick);
  }

  async findReachable(args: {
    near: string; resource_types: string[]; profile: string; max_minutes?: number;
  }): Promise<ReachableRouteOk | ToolError> {
    const aRes = await this.resolveOrigin(args.near);
    if ('ok' in aRes && aRes.ok === false) return aRes;
    const a = aRes as Landmark;
    if (!this.comfortFeatures.length) return { ok: false, error: 'comfort index not loaded' };

    const p = this.resolveProfile(args.profile);
    const maxMin = args.max_minutes ?? 15;
    const iso = this.pedestrian.shortestPathTree({ from: [a.lng, a.lat], profile: p, maxMinutes: maxMin });
    if (!iso) return { ok: false, error: `could not compute isochrone from "${args.near}"` };

    const maxCostM = maxMin * 60 * WALK_MPS;
    const radiusM = maxCostM * 1.1;
    const degLat = radiusM / 111320;
    const degLng = radiusM / (111320 * Math.cos((a.lat * Math.PI) / 180));
    const wanted = new Set(args.resource_types);
    const pois: ReachablePoi[] = [];

    for (const f of this.comfortFeatures) {
      if (!f.properties.resource_types.some((t) => wanted.has(t))) continue;
      if (f.properties.is_temporarily_closed) continue;
      const [fLng, fLat] = f.geometry.coordinates;
      if (Math.abs(fLat - a.lat) > degLat || Math.abs(fLng - a.lng) > degLng) continue;

      let nearestCost = Infinity, nearestDist = Infinity;
      for (const n of iso.reachableNodes) {
        const d = haversineM([fLng, fLat], [n.lng, n.lat]);
        if (d < nearestDist) { nearestDist = d; nearestCost = n.cost_m; }
      }
      if (nearestDist > 120 || nearestCost > maxCostM) continue;
      pois.push({
        name: f.properties.name, resource_types: f.properties.resource_types,
        address: f.properties.address, lat: fLat, lng: fLng,
        walk_min: Math.round((nearestCost / WALK_MPS / 60) * 10) / 10,
      });
    }
    pois.sort((a, b) => a.walk_min - b.walk_min);

    return { ok: true, origin_name: a.display, profile: p, max_minutes: maxMin, resource_types: args.resource_types, pois, isochrone: iso };
  }

  private async routeBetween(
    a: Landmark, b: Landmark,
    profile: string, night: boolean,
    cands: Array<{ feature: ComfortFeature; dist: number }>,
    pick: ComfortFeature | null
  ): Promise<ComfortRouteOk | ToolError> {
    const p = this.resolveProfile(profile);
    const t0 = performance.now();
    const now = new Date();
    const depMinutes = now.getHours() * 60 + now.getMinutes();

    // Try direct walk. Failure is non-fatal. Long inter-borough trips often
    // can't walk the full distance but should still be solved by transit.
    let directRes: ReturnType<PedestrianRouterAdapter['route']> | null = null;
    let walkErr: string | null = null;
    try {
      directRes = this.pedestrian.route({ from: [a.lng, a.lat], to: [b.lng, b.lat], profile: p, night });
    } catch (e) {
      walkErr = String((e as Error)?.message ?? e);
    }

    const walkOnly = directRes ? this.buildWalkOnlyResult(a, b, p, night, directRes, pick, cands, t0) : null;

    // Short-walk fast path: if walk-only succeeded, is short, and there's no transit, take it.
    if (walkOnly && (!this.transit || (directRes && directRes.length_m < 600))) return walkOnly;

    // Try multimodal. Baseline to beat is walk-only's time, or Infinity if walk failed.
    const baselineSeconds = directRes ? directRes.length_m / WALK_MPS : Infinity;
    const mm = this.transit
      ? await this.tryMultimodal(a, b, p, night, depMinutes, baselineSeconds, pick, cands, t0)
      : null;

    if (mm) return mm;
    if (walkOnly) return walkOnly;
    return { ok: false, error: walkErr ?? `no path found from ${a.display} to ${b.display}` };
  }

  private buildWalkOnlyResult(
    a: Landmark, b: Landmark, profile: RouterProfileId, night: boolean,
    res: ReturnType<PedestrianRouterAdapter['route']>,
    pick: ComfortFeature | null,
    cands: Array<{ feature: ComfortFeature; dist: number }>,
    t0: number
  ): ComfortRouteOk {
    return {
      ok: true,
      origin_name: a.display,
      destination_name: pick?.properties.name ?? b.display,
      destination_source: pick?.properties.source ?? 'landmark',
      destination_address: pick?.properties.address ?? '',
      destination_types: pick?.properties.resource_types ?? [],
      destination_hours_today: pick?.properties.hours_today ?? 'unknown',
      candidates_considered: cands.length,
      candidates_top: cands.slice(0, 8).map((c) => ({
        name: c.feature.properties.name, source: c.feature.properties.source,
        lat: c.feature.geometry.coordinates[1], lng: c.feature.geometry.coordinates[0],
        dist_m: Math.round(c.dist),
      })),
      profile, night,
      length_m: Math.round(res.length_m), cost: Math.round(res.cost), nodes: res.nodes,
      coords: res.coords, elapsed_ms: Math.round(performance.now() - t0),
      mode: 'walk_only', transit_minutes: 0, walking_meters: Math.round(res.length_m), total_seconds: Math.round(res.length_m / WALK_MPS),
      multimodal_legs: [{ kind: 'walk', coords: res.coords, length_m: Math.round(res.length_m), cost: Math.round(res.cost), from: a.display, to: pick?.properties.name ?? b.display, edges: res.edges }],
      sheds_on_route: [], shed_edge_hits: 0,
    };
  }

  private async tryMultimodal(
    a: Landmark, b: Landmark, profile: RouterProfileId, night: boolean, depMinutes: number,
    baselineSeconds: number,
    pick: ComfortFeature | null,
    cands: Array<{ feature: ComfortFeature; dist: number }>,
    t0: number
  ): Promise<ComfortRouteOk | null> {
    const transit = this.transit!;
    const requireAda = profile === 'manual_wheelchair';
    const radius = requireAda ? 4.0 : 2.0;

    function dedupeToParents(stops: Stop[]): Stop[] {
      const seen = new Set<number>();
      const out: Stop[] = [];
      for (const s of stops) {
        const id = (s.parent ?? s.id) as number;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(transit.findStopById(id) ?? s);
      }
      return out;
    }

    const originRaw = transit.findNearestStops(a.lat, a.lng, 40, radius);
    const destRaw   = transit.findNearestStops(b.lat, b.lng, 40, radius);
    const originParents = dedupeToParents(originRaw);
    const destParents   = dedupeToParents(destRaw);

    function filterAda(stops: Stop[]): Stop[] {
      if (!transit.adaInternalIds.size) return stops;
      const accessible = stops.filter((s) => transit.adaInternalIds.has(s.id));
      return requireAda ? accessible : stops;
    }

    let warning: string | undefined;
    let originStops = filterAda(originParents).slice(0, 6);
    let destStops   = filterAda(destParents).slice(0, 6);

    if (requireAda && (!originStops.length || !destStops.length)) {
      const which = !originStops.length && !destStops.length ? 'origin and destination' : !originStops.length ? 'origin' : 'destination';
      warning = `No fully ADA-accessible station near ${which}. Falling back to nearest stations. Verify elevator access before traveling.`;
      originStops = originParents.slice(0, 6);
      destStops   = destParents.slice(0, 6);
    }

    if (!originStops.length || !destStops.length) return null;

    const destSet = new Set(destStops.map((s) => s.id));
    let bestResult: ComfortRouteOk | null = null;
    let bestTotal = baselineSeconds;

    for (const orig of originStops) {
      if (orig.lat == null || orig.lon == null) continue;
      const origLat = orig.lat, origLon = orig.lon;
      const route = transit.route(orig.id, destSet, depMinutes);
      if (!route || !route.legs?.length) continue;
      const lastLeg = route.legs[route.legs.length - 1];
      const alightStop = lastLeg.to;
      if (alightStop.lat == null || alightStop.lon == null) continue;
      const alightLat = alightStop.lat, alightLon = alightStop.lon;

      let walkIn: ReturnType<PedestrianRouterAdapter['route']>;
      let walkOut: ReturnType<PedestrianRouterAdapter['route']>;
      try {
        walkIn  = this.pedestrian.route({ from: [a.lng, a.lat],       to: [origLon, origLat],     profile, night });
        walkOut = this.pedestrian.route({ from: [alightLon, alightLat], to: [b.lng, b.lat],         profile, night });
      } catch { continue; }

      let transitMinutes = 15;
      try {
        const dep = route.departureTime();
        const arr = route.arrivalTime();
        if (typeof dep === 'number' && typeof arr === 'number' && arr > dep) transitMinutes = arr - dep;
      } catch { /* keep default */ }

      const total = walkIn.length_m / WALK_MPS + transitMinutes * 60 + walkOut.length_m / WALK_MPS + STATION_OVERHEAD_S;
      if (total >= bestTotal) continue;
      bestTotal = total;

      const legs: MultimodalLeg[] = [
        { kind: 'walk', coords: walkIn.coords, length_m: Math.round(walkIn.length_m), cost: Math.round(walkIn.cost), from: a.display, to: orig.name, edges: walkIn.edges },
        { kind: 'transit', from: orig.name, to: alightStop.name, coords: [[origLon, origLat], [alightLon, alightLat]] },
        { kind: 'walk', coords: walkOut.coords, length_m: Math.round(walkOut.length_m), cost: Math.round(walkOut.cost), from: alightStop.name, to: pick?.properties.name ?? b.display, edges: walkOut.edges },
      ];
      const walkingMeters = Math.round(walkIn.length_m + walkOut.length_m);

      bestResult = {
        ok: true,
        origin_name: a.display,
        destination_name: pick?.properties.name ?? b.display,
        destination_source: pick?.properties.source ?? 'landmark',
        destination_address: pick?.properties.address ?? '',
        destination_types: pick?.properties.resource_types ?? [],
        destination_hours_today: pick?.properties.hours_today ?? 'unknown',
        candidates_considered: cands.length,
        candidates_top: cands.slice(0, 8).map((c) => ({
          name: c.feature.properties.name, source: c.feature.properties.source,
          lat: c.feature.geometry.coordinates[1], lng: c.feature.geometry.coordinates[0], dist_m: Math.round(c.dist),
        })),
        profile, night,
        length_m: walkingMeters, cost: Math.round(walkIn.cost + walkOut.cost), nodes: walkIn.nodes,
        coords: [...walkIn.coords, [origLon, origLat], [alightLon, alightLat], ...walkOut.coords],
        elapsed_ms: Math.round(performance.now() - t0),
        mode: 'walk_transit_walk', transit_minutes: transitMinutes, walking_meters: walkingMeters,
        total_seconds: Math.round(total),
        picked_stops: { board: orig.name, alight: alightStop.name },
        multimodal_legs: legs,
        transit_warning: warning,
        sheds_on_route: [], shed_edge_hits: 0,
      };
    }
    return bestResult;
  }

  accessibilityNote(result: ComfortRouteOk): string {
    const ratio = result.cost / Math.max(1, result.length_m);
    if (result.profile === 'manual_wheelchair' && ratio > 1.5)
      return 'path includes several corner-ramp gaps; wheelchair router accepted some raised-kerb crossings';
    if (result.profile === 'manual_wheelchair' && ratio > 1.15)
      return 'path includes a few corner-ramp gaps; wheelchair router detoured where possible';
    if (result.profile === 'low_vision' && result.night && ratio > 1.4)
      return 'at night, router preferred signalized crossings where possible';
    return 'straightforward path. No significant friction';
  }
}
