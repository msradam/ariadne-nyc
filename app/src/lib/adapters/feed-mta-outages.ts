import type { privacyLog as PrivacyLogType } from '../services/privacy-log';
import type { FeedSource } from './feed-weather';

// MTA ships this key plaintext in their public widget bundle at
// https://consist.mta.info/elevators-escalators/index.js. Not a secret.
const MTA_API_KEY = 'UHbeYqoprP7N6LixCPVJN3TuZLAAEe0p6YxOPRJ2';
const BASE = 'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds';

export type ElevatorOutage = {
  equipment: string;
  station: string;
  type: 'EL' | 'ES';
  ada: boolean;
  gtfsStopIds: string[];
  outageStart?: string;
  estimatedReturn?: string;
  reason?: string;
  upcoming: boolean;
  maintenance: boolean;
};

export type ElevatorState = {
  fetchedAt: string;
  outages: ElevatorOutage[];
  impactedAdaStopIds: Set<string>;
  rawOutages: number;
  equipmentsCount: number;
};

type RawOutage = {
  station: string; equipment: string; equipmenttype: 'EL' | 'ES';
  ADA: 'Y' | 'N'; outagedate?: string; estimatedreturntoservice?: string;
  reason?: string; isupcomingoutage?: 'Y' | 'N'; ismaintenanceoutage?: 'Y' | 'N';
};
type RawEquipment = {
  equipmentno: string; equipmenttype: 'EL' | 'ES'; ADA: 'Y' | 'N';
  station: string; elevatorsgtfsstopid?: string;
};

async function getJson(path: string): Promise<unknown> {
  const url = `${BASE}/${encodeURIComponent('nyct/' + path)}`;
  const r = await fetch(url, { headers: { 'x-api-key': MTA_API_KEY } });
  if (!r.ok) throw new Error(`MTA ${path} ${r.status}`);
  return r.json();
}

export class MTAOutagesAdapter implements FeedSource<ElevatorState> {
  constructor(private log: typeof PrivacyLogType) {}

  async fetch(): Promise<ElevatorState | null> {
    try {
      const outagesUrl = `${BASE}/${encodeURIComponent('nyct/nyct_ene.json')}`;
      const equipUrl   = `${BASE}/${encodeURIComponent('nyct/nyct_ene_equipments.json')}`;
      this.log.z2(outagesUrl, 'MTA elevator/escalator current outages feed');
      this.log.z2(equipUrl,   'MTA elevator equipment index (GTFS stop_id mapping)');

      const [outagesRaw, equipmentsRaw] = (await Promise.all([
        getJson('nyct_ene.json'),
        getJson('nyct_ene_equipments.json'),
      ])) as [RawOutage[], RawEquipment[]];

      const equipById = new Map<string, RawEquipment>();
      for (const e of equipmentsRaw) equipById.set(e.equipmentno, e);

      const impacted = new Set<string>();
      const enriched: ElevatorOutage[] = [];

      for (const o of outagesRaw) {
        const upcoming = o.isupcomingoutage === 'Y';
        const ada = o.ADA === 'Y';
        const isElev = o.equipmenttype === 'EL';
        const eq = equipById.get(o.equipment);
        const ids = (eq?.elevatorsgtfsstopid || '')
          .split(/[\/|]/).map((s) => s.trim()).filter(Boolean);
        enriched.push({
          equipment: o.equipment, station: o.station, type: o.equipmenttype,
          ada, gtfsStopIds: ids, outageStart: o.outagedate,
          estimatedReturn: o.estimatedreturntoservice, reason: o.reason,
          upcoming, maintenance: o.ismaintenanceoutage === 'Y',
        });
        if (!upcoming && ada && isElev) for (const id of ids) impacted.add(id);
      }

      return {
        fetchedAt: new Date().toISOString(),
        outages: enriched,
        impactedAdaStopIds: impacted,
        rawOutages: outagesRaw.length,
        equipmentsCount: equipmentsRaw.length,
      };
    } catch {
      return null;
    }
  }
}

export function resolveImpactedInternal(
  stops: {
    findStopBySourceStopId(s: string): { id: number; parent?: number } | undefined;
    findStopById(i: number): { id: number } | undefined;
    equivalentStops(i: number): Array<{ id: number }>;
  },
  gtfsStopIds: Set<string>
): Set<number> {
  const out = new Set<number>();
  for (const sid of gtfsStopIds) {
    const s = stops.findStopBySourceStopId(sid);
    if (!s) continue;
    const parent = (s.parent ?? s.id) as number;
    const root = stops.findStopById(parent) ?? s;
    out.add(root.id);
    for (const eq of stops.equivalentStops(root.id)) out.add(eq.id);
  }
  return out;
}
