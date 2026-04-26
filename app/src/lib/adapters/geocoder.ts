// Fully-offline geocoder. No network calls. Resolves NYC named places
// (landmarks, transit, parks, neighborhoods, amenities, buildings) from the
// 23k-entry POI index built by pipeline/sources/fetch_open_data.py.
//
// Resolution order. Deterministic first, fuzzy only for typos:
//   1. Exact case-insensitive name match.
//   2. Token-aware prefix/contains match.
//   3. Fuse fuzzy match for transposition / typo recovery
//      (tight threshold; only fires when above two miss).
//
// Ranking across all stages prefers higher-priority categories (borough >
// transit > neighborhood > park > amenity > building) and shorter names
// (a 3-token "Penn Station" beats "Penn Station Eagle Restaurant" for the
// same query "penn station").

import Fuse from 'fuse.js';
import type { Landmark } from '../domain/geo';
import type { privacyLog as PrivacyLogType } from '../services/privacy-log';

export interface GeocoderAdapter {
  load(url: string): Promise<number>;
  /** Load the street-keyed address index (post-load, optional). */
  loadStreets?(url: string): Promise<number>;
  geocode(q: string): Landmark | null;
  geocodeAsync(q: string): Promise<Landmark | null>;
}

type POI = { name: string; lat: number; lng: number; type: string; category: string };

const PRIORITY: Record<string, number> = {
  borough: 0, transit: 1, neighborhood: 2, park: 3,
  amenity_priority: 4, poi: 5, amenity: 6, building: 7, address: 8, other: 9,
};
const NYC_BBOX = { minLat: 40.47, maxLat: 40.95, minLng: -74.27, maxLng: -73.69 };

function withinNYC(lat: number, lng: number): boolean {
  return lat >= NYC_BBOX.minLat && lat <= NYC_BBOX.maxLat &&
    lng >= NYC_BBOX.minLng && lng <= NYC_BBOX.maxLng;
}

/**
 * Normalize for matching: lowercase, collapse whitespace, expand common NYC
 * street-type abbreviations, and handle the Queens block-house format
 * ("85 26 123rd St" → "85-26 123rd street").
 */
