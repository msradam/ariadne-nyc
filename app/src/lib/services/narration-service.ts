// NarrationService: LLM tool-turn → dispatch → grounded summary.
// Exact port of v1's ask.ts into a class; preserves the <documents>
// grounding contract and XML tool_call format.

import type { LLMAdapter } from '../adapters/llm';
import type { RouterService } from './router-service';
import type { WeatherContext, GroundingDoc, ChatMessage } from '../domain/narration';
import type { ComfortRouteOk, ReachableRouteOk, ToolError, ReachablePoi } from '../domain/route';
import type { RouteStep } from '../directions';
import { buildWalkSteps, buildMultimodalSteps } from '../directions';
import { langDirective } from '../lang';
import { NO_ORIGIN_ERROR } from './router-service';

const NO_ORIGIN_NARRATION =
  "I need a starting point. Please name one. E.g., a station, a neighborhood, " +
  "or a street address (“from Penn Station”, “from 85-26 123rd St, Queens”).";

// ── LLM prompt construction (ported from v1 tools.ts) ─────────────────────────

const TOOLS = [
  {
    type: 'function', function: {
      name: 'plan_route',
      description: 'Plan an accessibility-aware walking route between two named landmarks. Use when the user names both an origin and a destination.',
      parameters: { type: 'object', required: ['from', 'to', 'profile'], properties: {
        from: { type: 'string', description: 'origin landmark' },
        to: { type: 'string', description: 'destination landmark' },
        profile: { type: 'string', enum: ['generic_pedestrian', 'wheelchair', 'stroller', 'slow_walker', 'low_vision'] },
        night: { type: 'boolean' },
      }},
    },
  },
  {
    type: 'function', function: {
      name: 'find_comfort_and_route',
      description: "Find the best nearby comfort resource matching the user's need, then plan a route to it.",
      parameters: { type: 'object', required: ['near', 'resource_types', 'profile'], properties: {
        near: { type: 'string' },
        resource_types: { type: 'array', items: { type: 'string', enum: ['cool_indoor','warm_indoor','bathroom','quiet_indoor','wifi_power','shelter_24h','pool_indoor','seating','linknyc','food_pantry','senior_center','harm_reduction','medical','mental_health','community_center'] } },
        profile: { type: 'string', enum: ['generic_pedestrian', 'wheelchair', 'stroller', 'slow_walker', 'low_vision'] },
        night: { type: 'boolean' },
      }},
    },
  },
  {
    type: 'function', function: {
      name: 'find_reachable_resources',
      description: "Show ALL comfort resources reachable within a walking time budget from a location.",
      parameters: { type: 'object', required: ['near', 'resource_types', 'profile'], properties: {
        near: { type: 'string' },
        resource_types: { type: 'array', items: { type: 'string', enum: ['cool_indoor','warm_indoor','bathroom','quiet_indoor','wifi_power','shelter_24h','pool_indoor','seating','linknyc','food_pantry','senior_center','harm_reduction','medical','mental_health','community_center'] } },
        profile: { type: 'string', enum: ['generic_pedestrian', 'wheelchair', 'stroller', 'slow_walker', 'low_vision'] },
        max_minutes: { type: 'number', description: 'walk time budget in minutes. ONLY include if the user explicitly states a time limit (e.g., "in 15 minutes", "within 20 min"). Otherwise omit and the system will use a generous default.' },
      }},
    },
  },
];

