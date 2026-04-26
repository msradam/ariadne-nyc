import { Timetable, StopsIndex, Router, Query } from 'minotor';
import type { Route } from 'minotor';
import type { Stop } from 'minotor';
import type { privacyLog as PrivacyLogType } from '../services/privacy-log';
import { resolveImpactedInternal } from './feed-mta-outages';

export type { Stop, Route };

export interface TransitRouterAdapter {
  readonly stopsCount: number;
  readonly adaInternalIds: Set<number>;
  readonly adaSourceStopIds: Set<string>;
  findNearestStops(lat: number, lng: number, maxResults?: number, radiusKm?: number): Stop[];
  findStopById(id: number): Stop | undefined;
  route(fromStopId: number, toStopIds: Set<number>, departureMinutes: number): Route | null;
  subtractImpactedElevators(gtfsStopIds: Set<string>): number;
  readonly stops: StopsIndex;
}

export class MinotorAdapter implements TransitRouterAdapter {
  private _stops!: StopsIndex;
  private timetable!: Timetable;
  private router!: Router;
  private _stopsCount = 0;
  readonly adaInternalIds: Set<number> = new Set();
  readonly adaSourceStopIds: Set<string> = new Set();

  constructor(private log: typeof PrivacyLogType) {}

  async load(timetableUrl: string, stopsUrl: string, adaUrl?: string): Promise<void> {
    this.log.z3(timetableUrl, 'NYC subway RAPTOR timetable binary');
    this.log.z3(stopsUrl, 'NYC subway stops index binary');

    const [ttBuf, stopsBuf, adaArr] = await Promise.all([
      fetch(timetableUrl).then((r) => r.arrayBuffer()),
      fetch(stopsUrl).then((r) => r.arrayBuffer()),
      adaUrl
        ? (this.log.z2(adaUrl, 'MTA ADA-accessible station GTFS stop_id list'),
           fetch(adaUrl).then((r) => (r.ok ? r.json() : [])).catch(() => []))
        : Promise.resolve([]),
    ]);

    this.timetable = Timetable.fromData(new Uint8Array(ttBuf));
    this._stops = StopsIndex.fromData(new Uint8Array(stopsBuf));
    this.router = new Router(this.timetable, this._stops);
    this._stopsCount = this._stops.size();

    for (const sid of adaArr as string[]) {
      this.adaSourceStopIds.add(sid);
      const s = this._stops.findStopBySourceStopId(sid);
      if (!s) continue;
      const parent = (s.parent ?? s.id) as number;
      const root = this._stops.findStopById(parent) ?? s;
      this.adaInternalIds.add(root.id);
      for (const eq of this._stops.equivalentStops(root.id)) this.adaInternalIds.add(eq.id);
    }
  }

  get stopsCount(): number { return this._stopsCount; }
  get stops(): StopsIndex { return this._stops; }

  findNearestStops(lat: number, lng: number, maxResults = 3, radiusKm = 0.8): Stop[] {
    return this._stops.findStopsByLocation(lat, lng, maxResults, radiusKm);
  }

  findStopById(id: number): Stop | undefined {
    return this._stops.findStopById(id);
  }

  route(fromStopId: number, toStopIds: Set<number>, departureMinutes: number) {
    const q = new Query.Builder()
      .from(fromStopId).to(toStopIds).departureTime(departureMinutes).maxTransfers(3).build();
    const result = this.router.route(q);
    return result.bestRoute(toStopIds) ?? null;
  }

  subtractImpactedElevators(gtfsStopIds: Set<string>): number {
    const impacted = resolveImpactedInternal(this._stops, gtfsStopIds);
    for (const id of impacted) this.adaInternalIds.delete(id);
    return impacted.size;
  }
}
