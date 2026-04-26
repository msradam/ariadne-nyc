import { writable } from 'svelte/store';
import type { WeatherContext } from '../domain/narration';

export type TransitState = {
  stopsCount: number;
  adaCount: number;
  elevatorsOut: number;
  loaded: boolean;
};

export type LoadPhase =
  | 'graph_loading'
  | 'graph_ready'
  | 'graph_error'
  | 'transit_loading'
  | 'transit_ready'
  | 'model_probing'
  | 'model_loading'
  | 'model_ready'
  | 'model_error';

export const weather = writable<WeatherContext | null>(null);
export const transitState = writable<TransitState | null>(null);
export const loadPhase = writable<LoadPhase>('graph_loading');
export const loadMessage = writable('Initialising…');
export const loadProgress = writable(0);
export const graphStats = writable<{ nodes: number; edges: number; pois: number; comfort: number } | null>(null);
