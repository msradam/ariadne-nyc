import type { privacyLog as PrivacyLogType } from '../services/privacy-log';
import type { WasmEdge, IsochroneResult } from '../domain/route';
import type { RouterProfileId } from '../domain/profile';
import { computeIsochrone } from '../isochrone';

export type RouteResult = {
  cost: number; length_m: number;
  coords: [number, number][]; nodes: number; edges: WasmEdge[];
};

export interface PedestrianRouterAdapter {
  readonly ready: Promise<void>;
  route(opts: {
    from: [number, number]; to: [number, number]; profile: RouterProfileId; night?: boolean;
  }): RouteResult;
  shortestPathTree(opts: {
    from: [number, number]; profile: RouterProfileId; maxMinutes: number;
  }): IsochroneResult | null;
  stats(): { nodes: number; edges: number };
  getRawWasm(): unknown;
}

type WasmRouter = {
  shortestPathJSON(profile: string, originLat: number, originLon: number, destLat: number, destLon: number, args: null): string;
  shortestPathTreeJSON(profile: string, originLat: number, originLon: number, maxCost: number, args: null): string;
  nodeCount(): number; edgeCount(): number; addProfile(name: string, json: string): void;
};

function haversineM(a: [number, number], b: [number, number]): number {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]), dLng = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const PROFILE_FILES: Record<RouterProfileId, string> = {
  manual_wheelchair:  'profile-manual_wheelchair.json',
  generic_pedestrian: 'profile-generic_pedestrian.json',
  low_vision:         'profile-low_vision.json',
};

export class UnweaverWasmAdapter implements PedestrianRouterAdapter {
  readonly ready: Promise<void>;
  private wasm!: WasmRouter;
  private _resolve!: () => void;

  constructor(private log: typeof PrivacyLogType) {
    this.ready = new Promise((res) => { this._resolve = res; });
  }

  async load(
    onProgress: (msg: string) => void,
    pkgUrl = '/pkg',
    graphUrl = '/output/nyc-pedestrian.bin',
    examplesUrl = '/examples'
  ): Promise<void> {
    onProgress('Loading WASM module…');
    this.log.z3(pkgUrl, 'unweaver-wasm WASM module');
    const wasmMod = await import(/* @vite-ignore */ `${pkgUrl}/unweaver_wasm.js`);
    this.log.z3(`${pkgUrl}/unweaver_wasm_bg.wasm`, 'unweaver-wasm binary');
    await wasmMod.default({ module_or_path: await fetch(`${pkgUrl}/unweaver_wasm_bg.wasm`) });
    const RouterClass = wasmMod.Router as new () => WasmRouter;

    onProgress('Fetching NYC pedestrian graph…');
    this.log.z3(graphUrl, 'NYC pedestrian routing graph (~30 MB binary)');
    const resp = await fetch(graphUrl);
    if (!resp.ok) throw new Error(`graph fetch failed: ${resp.status}`);
    const total = parseInt(resp.headers.get('content-length') || '0', 10);
    const reader = resp.body!.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      if (total > 0) onProgress(`Fetching graph… ${Math.round(80 * received / total)}%`);
    }

    onProgress('Parsing binary graph…');
    const buf = new Uint8Array(chunks.reduce((a, c) => a + c.byteLength, 0));
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    this.wasm = (RouterClass as unknown as { fromBinary(b: Uint8Array): WasmRouter }).fromBinary(buf);

    onProgress('Loading routing profiles…');
    for (const [profileId, filename] of Object.entries(PROFILE_FILES)) {
      const url = `${examplesUrl}/${filename}`;
      this.log.z3(url, `Routing profile: ${profileId}`);
      const r = await fetch(url);
      if (r.ok) this.wasm.addProfile(profileId, await r.text());
    }

    this._resolve();
  }

  route({ from, to, profile }: { from: [number, number]; to: [number, number]; profile: RouterProfileId }): RouteResult {
    const json = this.wasm.shortestPathJSON(profile, from[1], from[0], to[1], to[0], null);
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

    return { cost: res.total_cost ?? length_m, length_m, coords, nodes: res.edges.length + 1, edges: res.edges };
  }

  shortestPathTree({ from, profile, maxMinutes }: { from: [number, number]; profile: RouterProfileId; maxMinutes: number }): IsochroneResult | null {
    return computeIsochrone(this.wasm, profile, from[1], from[0], maxMinutes);
  }

  stats(): { nodes: number; edges: number } {
    return { nodes: this.wasm.nodeCount(), edges: this.wasm.edgeCount() };
  }

  getRawWasm(): unknown {
    return this.wasm;
  }
}