function buildSystemPrompt(weather: WeatherContext | null): string {
  const wx = weather
    ? `Current NYC weather: ${weather.temp_f}°F, ${weather.summary}. ` +
      `${weather.code_red ? 'Heat advisory active. ' : ''}` +
      `${weather.code_blue ? 'Cold advisory active. ' : ''}`
    : '';
  return (
    'You are Ariadne, an accessibility-aware pedestrian routing assistant for all five boroughs of NYC. ' +
    'Pick ONE tool per user message. ' +
    'Use plan_route when the user names both origin AND destination. ' +
    'Use find_reachable_resources ONLY when the user explicitly asks what they can reach within a stated time budget (e.g., "in 15 minutes", "within 20 min", "what can I reach in 10 min"). ' +
    'Use find_comfort_and_route for any "closest X" / "nearest X" / "find me X near Y" query, OR when the user expresses a need (cool down, warm up, bathroom, rest, shelter) without a stated time budget. This returns a single best route to the closest match. ' +
    'When using find_reachable_resources, only include max_minutes if the user explicitly stated a number; otherwise omit it. ' +
    'ORIGIN HANDLING: If the user does NOT name a starting point or origin (e.g., "find me a cooling center", "nearest library"), set the origin/near argument to "@me" exactly. The system will then prompt the user for an explicit starting point. NEVER invent an origin like "Times Square" or "Central Park" when the user did not specify one. ' +
    'Infer profile from text: wheelchair = explicit wheelchair; stroller = stroller/pram/baby; slow_walker = cane/tired/fatigue/pain; low_vision = visually impaired/blind. ' +
    'If the user does NOT mention any mobility, vision, or accessibility need, you MUST use profile=generic_pedestrian. Do not guess wheelchair or low_vision when there is no signal in the text. ' +
    "Map needs to resource_types: " +
    "cool/AC/hot → ['cool_indoor']; " +
    "warm/cold/heat → ['warm_indoor']; " +
    "bathroom/restroom/toilet → ['bathroom']; " +
    "sit/rest/seat → ['seating']; " +
    "quiet/read/study → ['quiet_indoor']; " +
    "wifi/internet/charge/power → ['wifi_power']; " +
    "linknyc/free phone/kiosk → ['linknyc']; " +
    "food/hungry/pantry/soup kitchen/eat → ['food_pantry']; " +
    "senior center/older adult → ['senior_center']; " +
    "needle/syringe/harm reduction/exchange → ['harm_reduction']; " +
    "hospital/emergency/urgent care/clinic/medical → ['medical']; " +
    "mental health/counseling/crisis/therapy → ['mental_health']; " +
    "community center/rec center → ['community_center']; " +
    "overnight/shelter/sleep → ['shelter_24h']; " +
    "swim/pool → ['pool_indoor']. " +
    wx +
    '\n\n<tools>\n' + JSON.stringify(TOOLS) + '\n</tools>\n\n' +
    'Return ONE complete tool call in XML tags. Example:\n' +
    'User: "wheelchair, Grand Central to Penn Station"\n' +
    'Assistant: <tool_call>{"name":"plan_route","arguments":{"from":"Grand Central","to":"Penn Station","profile":"wheelchair","night":false}}</tool_call>\n\n' +
    'Now answer with ONE <tool_call>...</tool_call> block and NOTHING ELSE.'
  );
}

const SUMMARY_SYSTEM =
  'Summarize the routing result for the user in 2-3 plain-English sentences. ' +
  'Do NOT emit any <tool_call> tags. ' +
  'Authoritative facts are inside <documents>...</documents>. ' +
  'Every number, station name, and profile label in your answer MUST appear verbatim in one of the documents. ' +
  'If a fact is not in the documents, omit it. ' +
  'If mode=walk_transit_walk, name both boarding and alighting station. ' +
  'If a transit_warning document is present, lead with it as a caveat. ' +
  'Do not convert units. Do not emit citation markers.';

const GROUNDING_PREFIX =
  'You are a helpful assistant with access to the following documents. ' +
  'You may use one or more documents to assist with the user query.\n\n' +
  'You are given a list of documents within <documents></documents> XML tags:\n<documents>';
const GROUNDING_SUFFIX =
  '\n</documents>\n\n' +
  "Write the response to the user's input by strictly aligning with the facts in the provided documents. " +
  'If the information needed is not available in the documents, inform the user.';

function renderGroundingSystem(docs: GroundingDoc[], userSystem?: string): string {
  const body = docs.map((d) => JSON.stringify(d)).join('\n');
  const block = `${GROUNDING_PREFIX}\n${body}${GROUNDING_SUFFIX}`;
  return userSystem ? `${block}\n\n${userSystem}` : block;
}

