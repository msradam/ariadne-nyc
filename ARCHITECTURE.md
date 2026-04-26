# Ariadne NYC Architecture Reference

> Working directory: `/Users/amsrahman/ariadne-nyc` (canonical repo).
> App directory: `app/`. Router crate: `router/`.

---

## What This Is

Ariadne is a browser-based accessibility routing assistant for all five NYC boroughs. Natural-language input → structured tool call → multimodal route or comfort-resource lookup → grounded LLM narration → map visualization.

**Privacy guarantee: nothing leaves the user's browser at runtime.** The LLM runs on the user's GPU via WebGPU. Geocoding, routing, and narration are local. There are no fetch() calls during a query. Verifiable in DevTools' Network tab. Build-time data fetches (Overpass, NYC Open Data, Socrata) populate static assets that ship with the app.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | SvelteKit 2 + Svelte 5 runes (`$state`, `$derived`, `$effect`, `$props`) |
| Styling | Tailwind CSS v4 via `@tailwindcss/vite` |
| Map | MapLibre GL (Positron tiles, OpenFreeMap) |
| LLM | Granite 4.0 1B via `@mlc-ai/web-llm` (WebGPU, runs in browser) |
| Pedestrian routing | Custom Rust → WASM (`unweaver-wasm`) via `UnweaverWasmAdapter` |
| Transit routing | Minotor RAPTOR (`minotor` npm package, pure JS) |
| Geocoding | **Fully offline** Fuse.js + structured street-keyed address index. No network fallback. |
| Build | Vite 6, `adapter-static` (full SPA, `fallback: 'index.html'`) |
| Deployment | HuggingFace Spaces (static SDK) |

---

## Repository Layout

```
ariadne-nyc/                                # Canonical repo. EVERYTHING lives here.
├── data/                                   # Built artifacts (gitignored, fetched/built by scripts)
│   ├── nyc-pedestrian.bin    (36 MB)       # Five-borough walk graph (OSWB v2 binary)
│   ├── nyc-pois.json         (2.6 MB)      # 23k named places for fuzzy geocoding
│   ├── nyc-comfort.json      (2.8 MB)      # ~6.7k comfort features (GeoJSON)
│   ├── nyc-addresses.json    (171 MB)      # Raw OSM addr:* points (~1.4M, build-only)
│   ├── nyc-streets.json      (39 MB)       # Structured street index (~19k street/borough entries)
│   ├── timetable.bin         (1.1 MB)      # Compiled GTFS timetable (Minotor format)
│   ├── stops.bin             (57 KB)       # Subway stops (Minotor format)
│   └── ada-stops.json        (3.8 KB)      # ADA-accessible GTFS stop_ids
├── models/                                 # Granite weights (gitignored, fetched by setup-model.sh)
│   └── granite-1b/                         # Cloned from huggingface.co/msradam/Granite-4.0-1b-q4f32_1-MLC
├── pipeline/
│   ├── stages/                             # Six-stage build for the walk graph
│   │   ├── acquire.py / clean.py / schema_map.py / validate.py / export.py
│   │   └── assemble.py                     # Produces nyc-osw.geojson + nyc-pedestrian.bin (via export_binary)
│   ├── sources/
│   │   ├── fetch_open_data.py              # NYC Open Data + OSM Overpass (POIs, comfort, addresses)
│   │   └── build_address_index.py          # Restructures nyc-addresses → nyc-streets
│   └── utils/export_binary.py              # OSW GeoJSON → nyc-pedestrian.bin (custom OSWB v2 format)
├── scripts/
│   └── setup-model.sh                      # One-shot Granite clone from HF
├── router/                                 # Rust → WASM pedestrian router
│   ├── Cargo.toml                          # Crate manifest
│   ├── src/                                # Dijkstra over petgraph + rstar
│   ├── pkg/                                # Prebuilt browser WASM bundle (committed so consumers don't need wasm-pack)
│   ├── examples/                           # Routing profile JSONs (manual_wheelchair, low_vision, ...)
│   └── tests/                              # Rust integration tests
├── app/                                    # SvelteKit + Svelte 5 frontend
│   ├── src/
│   │   ├── app.html                        # Loads coi-serviceworker.min.js first
│   │   ├── app.d.ts                        # Window.__maplibre type declaration
│   │   ├── routes/+page.svelte             # Single page; boot sequence here
│   │   ├── routes/+layout.svelte           # WayfindingStrip + SessionBar
│   │   └── lib/
│   │       ├── adapters/                   # I/O boundary
│   │       ├── services/                   # Orchestration
│   │       ├── components/                 # Svelte UI
│   │       ├── domain/                     # Pure types
│   │       └── stores/                     # Svelte stores
│   ├── static/output/                      # Symlinks to <repo>/data/* for dev serving
│   ├── scripts/
│   │   ├── route-cli.ts                    # Node CLI harness (bypasses LLM)
│   │   └── debug-browser.ts                # One-off Playwright debug capture
│   ├── tests/
│   │   ├── e2e/                            # Playwright end-to-end (1:1 with prod)
│   │   ├── a11y/                           # Playwright + axe a11y suite
│   │   └── unit/                           # Vitest
│   ├── playwright.config.ts                # WebGPU-enabled (headed by default)
│   ├── knip.json                           # Dead-code config
│   ├── vite.config.ts                      # granitePlugin → <repo>/models/granite-1b
│   ├── DEPLOY.md                           # HF Space deploy runbook
│   └── build/                              # Production output (gitignored)
├── config/sources.yaml                     # Pipeline source definitions
├── output/                                 # Pipeline working dir (gitignored)
└── ARCHITECTURE.md                         # This file
```

