// Browser geolocation adapter. Wraps navigator.geolocation with a
// caching layer + privacy logging.
//
// FEATURE GATE. Currently DISABLED.
// `navigator.geolocation` on devices without a GPS chip (most desktops,
// most laptops) silently calls the OS's positioning service (Google /
// Apple), which sends nearby Wi-Fi access-point fingerprints out of the
// device. That breaks the "nothing leaves the browser" guarantee.
// We keep this adapter wired so the @me sentinel path stays exercised end
// to end; flip GEOLOCATION_ENABLED to true (and consider gating on a
// high-accuracy GPS fix only) once devices the app targets are known to
// have GPS hardware.
const GEOLOCATION_ENABLED = false;

import type { privacyLog as PrivacyLogType } from '../services/privacy-log';

export type GeoCoords = { lat: number; lng: number; accuracy_m: number };

export type GeoOutcome =
  | { ok: true; coords: GeoCoords }
  | { ok: false; reason: 'denied' | 'unavailable' | 'timeout' | 'unsupported' | 'out_of_bounds' | 'disabled' };

export interface GeolocationAdapter {
  getCurrentPosition(opts?: { maxAge?: number }): Promise<GeoOutcome>;
  /** Last known position, if any. Synchronous read. */
  cached(): GeoCoords | null;
}

const NYC_BBOX = { minLat: 40.47, maxLat: 40.95, minLng: -74.27, maxLng: -73.69 };

function withinNYC(c: GeoCoords): boolean {
  return c.lat >= NYC_BBOX.minLat && c.lat <= NYC_BBOX.maxLat &&
    c.lng >= NYC_BBOX.minLng && c.lng <= NYC_BBOX.maxLng;
}

export class BrowserGeolocationAdapter implements GeolocationAdapter {
  private last: { coords: GeoCoords; at: number } | null = null;
  private inflight: Promise<GeoOutcome> | null = null;

  constructor(private log: typeof PrivacyLogType) {}

  cached(): GeoCoords | null {
    return this.last?.coords ?? null;
  }

  async getCurrentPosition({ maxAge = 60_000 }: { maxAge?: number } = {}): Promise<GeoOutcome> {
    // Hard gate: never call navigator.geolocation while the feature is off.
    // The OS positioning service is invoked even if we just probe. Keep this
    // short-circuit at the very top.
    if (!GEOLOCATION_ENABLED) {
      return { ok: false, reason: 'disabled' };
    }

    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      return { ok: false, reason: 'unsupported' };
    }

    // Re-use a recent fix to avoid re-prompting / re-waking the GPS.
    if (this.last && Date.now() - this.last.at < maxAge) {
      return { ok: true, coords: this.last.coords };
    }

    // Coalesce concurrent requests so a flurry of queries during boot
    // doesn't trigger multiple permission flows.
    if (this.inflight) return this.inflight;

    this.log.z2('navigator.geolocation', 'Browser-provided current position (consumed locally for routing)');

    this.inflight = new Promise<GeoOutcome>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const coords: GeoCoords = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy_m: pos.coords.accuracy,
          };
          if (!withinNYC(coords)) {
            resolve({ ok: false, reason: 'out_of_bounds' });
            return;
          }
          this.last = { coords, at: Date.now() };
          resolve({ ok: true, coords });
        },
        (err) => {
          const reason =
            err.code === err.PERMISSION_DENIED ? 'denied' as const
            : err.code === err.POSITION_UNAVAILABLE ? 'unavailable' as const
            : err.code === err.TIMEOUT ? 'timeout' as const
            : 'unavailable' as const;
          resolve({ ok: false, reason });
        },
        { enableHighAccuracy: false, maximumAge: maxAge, timeout: 8_000 },
      );
    }).finally(() => { this.inflight = null; });

    return this.inflight;
  }
}
