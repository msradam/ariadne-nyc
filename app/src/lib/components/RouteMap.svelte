<script lang="ts">
  import { onMount } from 'svelte';
  import { routeState, isochroneMode } from '../stores/route';
  import type { ComfortRouteOk, ReachableRouteOk } from '../domain/route';
  import type { RouterProfileId } from '../domain/profile';
  import { PROFILE_COLORS } from '../domain/profile';
  import type { PedestrianRouterAdapter } from '../adapters/pedestrian-router';

  let {
    pedestrian = null as PedestrianRouterAdapter | null,
    profile = 'generic_pedestrian' as RouterProfileId,
  }: {
    pedestrian?: PedestrianRouterAdapter | null;
    profile?: RouterProfileId;
  } = $props();

  let mapEl: HTMLDivElement;
  let map: import('maplibre-gl').Map | null = null;
  let markers: import('maplibre-gl').Marker[] = [];
  let isoLegendVisible = $state(false);
  let isoLabels = $state<[string, string, string]>(['≤ 5 min', '≤ 10 min', '≤ 15 min']);
  let youAreHereMarker: import('maplibre-gl').Marker | null = $state(null);
  // Persistent pulsing dot for the user's geolocation. Survives clearLayers().
  let userLocationMarker: import('maplibre-gl').Marker | null = null;

  // Tile server: Z3 (infrastructure). Positron = clean warm-light style.
  const TILE_URL = 'https://tiles.openfreemap.org/styles/positron';

  function emptyFC(): GeoJSON.FeatureCollection {
    return { type: 'FeatureCollection', features: [] };
  }

  function addMarker(lng: number, lat: number, type: 'origin' | 'dest'): import('maplibre-gl').Marker {
    const div = document.createElement('div');
    div.style.cssText = `width:12px;height:12px;border-radius:50%;background:${type === 'origin' ? 'var(--ok)' : 'var(--error)'};border:2.5px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.5);`;
    // Marker is decorative; AT users get route info from the active record card.
    div.setAttribute('aria-hidden', 'true');
    return new (window as any).__maplibre.Marker({ element: div }).setLngLat([lng, lat]).addTo(map!);
  }

  function clearLayers() {
    for (const src of ['walk', 'transit', 'isochrone', 'reachable-pois']) {
      (map?.getSource(src) as any)?.setData(emptyFC());
    }
    (map?.getSource('radius-circle') as any)?.setData(emptyFC());
    for (const m of markers) m.remove();
    markers = [];
    youAreHereMarker?.remove();
    youAreHereMarker = null;
    isoLegendVisible = false;
  }

  function updateIsoBands(maxMinutes: number) {
    if (!map) return;
    const t1 = Math.round(maxMinutes / 3);
    const t2 = Math.round((maxMinutes * 2) / 3);
    map.setFilter('iso-near', ['<=', ['get', 'time_min'], t1]);
    map.setFilter('iso-mid',  ['all', ['>', ['get', 'time_min'], t1], ['<=', ['get', 'time_min'], t2]]);
    map.setFilter('iso-far',  ['all', ['>', ['get', 'time_min'], t2], ['<=', ['get', 'time_min'], maxMinutes]]);
    isoLabels = [`≤ ${t1} min`, `≤ ${t2} min`, `≤ ${maxMinutes} min`];
  }

  // ADA route color: deep purple. Hex form because MapLibre paint
  // properties (including data-driven `['get', 'color']`) don't accept oklch.
  const ROUTE_COLOR = '#3a2a9c';

  // Called by +page.svelte after route computation
  export function drawRoute(result: ComfortRouteOk) {
    if (!map) return;
    clearLayers();
    const color = ROUTE_COLOR;
    const legs = result.multimodal_legs ?? [{ kind: 'walk' as const, from: result.origin_name, to: result.destination_name, coords: result.coords, length_m: 0, cost: 0, edges: [] }];

    (map.getSource('walk') as any).setData({ type: 'FeatureCollection', features: legs.filter((l) => l.kind === 'walk').map((l) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: l.coords }, properties: { color } })) });
    (map.getSource('transit') as any).setData({ type: 'FeatureCollection', features: legs.filter((l) => l.kind === 'transit').map((l) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: l.coords }, properties: {} })) });

    if (result.coords.length > 1) {
      const first = result.coords[0], last = result.coords[result.coords.length - 1];
      markers.push(addMarker(first[0], first[1], 'origin'));
      markers.push(addMarker(last[0], last[1], 'dest'));
      const ml = window.__maplibre;
      const bounds = result.coords.reduce((b: any, c: any) => b.extend(c), new ml.LngLatBounds(result.coords[0], result.coords[0]));
      map.fitBounds(bounds, { padding: 60, maxZoom: 16 });
    }
    routeState.set({ kind: 'route', result });
  }

  export function drawReachable(result: ReachableRouteOk, opts: { budgetExplicit?: boolean } = {}) {
    if (!map) return;
    clearLayers();
    (map.getSource('isochrone') as any).setData(result.isochrone?.edges ?? emptyFC());
    updateIsoBands(result.max_minutes);
    isoLegendVisible = true;

    const poiFC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: result.pois.slice(0, 26).map((p, i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [p.lng, p.lat] }, properties: { name: p.name, walk_min: p.walk_min, address: p.address, letter: String.fromCharCode(65 + i), rank: i } })) };
    (map.getSource('reachable-pois') as any).setData(poiFC);

    if (result.isochrone?.reachableNodes[0]) {
      const n = result.isochrone.reachableNodes[0];
      markers.push(addMarker(n.lng, n.lat, 'origin'));
    }
    if (result.pois.length > 0) {
      const coords: [number, number][] = result.pois.map((p) => [p.lng, p.lat]);
      const ml = window.__maplibre;
      const bounds = coords.reduce((b: any, c: any) => b.extend(c), new ml.LngLatBounds(coords[0], coords[0]));
      map.fitBounds(bounds, { padding: 80, maxZoom: 15 });
    }
    routeState.set({ kind: 'reachable', result, budgetExplicit: !!opts.budgetExplicit });
  }

  export function clearMap() {
    clearLayers();
    routeState.set({ kind: 'none' });
    isochroneMode.set(false);
  }

  /**
   * Place / update a persistent pulsing-dot marker at the user's geolocation.
   * Idempotent: re-call to move the marker. Survives clearLayers().
   */
  export function showUserLocation(lat: number, lng: number) {
    if (!map) return;
    if (userLocationMarker) {
      userLocationMarker.setLngLat([lng, lat]);
      return;
    }
    const el = document.createElement('div');
    el.className = 'user-location-marker';
    el.setAttribute('aria-hidden', 'true');
    userLocationMarker = new (window as any).__maplibre.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
  }

  export function triggerIso(lat: number, lng: number) {
    if (!pedestrian) return;
    const result = pedestrian.shortestPathTree({ from: [lng, lat], profile, maxMinutes: 15 });
    if (!result) return;
    (map?.getSource('isochrone') as any)?.setData(result.edges);
    updateIsoBands(15);
    isoLegendVisible = true;
    markers.push(addMarker(lng, lat, 'origin'));
    // You-are-here marker
    youAreHereMarker?.remove();
    const yel = document.createElement('div');
    yel.setAttribute('aria-hidden', 'true');
    yel.style.cssText = 'width:22px;height:22px;border-radius:50%;background:oklch(0.32 0.18 295);border:4px solid var(--bg);box-shadow:0 0 0 2px oklch(0.32 0.18 295);';
    youAreHereMarker = new (window as any).__maplibre.Marker({ element: yel }).setLngLat([lng, lat]).addTo(map!);
    // Radius circle
    (map?.getSource('radius-circle') as any)?.setData(makeCirclePolygon(lat, lng, 1125));
  }

  function makeCirclePolygon(lat: number, lng: number, radiusM: number, steps = 64): GeoJSON.FeatureCollection {
    const coords: [number, number][] = [];
    for (let i = 0; i <= steps; i++) {
      const angle = (i / steps) * 2 * Math.PI;
      const dLat = (radiusM / 111320) * Math.cos(angle);
      const dLng = (radiusM / (111320 * Math.cos(lat * Math.PI / 180))) * Math.sin(angle);
      coords.push([lng + dLng, lat + dLat]);
    }
    return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [coords] }, properties: {} }] };
  }

  onMount(() => {
    let cleanup: (() => void) | undefined;
    (async () => {
      const ml = await import('maplibre-gl');
      await import('maplibre-gl/dist/maplibre-gl.css');
      window.__maplibre = ml;

    map = new ml.Map({
      container: mapEl,
      style: TILE_URL,
      center: [-73.985, 40.730],
      zoom: 12,
      hash: true,
    });

    await new Promise<void>((res) => map!.on('load', res));

    for (const src of ['walk', 'transit', 'isochrone', 'reachable-pois']) {
      map.addSource(src, { type: 'geojson', data: emptyFC() });
    }

    // Radius circle source + layers
    map.addSource('radius-circle', { type: 'geojson', data: emptyFC() });
    // MapLibre paint properties don't accept oklch(). Use a hex equivalent
    // of the --route token (deep purple).
    const ROUTE_HEX = '#3a2a9c';
    map.addLayer({
      id: 'radius-circle-fill',
      type: 'fill',
      source: 'radius-circle',
      paint: { 'fill-color': ROUTE_HEX, 'fill-opacity': 0.06 },
    });
    map.addLayer({
      id: 'radius-circle-line',
      type: 'line',
      source: 'radius-circle',
      paint: { 'line-color': ROUTE_HEX, 'line-width': 2, 'line-dasharray': [4, 3], 'line-opacity': 0.7 },
    });

    // Isochrone bands
    map.addLayer({ id: 'iso-far',  type: 'line', source: 'isochrone', filter: ['all', ['>', ['get', 'time_min'], 0], ['<=', ['get', 'time_min'], 15]], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#f85149', 'line-width': 3.5, 'line-opacity': 0.65 } });
    map.addLayer({ id: 'iso-mid',  type: 'line', source: 'isochrone', filter: ['all', ['>', ['get', 'time_min'], 0], ['<=', ['get', 'time_min'], 10]], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#d29922', 'line-width': 3.5, 'line-opacity': 0.75 } });
    map.addLayer({ id: 'iso-near', type: 'line', source: 'isochrone', filter: ['<=', ['get', 'time_min'], 5],  layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#3fb950', 'line-width': 3.5, 'line-opacity': 0.85 } });

    // POI dots. Top result (rank 0) is highlighted; others are dark with letter labels
    map.addLayer({
      id: 'poi-circle',
      type: 'circle',
      source: 'reachable-pois',
      paint: {
        'circle-radius': ['case', ['==', ['get', 'rank'], 0], 14, 12],
        'circle-color': ['case', ['==', ['get', 'rank'], 0], '#c9531c', '#1a1a1a'],
        'circle-stroke-width': 2.5,
        'circle-stroke-color': '#ffffff',
        'circle-opacity': 1,
      },
    });
    map.addLayer({
      id: 'poi-letter',
      type: 'symbol',
      source: 'reachable-pois',
      layout: {
        'text-field': ['get', 'letter'],
        'text-font': ['Noto Sans Bold', 'Open Sans Bold', 'Arial Unicode MS Bold'],
        'text-size': 12,
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        'text-color': '#ffffff',
      },
    });

    map.on('click', 'poi-circle', (e) => {
      if (!e.features?.length || !map) return;
      const f = e.features[0];
      const coords = (f.geometry as any).coordinates as [number, number];
      const { name, walk_min, address } = f.properties as any;
      new ml.Popup({ closeButton: true, maxWidth: '240px', focusAfterOpen: true })
        .setLngLat(coords)
        .setHTML(`<p style="font-weight:600;margin:0">${name}</p>${address ? `<p style="font-size:.75rem;color:#8b949e;margin:2px 0 0">${address}</p>` : ''}<p style="color:#3fb950;font-size:.75rem;margin:4px 0 0">${walk_min} min walk</p>`)
        .addTo(map);
    });
    map.on('mouseenter', 'poi-circle', () => { if (map) map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'poi-circle', () => { if (map) map.getCanvas().style.cursor = $isochroneMode ? 'crosshair' : 'default'; });

    // Walk + transit route lines
    map.addLayer({ id: 'walk-line',    type: 'line', source: 'walk',    layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 5, 'line-opacity': 0.9 } });
    map.addLayer({ id: 'transit-line', type: 'line', source: 'transit', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#e3b341', 'line-width': 5, 'line-opacity': 0.85, 'line-dasharray': [2, 1.5] } });

    map.on('click', (e) => {
      if ($isochroneMode) triggerIso(e.lngLat.lat, e.lngLat.lng);
    });

      cleanup = () => map?.remove();
    })();
    return () => cleanup?.();
  });

  function var_bg() { return '#0d1117'; }
</script>

<div class="map-wrap">
  <!--
    Map canvas: role="application" with accessible label.
    The canvas itself is NOT screen-reader traversable.
    All route information is exposed via the active record card.
  -->
  <div
    bind:this={mapEl}
    class="map-canvas"
    role="application"
    aria-label="Route map. Use the route summary below for accessible route details."
  ></div>

  <!-- Walk-radius legend. Visible only when isochrone is shown -->
  {#if isoLegendVisible}
    <div class="walk-legend" aria-hidden="true">
      <div class="walk-legend-title">WALK RADIUS</div>
      <div class="iso-row"><span class="iso-swatch" style="background:oklch(0.55 0.13 145)"></span><span class="iso-label">{isoLabels[0]}</span></div>
      <div class="iso-row"><span class="iso-swatch" style="background:oklch(0.65 0.14 65)"></span><span class="iso-label">{isoLabels[1]}</span></div>
      <div class="iso-row"><span class="iso-swatch" style="background:oklch(0.55 0.18 25)"></span><span class="iso-label">{isoLabels[2]}</span></div>
    </div>
  {/if}

  <!-- Map controls: real buttons, keyboard-operable, ≥ 44×44 px -->
  <div class="map-controls" aria-label="Map controls">
    <div class="ctrl-stack">
      <button
        class="ctrl-btn"
        aria-label="Zoom in"
        title="Zoom in"
        onclick={() => map?.zoomIn()}
      >+</button>
      <button
        class="ctrl-btn"
        aria-label="Zoom out"
        title="Zoom out"
        onclick={() => map?.zoomOut()}
      >−</button>
      <button
        class="ctrl-btn"
        aria-label="Center on New York City"
        title="Recenter"
        onclick={() => map?.flyTo({ center: [-73.985, 40.730], zoom: 12 })}
      >⌖</button>
    </div>
  </div>
</div>

<style>
  .map-wrap {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }

  .map-canvas {
    width: 100%;
    height: 100%;
  }

  /* Walk-radius legend. Anchored under SearchBar (which is at top:16px height ~76px) */
  .walk-legend {
    position: absolute;
    top: 110px;
    left: 16px;
    background: var(--surface);
    border: 2px solid var(--ink);
    padding: 10px 14px;
    min-width: 150px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    z-index: 10;
    pointer-events: none;
  }

  .walk-legend-title {
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 4px;
  }

  .iso-row { display: flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 600; }
  .iso-swatch { flex: 1; height: 6px; flex-shrink: 0; }

  /* Map controls */
  .map-controls {
    position: absolute;
    top: 20px;
    right: 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 10;
  }

  .ctrl-stack {
    background: var(--surface);
    border: 2px solid var(--ink);
    display: flex;
    flex-direction: column;
  }

  .ctrl-btn {
    width: 44px;
    height: 44px;
    background: transparent;
    border: none;
    border-top: 1px solid var(--border);
    color: var(--ink);
    font-size: 1.1rem;
    font-weight: 800;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.12s;
    font-family: var(--font-sans);
  }

  .ctrl-btn:first-child { border-top: none; }
  .ctrl-btn:hover { background: var(--bg-2); }

  /* Warm map filter */
  :global(.maplibregl-canvas) {
    filter: sepia(0.12) saturate(1.08) hue-rotate(-8deg);
  }

  /* User-location pulsing dot */
  :global(.user-location-marker) {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: oklch(0.62 0.20 250);
    border: 3px solid #fff;
    box-shadow: 0 0 0 0 oklch(0.62 0.20 250 / 0.5);
    animation: ariadne-pulse 2s ease-out infinite;
  }
  @keyframes ariadne-pulse {
    0%   { box-shadow: 0 0 0 0 oklch(0.62 0.20 250 / 0.6); }
    70%  { box-shadow: 0 0 0 14px oklch(0.62 0.20 250 / 0); }
    100% { box-shadow: 0 0 0 0 oklch(0.62 0.20 250 / 0); }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.user-location-marker) { animation: none; }
  }

  /* Hide attribution */
  :global(.maplibregl-ctrl-attrib-inner) { display: none !important; }
  :global(.maplibregl-ctrl-attrib-button) { display: none !important; }
  :global(.maplibregl-ctrl-bottom-right) { display: none !important; }

  /* MapLibre overrides. Light theme */
  :global(.maplibregl-ctrl-attrib) {
    background: rgba(255,255,255,0.8) !important;
    color: var(--muted) !important;
    font-family: var(--font-sans) !important;
    font-size: 10px !important;
  }
  :global(.maplibregl-ctrl-attrib a) { color: var(--muted) !important; }
  :global(.maplibregl-popup-content) {
    background: var(--surface) !important;
    color: var(--ink) !important;
    border: 2px solid var(--ink) !important;
    border-radius: 0 !important;
    padding: 10px 12px !important;
    box-shadow: none !important;
    font-family: var(--font-sans) !important;
  }
  :global(.maplibregl-popup-tip) { border-top-color: var(--surface) !important; }
  :global(.maplibregl-popup-close-button) {
    color: var(--muted) !important;
    font-size: 1.1rem !important;
    top: 4px !important;
    right: 6px !important;
  }
</style>