`granite-web/` (formerly used as a prototyping working dir at `/Users/amsrahman/granite-web/`) is **not** part of the canonical repo. Code or assets there are scratch. Never reference them.

---

## Adapter Layer (`src/lib/adapters/`)

All external I/O lives here. Services never call `fetch()` directly.

### `llm.ts` `WebLLMGraniteAdapter` (CANONICAL LLM)

**Do not replace with any remote API.** Privacy guarantee requires local inference.

```typescript
// Dev: Vite granitePlugin serves shards from <repo>/models/granite-1b at /granite-1b/
// Prod: fetches from HF model repo, cached in IndexedDB after first visit
const HF_MODEL_BASE = 'https://huggingface.co/msradam/Granite-4.0-1b-q4f32_1-MLC/resolve/main/';
const modelUrl = import.meta.env.PROD ? HF_MODEL_BASE : `${origin}/granite-1b/`;
```

Model: Granite 4.0 1B, `q4f32_1` quantization, ~900MB. Cached in browser IndexedDB after first download. Subsequent visits load from cache, fully offline.

Local-dev model files: `<repo>/models/granite-1b/` (populated by `scripts/setup-model.sh`).

### `geocoder.ts` `FuseGeocoderAdapter` (FULLY OFFLINE)

No network calls. Three resolution stages over the local POI index, plus a fourth stage gated on the structured street index:

1. **Exact** normalized name match (case-insensitive, abbrev expansion: `St→street`, `Tpke→turnpike`, etc.; Queens block-house format: `85 26 → 85-26`).
2. **Token-aware contains** match. Deterministic ranking: category priority (borough > transit > neighborhood > park > amenity > building) → name length → original index.
3. **Fuse fuzzy** (typo recovery only, threshold 0.45, `minMatchCharLength: 3`). Catches `kwe gardns → Kew Gardens` but rejects gibberish.
4. **Structured street lookup** (only when query starts with a digit AND `nyc-streets.json` is loaded): parse `<housenum> <street>[, <borough>]`, exact-match street key, binary-search nearest housenum on that street. Manhattan-first tiebreaker when no borough specified.

Address-form queries jump to stage 4 *before* POI stages so `1 Wall Street` doesn't get clobbered by `111 Wall Street` partial-token matches.

The previously-used NYC Geosearch API (`geosearch.planninglabs.nyc/v2/search`) was **removed**. It violated the privacy guarantee.

