// Ambient type declarations for SvelteKit + app-wide globals.
// See https://svelte.dev/docs/kit/types#app
import type * as MaplibreGl from 'maplibre-gl';

declare global {
  namespace App {
    // interface Error {}
    // interface Locals {}
    // interface PageData {}
    // interface Platform {}
  }

  interface Window {
    /**
     * MapLibre GL module reference, stashed by RouteMap.svelte after dynamic
     * import so other code (markers, popups, LngLatBounds) can construct
     * MapLibre objects without re-importing the module.
     */
    __maplibre: typeof MaplibreGl;
  }
}

export {};