function routeDocs(route: {
  origin?: string; destination_name?: string; profile?: string; night?: boolean;
  mode?: string; total_minutes?: number; walking_km?: number; transit_minutes?: number;
  picked_stops?: { board: string; alight: string }; transit_warning?: string;
  accessibility_note?: string; sheds_on_route_streets?: string[];
}): GroundingDoc[] {
  const docs: GroundingDoc[] = [];
  let id = 1;
  const push = (title: string, text: string) => docs.push({ doc_id: id++, title, text });

  const lines: string[] = [];
  if (route.origin) lines.push(`Origin: ${route.origin}`);
  if (route.destination_name) lines.push(`Destination: ${route.destination_name}`);
  if (route.profile) lines.push(`Profile: ${route.profile}`);
  if (route.night !== undefined) lines.push(`Night: ${route.night ? 'yes' : 'no'}`);
  if (route.mode) lines.push(`Mode: ${route.mode}`);
  if (route.total_minutes !== undefined) lines.push(`Total minutes: ${route.total_minutes}`);
  if (route.walking_km !== undefined) lines.push(`Walking km: ${route.walking_km}`);
  if (route.transit_minutes) lines.push(`Transit minutes: ${route.transit_minutes}`);
  push('Route summary', lines.join('. ') + '.');

  if (route.picked_stops?.board && route.picked_stops?.alight)
    push('Transit stations', `Boarding station: ${route.picked_stops.board}. Alighting station: ${route.picked_stops.alight}.`);
  if (route.transit_warning) push('Transit warning', route.transit_warning);
  if (route.accessibility_note && route.accessibility_note !== 'straightforward path. No significant friction')
    push('Accessibility note', route.accessibility_note);
  if (route.sheds_on_route_streets?.length)
    push('Sidewalk sheds crossed', `Construction sheds on: ${route.sheds_on_route_streets.join(', ')}.`);
  return docs;
}

// ── Tool call parser (ported from v1 tools.ts) ──────────────────────────────

type ToolCall = { name?: string; arguments?: Record<string, unknown> };

function extractJSONAt(text: string, idx: number): [Record<string, unknown>, number] | null {
  let depth = 0, inStr = false, esc = false;
  for (let i = idx; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
    else { if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) { try { return [JSON.parse(text.slice(idx, i + 1)), i + 1]; } catch { return null; } } } }
  }
  if (depth > 0) {
    let repaired = text.slice(idx);
    if (inStr) repaired += '"';
    repaired = repaired.replace(/,(\s*)$/, '').replace(/:(\s*)$/, ':null').replace(/,\s*$/, '') + '}'.repeat(depth);
    try { return [JSON.parse(repaired), text.length]; } catch { return null; }
  }
  return null;
}

function parseToolCalls(text: string): ToolCall[] {
  const out: ToolCall[] = [];
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    try { out.push(JSON.parse(m[1]) as ToolCall); }
    catch { const bi = m[1].indexOf('{'); if (bi >= 0) { const r = extractJSONAt(m[1], bi); if (r) out.push(r[0] as ToolCall); } }
  }
  if (out.length) return out;
  const openIdx = text.indexOf('<tool_call>');
  if (openIdx >= 0) { const bi = text.indexOf('{', openIdx); if (bi >= 0) { const r = extractJSONAt(text, bi); if (r) out.push(r[0] as ToolCall); } }
  if (!out.length) {
    const ni = text.search(/"name"\s*:/);
    if (ni >= 0) { let bi = ni; while (bi > 0 && text[bi] !== '{') bi--; if (text[bi] === '{') { const r = extractJSONAt(text, bi); if (r) out.push(r[0] as ToolCall); } }
  }
  return out;
}

// ── Callbacks ────────────────────────────────────────────────────────────────

export type NarrationCallbacks = {
  addBot(text: string): (delta: string) => void;
  finishBot(text: string): void;
  addSteps(steps: RouteStep[]): void;
  addTool(name: string, args: unknown): (result: unknown) => void;
  addSys(text: string): void;
  drawRoute(result: ComfortRouteOk): void;
  drawReachable(result: ReachableRouteOk, meta: { budgetExplicit: boolean }): void;
  setReceipts?(r: {
    query: string; tool_call_name?: string; tool_call_args?: unknown;
    raw_model_output?: string; grounding_docs?: GroundingDoc[];
    narration?: string; timing_ms?: Record<string, number>;
  }): void;
};

// ── Main service ─────────────────────────────────────────────────────────────

export class NarrationService {
  constructor(
    private llm: LLMAdapter,
    private routerService: RouterService,
  ) {}