### `pedestrian-router.ts` `UnweaverWasmAdapter`

Wraps the Rust→WASM routing engine. Loads `output/nyc-pedestrian.bin` (36 MB OSWB v2 binary). Profiles: `manual_wheelchair`, `generic_pedestrian`, `low_vision`. Profile JSONs live in `router/examples/profile-*.json`.

### `transit-router.ts` `MinotorAdapter`

RAPTOR algorithm via the `minotor` npm package (pure JS, ~1.5 MB compiled). Loads:
- `output/timetable.bin`. Compiled GTFS timetable
- `output/stops.bin`. Stop coordinates
- `output/ada-stops.json`. ADA-accessible stop IDs

Real-time elevator outage overlay from `MTAOutagesAdapter` (MTA SIRI feed); subtracts impacted stations from the ADA set at boot.

### `geolocation.ts` `BrowserGeolocationAdapter` (FEATURE-GATED OFF)

Wraps `navigator.geolocation`. Currently **disabled** by `GEOLOCATION_ENABLED = false` at the top of the file. Why: on devices without GPS hardware, the browser's geolocation API silently calls the OS positioning service (Google/Apple), which sends nearby Wi-Fi MAC addresses out of the device. That breaks "nothing leaves the browser." Code is wired end-to-end so flipping the flag re-enables the `@me` sentinel path; first consider gating on a high-accuracy fix only.

### `feed-weather.ts` `WeatherAdapter`

National Weather Service feed. Loaded at boot but currently **not surfaced in the UI** (the heat advisory pill was removed). Kept for future re-introduction.

### `feed-mta-outages.ts` `MTAOutagesAdapter`

MTA SIRI elevator outage feed. Used at boot to filter out ADA-accessible stations whose elevators are impaired today.

### `tts.ts` `LocalSpeechSynthesisAdapter`

Browser `speechSynthesis` API. Routes narration text to the OS voice. Disabled by default (gated on `ttsEnabled` store).

---

## Service Layer (`src/lib/services/`)

### `narration-service.ts` `NarrationService`

Two-turn LLM pattern:

**Turn 1. Tool extraction.** System prompt with three tool schemas; model emits `<tool_call>{"name":...,"arguments":{...}}</tool_call>`. XML parser extracts the call. Up to 3 retry attempts with corrective prompts.

**Turn 2. Grounded summary.** Tool result serialized as `<documents>` grounding context; model narrates in 2-3 sentences, streamed to UI. All numbers/names in the response must appear verbatim in the grounding docs (hallucination guard).

Tools and their semantics:
- `plan_route(from, to, profile, night?)`. Both endpoints named.
- `find_comfort_and_route(near, resource_types, profile, night?)`. Closest match + route.
- `find_reachable_resources(near, resource_types, profile, max_minutes?)`. ONLY when user states a time budget. `max_minutes` is included only if the user said a number; otherwise omitted (router defaults to 45).

Profile enum includes `generic_pedestrian` so the model has a true default; system prompt explicitly mandates it when no mobility/vision/accessibility cue is present.

`@me` sentinel: if the user does not name an origin, the system prompt tells the model to set `near` (or `from`) to literal `@me`. The router intercepts this and (with geolocation disabled) returns `NO_ORIGIN_ERROR`, which narration translates to "I need a starting point. Please name one. E.g., a station, a neighborhood, or a street address."

### `router-service.ts` `RouterService`

Orchestrates geocoder + pedestrian + transit + geolocation. Key behaviors:

- **`resolveOrigin(near)`** routes `@me` / `here` / `my location` / empty to geolocation; otherwise to geocoder.
- **Walk-fail → multimodal fallback.** If walk-only routing throws (e.g., inter-borough wheelchair where the walk graph has no path), multimodal RAPTOR is still attempted with `Infinity` as the time-to-beat. Returns the multimodal result if any leg succeeds; otherwise the no-path error.
- **ADA filtering** for `manual_wheelchair` profile: subway candidates must be in `adaInternalIds` (post-elevator-outage subtraction).
- **Multimodal stitching:** walks origin → board, RAPTOR board → alight, walks alight → destination. Per-stop, picks the best-total candidate.

