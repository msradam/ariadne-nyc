import type { WeatherContext } from '../domain/narration';
import type { privacyLog as PrivacyLogType } from '../services/privacy-log';

export interface FeedSource<T> {
  fetch(): Promise<T | null>;
}

// NWS. Anonymous civic data, Z2.
const NWS_POINTS = 'https://api.weather.gov/points/40.7128,-74.0060';
const USER_AGENT = 'ariadne-opensidewalks/2.0 (accessibility router; contact: public)';

export class WeatherAdapter implements FeedSource<WeatherContext> {
  constructor(private log: typeof PrivacyLogType) {}

  async fetch(): Promise<WeatherContext | null> {
    try {
      this.log.z2(NWS_POINTS, 'NWS points lookup for NYC hourly forecast URL');
      const pr = await fetch(NWS_POINTS, { headers: { 'User-Agent': USER_AGENT } });
      const pj = await pr.json();
      const forecastUrl = pj?.properties?.forecastHourly || pj?.properties?.forecast;

      let temp_f: number | null = null;
      let summary = '';
      if (forecastUrl) {
        this.log.z2(forecastUrl, 'NWS hourly forecast for NYC current conditions');
        const fr = await fetch(forecastUrl, { headers: { 'User-Agent': USER_AGENT } });
        const fj = await fr.json();
        const cur = fj?.properties?.periods?.[0];
        if (cur) { temp_f = cur.temperature; summary = cur.shortForecast; }
      }

      const alertUrl = 'https://api.weather.gov/alerts/active?point=40.7128,-74.0060';
      this.log.z2(alertUrl, 'NWS active weather alerts for NYC');
      const ar = await fetch(alertUrl, { headers: { 'User-Agent': USER_AGENT } });
      const aj = await ar.json();
      const evs = ((aj?.features as Array<{ properties?: { event?: string } }>) || [])
        .map((f) => f.properties?.event).filter(Boolean) as string[];
      const code_red = evs.some((e) => /heat advisory|excessive heat/i.test(e));
      const code_blue = evs.some((e) => /wind chill|extreme cold/i.test(e)) || (temp_f !== null && temp_f <= 32);

      return { temp_f, summary, code_red, code_blue };
    } catch {
      return null;
    }
  }
}
