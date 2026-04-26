// Deterministic step-by-step directions from a walk edge sequence.
// Ported from v1; no LLM. Pure geometry + OSM attribute post-processing.

import type { WasmEdge, RouteStep } from './domain/route';
export type { RouteStep };

function haversineM(a: [number, number], b: [number, number]): number {
  const R = 6371000, tr = (d: number) => d * Math.PI / 180;
  const dLat = tr(b[1] - a[1]), dLng = tr(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(tr(a[1])) * Math.cos(tr(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function edgeLen(coords: [number, number][]): number {
  let d = 0;
  for (let i = 1; i < coords.length; i++) d += haversineM(coords[i - 1], coords[i]);
  return d;
}

function bearing(a: [number, number], b: [number, number]): number {
  const [lng1, lat1] = [a[0] * Math.PI / 180, a[1] * Math.PI / 180];
  const [lng2, lat2] = [b[0] * Math.PI / 180, b[1] * Math.PI / 180];
  const y = Math.sin(lng2 - lng1) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lng2 - lng1);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function compass(b: number): string {
  return ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round(b / 45) % 8];
}

function classifyTurn(fromB: number, toB: number): RouteStep['maneuver'] {
  const delta = ((toB - fromB + 540) % 360) - 180;
  const abs = Math.abs(delta), side = delta < 0 ? 'left' : 'right';
  if (abs < 30)  return 'straight';
  if (abs < 55)  return `slight_${side}` as RouteStep['maneuver'];
  if (abs < 120) return side as RouteStep['maneuver'];
  if (abs < 165) return `sharp_${side}` as RouteStep['maneuver'];
  return 'uturn';
}

function fmtDist(m: number): string {
  if (m < 50)   return `${Math.round(m)} m`;
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

const TURN_LABELS: Partial<Record<RouteStep['maneuver'], string>> = {
  straight: 'Continue straight', left: 'Turn left', right: 'Turn right',
  slight_left: 'Bear left', slight_right: 'Bear right',
  sharp_left: 'Turn sharp left', sharp_right: 'Turn sharp right', uturn: 'Make a U-turn',
};

function crossingIsSignificant(edge: WasmEdge): boolean {
  const c = String(edge.crossing ?? '').toLowerCase();
  const hasSignal = c.includes('signal') || c.includes('traffic');
  const hasName = !!edge.name;
  const hasTactile = String(edge.tactile_paving ?? '').toLowerCase() === 'yes';
  const hasCurb = Object.keys(edge).some(
    (k) => /curb|ramp/i.test(k) && /yes|flush|lowered/i.test(String(edge[k] ?? ''))
  );
  return hasSignal || hasName || hasTactile || hasCurb;
}

function crossingNote(edge: WasmEdge): string | undefined {
  const parts: string[] = [];
  const c = String(edge.crossing ?? '').toLowerCase();
  if (c.includes('signal') || c.includes('traffic')) parts.push('signalized');
  else if (c.includes('mark')) parts.push('marked');
  if (String(edge.tactile_paving ?? '').toLowerCase() === 'yes') parts.push('tactile paving');
  const hasCurb = Object.keys(edge).some(
    (k) => /curb|ramp/i.test(k) && /yes|flush|lowered/i.test(String(edge[k] ?? ''))
  );
  if (hasCurb) parts.push('curb ramp');
  return parts.join(' · ') || undefined;
}

export function buildWalkSteps(edges: WasmEdge[], fromLabel: string, toLabel: string): RouteStep[] {
  if (!edges.length) return [{ instruction: `Walk to ${toLabel}`, distance_m: 0, maneuver: 'arrive' }];

  const steps: RouteStep[] = [];
  let accDist = 0;
  let accName: string | undefined;
  let pendingManeuver: RouteStep['maneuver'] = 'depart';
  let prevExitBearing: number | null = null;
  let departBearing: number | null = null;

  function flush() {
    if (accDist < 15) return;
    let instr: string;
    if (pendingManeuver === 'depart' && departBearing !== null) {
      instr = `Head ${compass(departBearing)}${accName ? ` on ${accName}` : ''}`;
    } else {
      instr = (TURN_LABELS[pendingManeuver] ?? 'Continue') + (accName ? ` on ${accName}` : '');
    }
    instr += ` · ${fmtDist(accDist)}`;
    steps.push({ instruction: instr, distance_m: Math.round(accDist), maneuver: pendingManeuver });
    accDist = 0;
    accName = undefined;
    pendingManeuver = 'straight';
  }

  for (const edge of edges) {
    const coords = edge.geom.coordinates;
    if (coords.length < 2) continue;

    const entryBearing = bearing(coords[0], coords[1]);
    const exitBearing = bearing(coords[coords.length - 2], coords[coords.length - 1]);
    const dist = edgeLen(coords);
    const footway = String(edge.footway ?? '').toLowerCase();
    const isCrossing = footway === 'crossing' || footway.includes('crossing');
    const isStairs = footway === 'steps' || footway === 'stairs';
    const isElevator = footway === 'elevator';

    if (departBearing === null) departBearing = entryBearing;

    if (isCrossing) {
      if (!crossingIsSignificant(edge)) { accDist += dist; prevExitBearing = exitBearing; continue; }
      flush();
      const note = crossingNote(edge);
      const streetName = edge.name ? ` ${edge.name}` : '';
      steps.push({ instruction: `Cross${streetName}${note ? ` · ${note}` : ''}`, distance_m: Math.round(dist), maneuver: 'cross', accessibility_note: note });
      prevExitBearing = exitBearing;
      pendingManeuver = 'straight';
      continue;
    }

    if (isStairs || isElevator) {
      flush();
      const incline = typeof edge.incline === 'number' ? edge.incline : 0;
      const dir = incline > 0.01 ? ' up' : incline < -0.01 ? ' down' : '';
      steps.push({ instruction: `Take ${isElevator ? 'elevator' : 'stairs'}${dir}`, distance_m: Math.round(dist), maneuver: isElevator ? 'elevator' : 'stairs' });
      prevExitBearing = exitBearing;
      pendingManeuver = 'straight';
      continue;
    }

    if (prevExitBearing !== null) {
      const turn = classifyTurn(prevExitBearing, entryBearing);
      const name = edge.name as string | undefined;
      const nameChanged = !!name && !!accName && name !== accName;
      const isSlight = turn === 'slight_left' || turn === 'slight_right';
      const shouldBreak = (turn !== 'straight' && (!isSlight || accDist >= 50)) || nameChanged;
      if (shouldBreak) { flush(); pendingManeuver = turn; departBearing = entryBearing; }
    }

    accDist += dist;
    if (edge.name && !accName) accName = edge.name as string;
    prevExitBearing = exitBearing;
  }

  flush();
  steps.push({ instruction: `Arrive at ${toLabel}`, distance_m: 0, maneuver: 'arrive' });
  return steps;
}

export function buildMultimodalSteps(
  walkInEdges: WasmEdge[], walkOutEdges: WasmEdge[],
  boardStation: string, alightStation: string,
  fromLabel: string, toLabel: string
): RouteStep[] {
  const legIn = buildWalkSteps(walkInEdges, fromLabel, boardStation);
  const legOut = buildWalkSteps(walkOutEdges, alightStation, toLabel);
  legIn.pop();
  const transit: RouteStep = {
    instruction: `Take subway · ${boardStation} → ${alightStation}`,
    distance_m: 0,
    maneuver: 'transit',
  };
  return [...legIn, transit, ...legOut];
}

export function stepsToText(steps: RouteStep[]): string {
  return steps.map((s, i) => `${i + 1}. ${s.instruction}`).join('\n');
}