### `privacy-log.ts`

Tracks every external resource fetch. Three zones: `z1` (user data), `z2` (location), `z3` (model weights / infrastructure). The component that displayed it has been removed; the underlying log is still maintained and accessible programmatically for debugging.

### `safety.ts`

Validates comfort-resource picks for safety-critical categories (medical, harm reduction, mental health). E.g., flags a "harm reduction site" pick that doesn't actually have the right tag.

---

## Stores (`src/lib/stores/`)

| Store | Backing | Used by |
|---|---|---|
| `query-log` | `writable` | QueryLog, ActiveRecord, SearchBar |
| `route` | `writable` | RouteMap, route bottom strip, FeedStatus |
| `feeds` | `writable` (multiple) | FeedStatus (transit), boot phase |
| `network` | `readable` (auto-subscribes to `online`/`offline` window events) | SessionBar (Network/Offline pill) |
| `settings` | `writable` | TTS toggle, language |
| `conversation` | `writable` | (unused in active UI; legacy) |

`network.ts` deliberately does **not** actively probe. Issuing our own connectivity check would contradict the privacy posture. We rely on `navigator.onLine`. `false` is reliable; `true` means *some* interface is up (not necessarily internet).

---

## Boot Sequence (`+page.svelte` `onMount`)

```
Step 1: Load WASM module + pedestrian graph (data/nyc-pedestrian.bin, 36MB)
Step 2: Load POI index + comfort features in parallel
        └── Background: lazy-load nyc-streets.json (~40 MB) for address geocoding
Step 3: Construct RouterService(geocoder, pedestrian, transit, comfortFeatures, geolocation)
Step 4: Load transit data + weather, parallel
        └── Apply MTA elevator outage overlay
Step 5: Probe WebGPU → load Granite model
        └── On WebGPU failure: boot anyway, LLM unavailable, routing still works
Step 6: Construct NarrationService → set querySubmitFn → mark booted
```

---

## UI Layout

```
┌─────────────────────────────────────────────────────────────┐
│ SessionBar (48px, fixed top): time · date · NYC · ● Network · ● Local · N records │
├──────────────────────┬──────────────────────────────────────┤
│ Left col (460px)     │ Map col (flex:1)                     │
│                      │ ┌──────────────────────────────────┐ │
│ FeedStatus           │ │ RouteMap (MapLibre, Positron)    │ │
│ (transit feed)       │ │                                  │ │
│ QueryLog             │ │  SearchBar (floating top-left)   │ │
│ ActiveRecord         │ │  Walk-radius legend (when iso)   │ │
│   ├─ CLOSEST MATCH   │ │  SURVEYED · N SITES (top-right)  │ │
│   ├─ stat grid       │ │  +/-/⌖ controls (top-right)      │ │
│   ├─ type pills      │ │  Legend (bottom-right). Hidden  │ │
│   ├─ ALSO NEARBY     │ │    when route strip is showing   │ │
│   ├─ tool-pill       │ │  Route strip (bottom, when route)│ │
│   └─ steps           │ │  ISOCHRONE button (when no route)│ │
│ ExampleQueries       │ └──────────────────────────────────┘ │
└──────────────────────┴──────────────────────────────────────┘
WayfindingStrip (56px vertical sidebar, brand mark, leftmost column)
```

`SearchBar` floats over the map at `top:16px; left:16px; z-index:20`. Holds only the text input, ⌘K hint, submit arrow, and a suggestion dropdown. **profile chips were removed** (they were decoration; routing profile is inferred from the LLM tool call).

`route-strip` is the black bottom-of-map overlay shown when `routeState.kind === 'route'`: total min/distance, START/END names, profile/mode/runtime. It supersedes the deleted `FooterRail`.

---

## Data Files

Static files served from `app/static/output/` (symlinks to `<repo>/data/*` in dev; copied into `build/` at deploy time):

