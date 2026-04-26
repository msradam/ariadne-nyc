import { writable } from 'svelte/store';
import type { ComfortRouteOk, ReachableRouteOk } from '../domain/route';
import type { RouterProfileId } from '../domain/profile';

export type RouteState =
  | { kind: 'none' }
  | { kind: 'route'; result: ComfortRouteOk }
  | { kind: 'reachable'; result: ReachableRouteOk; budgetExplicit: boolean };

export const routeState = writable<RouteState>({ kind: 'none' });
export const isochroneMode = writable(false);
export const activeProfile = writable<RouterProfileId>('generic_pedestrian');