  async query(q: string, weather: WeatherContext | null, cb: NarrationCallbacks): Promise<void> {
    const t_start = performance.now();
    const sys = buildSystemPrompt(weather);
    let convo: ChatMessage[] = [{ role: 'system', content: sys }, { role: 'user', content: q }];

    let modelOut = '';
    let call: ToolCall | null = null;
    const t_llm_tool_start = performance.now();

    for (let attempt = 0; attempt < 3; attempt++) {
      modelOut = '';
      // Tool-call extraction: model emits exactly one <tool_call>...</tool_call>
      // block. Stop as soon as we see the closing tag. Saves 50-80% of decode
      // time vs. Running to max_tokens.
      for await (const delta of this.llm.completion(convo, {
        max_tokens: 256,
        temperature: attempt === 0 ? 0 : 0.3,
        stop: ['</tool_call>'],
      })) {
        modelOut += delta;
      }
      // The stop token doesn't get included in modelOut; re-append so the
      // XML parser can find it.
      if (modelOut.includes('<tool_call>') && !modelOut.includes('</tool_call>')) {
        modelOut += '</tool_call>';
      }
      const calls = parseToolCalls(modelOut);
      if (calls.length) {
        const c = calls[0];
        const name = c.name || 'plan_route';
        const args = (c.arguments || {}) as Record<string, unknown>;
        const ok =
          (name === 'plan_route' && args.from && args.to && args.profile) ||
          (name === 'find_comfort_and_route' && args.near && args.resource_types && args.profile) ||
          (name === 'find_reachable_resources' && args.near && args.resource_types && args.profile);
        if (ok) { call = c; break; }
      }
      convo = [
        ...convo,
        { role: 'assistant', content: modelOut },
        { role: 'user', content: `Your previous response was incomplete. Re-emit exactly ONE <tool_call> block with full "arguments". Original request: "${q}"` },
      ];
    }

    if (!call) { cb.addSys(modelOut || '(no tool call after retries)'); return; }

    const t_llm_tool_end = performance.now();
    const name = call.name || 'plan_route';
    const args = (call.arguments || {}) as Record<string, unknown>;
    const setToolResult = cb.addTool(name, args);
    const t_dispatch_start = performance.now();

    // ── find_reachable_resources ─────────────────────────────────────────────
    if (name === 'find_reachable_resources') {
      const reachResult = await this.routerService.findReachable(args as Parameters<RouterService['findReachable']>[0]);
      const t_dispatch_end = performance.now();

      if (!reachResult.ok) {
        setToolResult({ error: reachResult.error });
        cb.addSys(reachResult.error === NO_ORIGIN_ERROR ? NO_ORIGIN_NARRATION : `Sorry. ${reachResult.error}`);
        return;
      }

      const budgetExplicit = args.max_minutes !== undefined;
      setToolResult({ ok: true, origin: reachResult.origin_name, count: reachResult.pois.length, max_minutes: reachResult.max_minutes, budget_explicit: budgetExplicit });
      cb.drawReachable(reachResult, { budgetExplicit });

      const poiLines = reachResult.pois.slice(0, 12).map((p: ReachablePoi, i: number) =>
        `${i + 1}. ${p.name} (${p.resource_types.join(', ')}). ${p.walk_min} min walk`
      ).join('\n');
      const budgetLine = budgetExplicit
        ? `Origin: ${reachResult.origin_name}. Profile: ${reachResult.profile}. Time budget: ${reachResult.max_minutes} minutes (user-specified).`
        : `Origin: ${reachResult.origin_name}. Profile: ${reachResult.profile}.`;
      const groundedSystem = renderGroundingSystem([
        { doc_id: 1, title: 'Search parameters', text: budgetLine },
        { doc_id: 2, title: 'Reachable resources', text: reachResult.pois.length ? poiLines : 'No matching resources found nearby.' },
      ], SUMMARY_SYSTEM);
      const summaryConvo: ChatMessage[] = [
        { role: 'system', content: groundedSystem },
        { role: 'user', content: q + langDirective(q) },
        { role: 'tool', content: JSON.stringify({ count: reachResult.pois.length, max_minutes: reachResult.max_minutes, top: reachResult.pois.slice(0, 5) }) },
      ];
      const update = cb.addBot('');
      let acc = '';
      // Narration is 2-3 short sentences; cap at 120 tokens and stop on a
      // double newline so the model can't keep rambling past the answer.
      for await (const delta of this.llm.completion(summaryConvo, {
        max_tokens: 120,
        temperature: 0.2,
        stop: ['\n\n'],
      })) {
        acc += delta; update(acc);
      }
      cb.finishBot(acc || (reachResult.pois.length
        ? (budgetExplicit
            ? `Found ${reachResult.pois.length} place${reachResult.pois.length !== 1 ? 's' : ''} within ${reachResult.max_minutes} minutes of ${reachResult.origin_name}.`
            : `Found ${reachResult.pois.length} place${reachResult.pois.length !== 1 ? 's' : ''} near ${reachResult.origin_name}. Closest is ${reachResult.pois[0].name}, ${reachResult.pois[0].walk_min} min walk.`)
        : `No matching places near ${reachResult.origin_name}. Try a longer time budget or a different origin.`));
      cb.setReceipts?.({ query: q, tool_call_name: name, tool_call_args: args, raw_model_output: modelOut, narration: acc, timing_ms: { llm_tool_turn: Math.round(t_llm_tool_end - t_llm_tool_start), dispatch: Math.round(t_dispatch_end - t_dispatch_start), total: Math.round(performance.now() - t_start) } });
      return;
    }

    // ── plan_route / find_comfort_and_route ──────────────────────────────────
    let result: ComfortRouteOk | ToolError;
    if (name === 'find_comfort_and_route') {
      result = await this.routerService.findComfortAndRoute(args as Parameters<RouterService['findComfortAndRoute']>[0]);
    } else {
      result = await this.routerService.planRoute(args as Parameters<RouterService['planRoute']>[0]);
    }

    if (!result.ok) {
      setToolResult({ error: result.error });
      cb.addSys(result.error === NO_ORIGIN_ERROR ? NO_ORIGIN_NARRATION : `Sorry. ${result.error}`);
      cb.setReceipts?.({ query: q, tool_call_name: name, tool_call_args: args, raw_model_output: modelOut, timing_ms: { llm_tool_turn: Math.round(t_llm_tool_end - t_llm_tool_start), dispatch: Math.round(performance.now() - t_dispatch_start), total: Math.round(performance.now() - t_start) } });
      return;
    }
    const t_dispatch_end = performance.now();

    const totalMin = result.total_seconds ? Math.round(result.total_seconds / 60) : Math.round((result.length_m ?? 0) / 75);
    setToolResult({ ok: true, origin: result.origin_name, destination: result.destination_name, mode: result.mode ?? 'walk_only', total_minutes: totalMin, walking_km: ((result.walking_meters ?? result.length_m ?? 0) / 1000).toFixed(2), transit_minutes: result.transit_minutes ?? 0, picked_stops: result.picked_stops, transit_warning: result.transit_warning, profile: result.profile, night: result.night });

    cb.drawRoute(result);

    // Deterministic steps (before LLM narration)
    const legs = result.multimodal_legs ?? [];
    const walkLegs = legs.filter((l) => l.kind === 'walk' && (l as { edges?: unknown[] }).edges?.length);
    if (walkLegs.length === 2 && result.picked_stops) {
      const wl0 = walkLegs[0] as { edges: import('../domain/route').WasmEdge[] };
      const wl1 = walkLegs[1] as { edges: import('../domain/route').WasmEdge[] };
      cb.addSteps(buildMultimodalSteps(wl0.edges, wl1.edges, result.picked_stops.board, result.picked_stops.alight, result.origin_name, result.destination_name));
    } else if (walkLegs.length >= 1) {
      const wl0 = walkLegs[0] as { edges: import('../domain/route').WasmEdge[] };
      cb.addSteps(buildWalkSteps(wl0.edges, result.origin_name, result.destination_name));
    }

    const note = this.routerService.accessibilityNote(result);
    const summarized = {
      origin: result.origin_name, destination_name: result.destination_name,
      destination_source: result.destination_source, profile: result.profile, night: result.night,
      mode: result.mode ?? 'walk_only', total_minutes: totalMin,
      walking_km: Number(((result.walking_meters ?? result.length_m ?? 0) / 1000).toFixed(2)),
      transit_minutes: result.transit_minutes ?? 0, picked_stops: result.picked_stops,
      transit_warning: result.transit_warning, accessibility_note: note, sheds_on_route_streets: [],
    };
    const docs = routeDocs(summarized);
    const groundedSystem = renderGroundingSystem(docs, SUMMARY_SYSTEM);
    const summaryConvo: ChatMessage[] = [
      { role: 'system', content: groundedSystem },
      { role: 'user', content: q + langDirective(q) },
      { role: 'tool', content: JSON.stringify(summarized) },
    ];

    const update = cb.addBot('');
    let acc = '';
    const t_llm_sum_start = performance.now();
    for await (const delta of this.llm.completion(summaryConvo, {
      max_tokens: 120,
      temperature: 0.2,
      stop: ['\n\n'],
    })) {
      acc += delta; update(acc);
    }
    const t_llm_sum_end = performance.now();
    cb.finishBot(acc);
    cb.setReceipts?.({ query: q, tool_call_name: name, tool_call_args: args, raw_model_output: modelOut, grounding_docs: docs, narration: acc, timing_ms: { llm_tool_turn: Math.round(t_llm_tool_end - t_llm_tool_start), dispatch: Math.round(t_dispatch_end - t_dispatch_start), llm_summary_turn: Math.round(t_llm_sum_end - t_llm_sum_start), total: Math.round(performance.now() - t_start) } });
  }
}