| File | Size | Source | Notes |
|---|---|---|---|
| `nyc-pedestrian.bin` | 36 MB | `pipeline/utils/export_binary.py` | OSWB v2 binary |
| `nyc-pois.json` | 2.6 MB | `pipeline/sources/fetch_open_data.py --section pois` | OSM Overpass |
| `nyc-comfort.json` | 2.8 MB | `pipeline/sources/fetch_open_data.py --section comfort` | NYC Open Data + NYPL/BPL/QPL |
| `nyc-streets.json` | 39 MB | `pipeline/sources/build_address_index.py` | Restructured from nyc-addresses |
| `timetable.bin` | 1.1 MB | Minotor build (transit-build) | LFS in HF Space |
| `stops.bin` | 57 KB | Minotor build | LFS in HF Space |
| `ada-stops.json` | 3.8 KB | NYC Open Data | LFS in HF Space |
| `nyc-addresses.json` | 171 MB | `pipeline/sources/fetch_open_data.py --section addresses` | Build-only intermediate; not deployed |

Reproducible build:
```bash
./scripts/setup-model.sh                                       # ~900 MB Granite clone
uv run python pipeline/sources/fetch_open_data.py --section all   # comfort + POIs + addresses
uv run python pipeline/sources/build_address_index.py             # → nyc-streets.json
```

---

## HuggingFace Deployment

**Space:** `https://huggingface.co/spaces/msradam/ariadne-nyc`
**Direct URL:** `https://msradam-ariadne-nyc.static.hf.space`
**Model repo:** `https://huggingface.co/msradam/Granite-4.0-1b-q4f32_1-MLC`
**Deploy clone:** `/tmp/ariadne-hf-deploy` (transient. Re-clone before each deploy)

### COEP/COOP headers (required for WebGPU/SharedArrayBuffer)

Applied via two mechanisms (both required):

1. **`custom_headers` in Space README**. HF applies these server-side to every response, including the iframe on `huggingface.co/spaces/...`. Makes `crossOriginIsolated = true`.
2. **`coi-serviceworker.min.js`**. Belt-and-suspenders for direct URL access; re-serves responses with COEP/COOP headers client-side.

**Known HF bug:** `custom_headers` on `sdk: static` causes a `CONFIG_ERROR` banner on the wrapper page. Cosmetic. Do not remove `custom_headers` to fix it. The WebGPU failure that follows is not cosmetic.

### Deploy runbook (full detail in `app/DEPLOY.md`)

```bash
cd app
npm run build

rsync -a --delete \
  --exclude '.git' --exclude '.gitattributes' --exclude 'README.md' \
  --exclude 'output/timetable.bin' --exclude 'output/stops.bin' --exclude 'output/ada-stops.json' \
  build/ /tmp/ariadne-hf-deploy/

cd /tmp/ariadne-hf-deploy
git checkout HEAD -- .gitattributes output/timetable.bin output/stops.bin output/ada-stops.json
git add -A && git commit -m "..." && git push origin main
```

`nyc-streets.json` (~39 MB) is shipped via the same flow; no LFS gymnastics needed for that one.

---

## Test Infrastructure

### Node CLI harness. `scripts/route-cli.ts`

Bypasses the LLM. Calls `RouterService.{planRoute, findComfortAndRoute, findReachable}` directly with structured args. Fast (~100 ms/query, no model load). Useful for routing-logic regressions.

```bash
npm run route -- plan "<from>" "<to>" [profile]
npm run route -- find "<near>" "<resource_type>" [profile]
npm run route -- reach "<near>" "<resource_type>" [max_minutes]
npm run route -- diagnose "<from>" "<to>" [profile]
npm run route -- geocode "<query>"
```

`diagnose` walks the multimodal logic step-by-step (walk-only attempt → nearest stops → ADA filter → RAPTOR loop → walk-in/walk-out feasibility). Invaluable for debugging "no path" failures.

### Playwright e2e. `tests/e2e/queries-30.spec.ts` and friends