function normalize(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.replace(/\b(\d{1,3})\s+(\d{1,4})(?=\s+\d+(?:st|nd|rd|th)?\b)/gi, '$1-$2');
  s = s.replace(/\bst(?:\.)?(?=\s|,|$)/g, 'street');
  s = s.replace(/\bave?(?:\.)?(?=\s|,|$)/g, 'avenue');
  s = s.replace(/\bblvd(?:\.)?(?=\s|,|$)/g, 'boulevard');
  s = s.replace(/\brd(?:\.)?(?=\s|,|$)/g, 'road');
  s = s.replace(/\bdr(?:\.)?(?=\s|,|$)/g, 'drive');
  s = s.replace(/\bpl(?:\.)?(?=\s|,|$)/g, 'place');
  s = s.replace(/\bpkwy(?:\.)?(?=\s|,|$)/g, 'parkway');
  s = s.replace(/\bln(?:\.)?(?=\s|,|$)/g, 'lane');
  s = s.replace(/\bct(?:\.)?(?=\s|,|$)/g, 'court');
  s = s.replace(/\bter(?:\.)?(?=\s|,|$)/g, 'terrace');
  s = s.replace(/\btpke?(?:\.)?(?=\s|,|$)/g, 'turnpike');
  s = s.replace(/\bsq(?:\.)?(?=\s|,|$)/g, 'square');
  s = s.replace(/\bnyc\b/g, '');
  s = s.replace(/\b(new york|new york city|manhattan|brooklyn|queens|bronx|staten island)\b/g, ' ');
  return s.replace(/[,]/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function priorityOf(p: POI): number {
  return PRIORITY[p.category] ?? 9;
}

/**
 * Score a candidate against a normalized query for deterministic ranking.
 * Lower is better. Tiebreakers in order: priority, name length, original order.
 */
function rankKey(p: POI, q: string, idx: number, score: number): [number, number, number, number, number] {
  const name = p.name.toLowerCase();
  const exact = name === q ? 0 : 1;
  const prefix = name.startsWith(q) ? 0 : 1;
  return [exact, prefix, score, priorityOf(p) * 0.05 + name.length * 0.001, idx];
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// Compact street row from data/nyc-streets.json:
//   [street_key, borough, [[housenum, lat, lng] | [housenum, suffix, lat, lng], ...]]
type StreetRow = [string, string, Array<[number, number, number] | [number, string, number, number]>];

type StreetEntry = {
  key: string;          // normalized street name
  borough: string;
  // Sorted by housenum ascending, then suffix.
  housenums: Array<{ num: number; suffix: string; lat: number; lng: number }>;
};

/**
 * Parse "85-26 123rd Street, Queens" into structured parts.
 * Handles formats: "<num> <street>", "<num> <street>, <borough>",
 * "<num>-<num> <street>", numeric-prefix only.
 * Returns null if no leading housenumber is detected.
 */
function parseAddressQuery(q: string): { housenum: string; numKey: number; street: string; borough: string | null } | null {
  const m = q.trim().match(/^\s*(\d+(?:-\d+)?[A-Za-z]?)\s+(.+?)(?:\s*,\s*(manhattan|brooklyn|queens|bronx|staten\s*island))?\s*$/i);
  if (!m) return null;
  const hn = m[1];
  const numDigits = hn.replace(/[^0-9]/g, '');
  const numKey = numDigits.length ? parseInt(numDigits, 10) : 0;
  const street = m[2].trim();
  const borough = m[3] ? m[3].replace(/\s+/g, ' ').toLowerCase() : null;
  return { housenum: hn, numKey, street, borough };
}

const BOROUGH_DISPLAY: Record<string, string> = {
  'manhattan': 'Manhattan', 'brooklyn': 'Brooklyn', 'queens': 'Queens',
  'bronx': 'Bronx', 'staten island': 'Staten Island',
};

export class FuseGeocoderAdapter implements GeocoderAdapter {
  private fuse: Fuse<POI> | null = null;
  private all: POI[] = [];
  // Map of normalized name → POIs sharing that name (for exact lookups).
  private byNormName = new Map<string, POI[]>();

  // Address index. Populated by loadStreets(). Optional; geocoder works
  // without it but loses street-address coverage.
  private streetByKey = new Map<string, StreetEntry[]>();   // key → entries (one per borough)
  private streetFuse: Fuse<StreetEntry> | null = null;
  private streetEntries: StreetEntry[] = [];

  constructor(private log: typeof PrivacyLogType) {}

  async load(url: string): Promise<number> {
    this.log.z3(url, 'POI index for fuzzy geocoder (~23k named places, landmarks, neighborhoods)');
    const r = await fetch(url);
    if (!r.ok) throw new Error(`POI fetch failed ${r.status}`);
    const pois = (await r.json()) as POI[];
    // Filter outside-NYC entries up-front so all later stages stay in-bounds.
    this.all = pois.filter((p) => withinNYC(p.lat, p.lng));

    for (const p of this.all) {
      const k = normalize(p.name);
      let bucket = this.byNormName.get(k);
      if (!bucket) { bucket = []; this.byNormName.set(k, bucket); }
      bucket.push(p);
    }

    this.fuse = new Fuse(this.all, {
      keys: [{ name: 'name', weight: 1 }],
      threshold: 0.45,            // typos and transpositions, but not arbitrary substrings
      distance: 60,
      ignoreLocation: true,
      includeScore: true,
      minMatchCharLength: 3,
    });
    return this.all.length;
  }

  /**
   * Load the structured street-keyed address index produced by
   * pipeline/sources/build_address_index.py (data/nyc-streets.json).
   * ~40 MB, ~19k unique (street, borough) entries holding ~1.4M housenumbers.
   * Lazy: callers can fire-and-forget this in the background.
   */
  async loadStreets(url: string): Promise<number> {
    this.log.z3(url, 'NYC street/address index for offline structured geocoding (~19k streets, ~1.4M housenums)');
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Streets index fetch failed ${r.status}`);
    const rows = (await r.json()) as StreetRow[];

    this.streetEntries = [];
    for (const [key, borough, hns] of rows) {
      const parsed = hns.map((row) => {
        if (row.length === 3) {
          return { num: row[0], suffix: '', lat: row[1] as number, lng: row[2] as number };
        }
        return { num: row[0], suffix: row[1] as string, lat: row[2] as number, lng: row[3] as number };
      });
      const entry: StreetEntry = { key, borough, housenums: parsed };
      this.streetEntries.push(entry);
      let bucket = this.streetByKey.get(key);
      if (!bucket) { bucket = []; this.streetByKey.set(key, bucket); }
      bucket.push(entry);
    }

    this.streetFuse = new Fuse(this.streetEntries, {
      keys: [{ name: 'key', weight: 1 }],
      threshold: 0.30,
      distance: 80,
      ignoreLocation: true,
      includeScore: true,
      minMatchCharLength: 3,
    });
    return this.streetEntries.length;
  }

  /** Find nearest housenumber on a given StreetEntry. */
  private resolveOnStreet(entry: StreetEntry, target: number): { lat: number; lng: number } {
    const hs = entry.housenums;
    if (hs.length === 0) return { lat: 0, lng: 0 };
    if (target <= hs[0].num) return { lat: hs[0].lat, lng: hs[0].lng };
    if (target >= hs[hs.length - 1].num) return { lat: hs[hs.length - 1].lat, lng: hs[hs.length - 1].lng };
    // Binary search for nearest by absolute diff.
    let lo = 0, hi = hs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (hs[mid].num < target) lo = mid + 1;
      else hi = mid;
    }
    const cand = lo === 0 ? hs[0] : (Math.abs(hs[lo].num - target) <= Math.abs(hs[lo - 1].num - target) ? hs[lo] : hs[lo - 1]);
    return { lat: cand.lat, lng: cand.lng };
  }

  /** Stage 4: structured address resolution. Returns null if nothing matches. */
  private resolveAddress(q: string): Landmark | null {
    if (this.streetEntries.length === 0) return null;
    const parsed = parseAddressQuery(q);
    if (!parsed) return null;
    const streetKey = normalize(parsed.street);
    if (!streetKey) return null;

    // Exact street match. Disambiguate by borough if user named one.
    let candidates = this.streetByKey.get(streetKey) ?? [];
    if (parsed.borough && candidates.length > 0) {
      const filt = candidates.filter((e) => e.borough.toLowerCase() === parsed.borough);
      if (filt.length > 0) candidates = filt;
    }

    // Fuzzy fallback on street keys only. Much smaller search space than 1.4M.
    if (candidates.length === 0 && this.streetFuse) {
      const hits = this.streetFuse.search(streetKey, { limit: 8 });
      if (hits.length === 0 || (hits[0].score ?? 1) > 0.30) return null;
      const topKey = hits[0].item.key;
      candidates = this.streetByKey.get(topKey) ?? [];
      if (parsed.borough) {
        const filt = candidates.filter((e) => e.borough.toLowerCase() === parsed.borough);
        if (filt.length > 0) candidates = filt;
      }
    }
    if (candidates.length === 0) return null;

    // Pick the candidate whose housenum range best contains the target.
    // Tiebreaker (gap === 0): prefer Manhattan > Brooklyn > Queens > Bronx > SI
    // when no borough was specified. Handles "1 Wall Street" → Manhattan, not Brooklyn.
    const BORO_RANK: Record<string, number> = {
      manhattan: 0, brooklyn: 1, queens: 2, bronx: 3, 'staten island': 4,
    };
    let best: { entry: StreetEntry; coord: { lat: number; lng: number }; gap: number; rank: number } | null = null;
    for (const entry of candidates) {
      const coord = this.resolveOnStreet(entry, parsed.numKey);
      const minNum = entry.housenums[0]?.num ?? 0;
      const maxNum = entry.housenums[entry.housenums.length - 1]?.num ?? 0;
      const gap = parsed.numKey < minNum ? minNum - parsed.numKey
                : parsed.numKey > maxNum ? parsed.numKey - maxNum : 0;
      const rank = BORO_RANK[entry.borough.toLowerCase()] ?? 9;
      if (!best || gap < best.gap || (gap === best.gap && rank < best.rank)) {
        best = { entry, coord, gap, rank };
      }
    }
    if (!best || !withinNYC(best.coord.lat, best.coord.lng)) return null;
    const display = `${parsed.housenum} ${parsed.street.replace(/\b\w/g, (c) => c.toUpperCase())}, ${BOROUGH_DISPLAY[best.entry.borough.toLowerCase()] ?? best.entry.borough}`;
    return { lat: best.coord.lat, lng: best.coord.lng, display };
  }

  /** Synchronous offline lookup. Same logic as geocodeAsync (which simply awaits this). */
  geocode(q: string): Landmark | null {
    const direct = this.geocodeDirect(q);
    if (direct) return direct;

    // Fallback: strip leading neighborhood qualifiers and retry once.
    // Handles "downtown Flushing" → "Flushing", "the Bronx" → "Bronx".
    // Single-shot to avoid recursion on phrases like "the the Bronx".
    const QUALIFIER_RX = /^(downtown|uptown|midtown|central|the|north|south|east|west|northern|southern|eastern|western|northeast|northwest|southeast|southwest)\s+/i;
    if (q && QUALIFIER_RX.test(q.trim())) {
      const stripped = q.trim().replace(QUALIFIER_RX, '').trim();
      if (stripped) return this.geocodeDirect(stripped);
    }
    return null;
  }

  private geocodeDirect(q: string): Landmark | null {
    if (!q || !this.fuse) return null;
    const norm = normalize(q);
    if (!norm) return null;

    // Address-first: if the query starts with a housenumber, prefer the
    // structured street index. This avoids "1 Wall Street" being clobbered
    // by a "111 Wall Street" partial-token match in stage 2.
    if (/^\s*\d/.test(q)) {
      const addr = this.resolveAddress(q);
      if (addr) return addr;
    }

    // Stage 1. Exact normalized match. Multiple POIs may share a name; pick by priority.
    const exact = this.byNormName.get(norm);
    if (exact && exact.length > 0) {
      const sorted = [...exact].sort((a, b) => priorityOf(a) - priorityOf(b) || a.name.length - b.name.length);
      const p = sorted[0];
      return { lat: p.lat, lng: p.lng, display: `${p.name} (${p.type})` };
    }

    // Stage 2. Token-aware prefix / contains. Deterministic; tolerates suffixes
    // ("grand central" matches "Grand Central-42 St").
    const tokens = norm.split(/\s+/).filter((t) => t.length >= 2);
    if (tokens.length > 0) {
      const candidates: { p: POI; idx: number; score: number }[] = [];
      for (let i = 0; i < this.all.length; i++) {
        const p = this.all[i];
        const name = p.name.toLowerCase();
        // All tokens must appear; cheap whole-token check.
        if (!tokens.every((t) => name.includes(t))) continue;
        // Prefer matches where the joined query appears as a contiguous span.
        const span = name.indexOf(norm);
        const score = span >= 0 ? span * 0.001 : 0.5 + (name.length - norm.length) * 0.001;
        candidates.push({ p, idx: i, score });
      }
      if (candidates.length > 0) {
        candidates.sort((a, b) =>
          compareKeys(rankKey(a.p, norm, a.idx, a.score), rankKey(b.p, norm, b.idx, b.score))
        );
        const p = candidates[0].p;
        return { lat: p.lat, lng: p.lng, display: `${p.name} (${p.type})` };
      }
    }

    // Stage 3. Fuzzy fallback (typos only). Tight threshold; ranked by priority.
    const hits = this.fuse.search(norm, { limit: 12 });
    if (hits.length > 0 && (hits[0].score ?? 1) <= 0.45) {
      const ranked = hits
        .map((h, i) => ({ p: h.item, idx: i, score: h.score ?? 1 }))
        .sort((a, b) =>
          compareKeys(rankKey(a.p, norm, a.idx, a.score), rankKey(b.p, norm, b.idx, b.score))
        );
      const p = ranked[0].p;
      return { lat: p.lat, lng: p.lng, display: `${p.name} (${p.type})` };
    }

    // Stage 4. Structured address resolution. Only if streets index is loaded
    // and the query parses as "<housenum> <street>[, <borough>]".
    return this.resolveAddress(q);
  }

  async geocodeAsync(q: string): Promise<Landmark | null> {
    return this.geocode(q);
  }
}