True 1:1 with prod: real Chromium, real WebGPU, real Granite inference, real WASM routing, real DOM assertions. Headed by default (Apple Silicon GPU isn't reliably accessible from headless Chromium). Set `ARIADNE_HEADLESS=1` to force headless (uses SwiftShader; ~100× slower for inference).

```bash
npm run test:e2e
```

The 30-query battery runs all cases in a single `test()` and prints a pass/fail table at the end. IndexedDB usage is logged after each query so quota pressure is visible.

### Quality gate. `npm run quality`

```bash
npm run quality   # = npm run check && npm run knip && npm run lint:rust
```

- `svelte-check`. TypeScript + Svelte + a11y
- `knip`. Dead files, unused exports, undeclared deps
- `cargo clippy --all-targets -- -D warnings`. Rust lint (warnings are errors)
- `cargo machete`. Unused Cargo deps

Current state: **0 errors, 0 warnings, 0 dead files** on the JS/Svelte side. Two cosmetic clippy warnings in tests (`count`-as-counter, complex tuple type).

---

## Svelte 5 Patterns in Use

- `$state` for mutable reactive values
- `$derived` (and `$derived.by` for complex expressions) for computed values
- `$effect` for side effects with cleanup
- `$props()` for component props (not `export let`)
- Stores (`writable`, `readable`, `derived`) for cross-component shared state
- `bind:this` for component refs (`routeMap`)

All components use Svelte 5 runes. Do not mix with Svelte 4 `export let` / `$:` patterns.

---

## Local Development

```bash
# One-time setup
./scripts/setup-model.sh                                          # Granite ~900MB

# Pipeline (one-time or whenever sources update)
uv run python pipeline/sources/fetch_open_data.py --section all
uv run python pipeline/sources/build_address_index.py

# App
cd app
npm install
npm run dev       # http://localhost:5173
```

Requires Chrome or Edge (WebGPU). The `vite.config.ts` `granitePlugin` intercepts `/granite-1b/*` and serves shards from `<repo>/models/granite-1b/`, stripping the HF-style `resolve/main/` prefix that WebLLM appends. COEP/COOP headers set in dev via `vite.config.ts` `server.headers`.

---

## Known Issues / Open Work

- **Empty-narration edge case**. When the LLM emits stray code-fence markers (e.g., `\`\`\``) for the summary turn, the active record renders just those characters. Need a regex strip + deterministic fallback when `acc` is empty/garbage.
- **Playwright IndexedDB quota**. The default Playwright context's IndexedDB quota (~1 GB) is barely enough for the cached Granite model (~920 MB). Running long batteries that re-cache risks `QuotaExceededError`. Real browsers have 10× the quota; only the test harness is at risk.
- **Geolocation feature-gated off**. `GEOLOCATION_ENABLED = false` in `geolocation.ts`. To enable: gate on a high-accuracy GPS fix (`accuracy_m < 100`) so Wi-Fi positioning paths don't get used. The `@me` sentinel pipeline is wired and ready.
- **`custom_headers` CONFIG_ERROR banner** on the HF Space wrapper page is cosmetic (HF display bug). Do not remove `custom_headers`. The WebGPU failure that follows is not cosmetic.
- **Two cosmetic clippy warnings** in Rust test files. Not blocking; run `cargo clippy --fix` to auto-apply.

---

## Files That Were Deleted (For New Sessions)

So you don't go looking for them:

- `src/lib/components/ChatLog.svelte` / `ChatInput.svelte` / `SuggestionChips.svelte` / `QueryRail.svelte` / `RouteSummary.svelte` / `FooterRail.svelte` / `PrivacyLog.svelte`. All unused legacy. The active surface is `ActiveRecord` + `SearchBar` + `RouteMap` + the route-strip overlay in `+page.svelte`.
- `src/lib/adapters/llm-hf.ts` (privacy violator) and `src/lib/adapters/stt.ts` (unused).
- The compass + scale-bar overlay, the plate caption, and the weather pill were removed from the UI as decorative chrome that didn't surface real data.
