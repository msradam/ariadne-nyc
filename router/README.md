# unweaver-wasm

*This is an experimental WebAssembly port of the routing pattern from [Unweaver](https://github.com/nbolten/unweaver), the reference routing engine for OpenSidewalks data, by Nick Bolten at the University of Washington Taskar Center for Accessible Technology. The architectural pattern. Profile-driven cost functions, runtime parameterisation, OSW-aware graph traversal. Is theirs. This port reimplements the pattern in Rust→WASM, with the cost-function-as-Python-file mechanism replaced by a JSON rule-tree format suitable for runtimes where arbitrary code execution isn't viable. The intent is to make OSW routing available wherever WebAssembly runs.*

Apache-2.0 licence, matching Unweaver's.

---

## Why

Unweaver requires Python, SQLite, SpatiaLite, GDAL, proj4, and a Flask server.
None of those run in a browser tab, a Cloudflare Worker, or a mobile app without
bundling a full Python runtime.

This module exposes the same routing semantics as a WASM binary + JS bindings:

- **Browser apps** can do OSW routing without a backend
- **Edge functions** (Cloudflare Workers, Deno Deploy) serve routes with minimal cold-start
- **Privacy-sensitive apps** keep origin/destination/profile on-device
- **Mobile apps** embed routing without a Python runtime

The module is ~117 KB gzipped. It loads in <1ms and answers city-scale queries
in well under 200ms.

---

## Quick start

### Node.js

```bash
# build the nodejs-target package
cd experiments/unweaver-wasm
wasm-pack build --target nodejs --release --out-dir pkg-node
node examples/node-demo/demo.cjs
```

### Browser

```bash
wasm-pack build --target web --release
npx serve .   # from experiments/unweaver-wasm/
# open http://localhost:3000/examples/browser-demo/index.html
```

---

## API

```typescript
import init, { Router } from './pkg/unweaver_wasm.js';

await init();

// Load an OSW GeoJSON FeatureCollection
const router = Router.fromOSWGeoJSON(geojsonString);

// Register profiles
router.addProfile('manual_wheelchair', wheelchairProfileJSON);
router.addProfile('generic_pedestrian', pedestrianProfileJSON);

// Shortest path. Returns Unweaver-compatible JSON string
const json = router.shortestPathJSON(
  'manual_wheelchair',
  originLat, originLon,
  destLat, destLon,
  null              // optional runtime args JSON, e.g. '{"uphill_max": 0.05}'
);

// Reachability tree within a cost budget
const treeJson = router.shortestPathTreeJSON(
  'manual_wheelchair',
  originLat, originLon,
  600,              // max cost (metres for length-based profiles)
  null
);
```

### Response shape

`shortestPathJSON` returns the same JSON shape as Unweaver's
`GET /shortest_path/<profile>.json`:

```json
{
  "status": "Ok",
  "origin":      { "type": "Feature", "geometry": {"type": "Point", ...}, "properties": {} },
  "destination": { "type": "Feature", "geometry": {"type": "Point", ...}, "properties": {} },
  "total_cost": 335.0,
  "edges": [
    { "_u": "node_A", "_v": "node_B", "footway": "sidewalk", "incline": 0.02, "length": 84.0,
      "geom": {"type": "LineString", ...} },
    ...
  ]
}
```

Error responses: `{"status": "Error", "code": "NoPath"}`,
`{"status": "Error", "code": "InvalidWaypoint"}`.

`shortestPathTreeJSON` matches Unweaver's `/shortest_path_tree/<profile>.json`
shape with `paths`, `edges` (FeatureCollection), and `node_costs` (FeatureCollection).

---

## Profile format

Profiles are JSON files declaring runtime arguments and a cost rule-tree.
See `examples/profile-manual_wheelchair.json` for a fully annotated example.

```json
{
  "id": "manual_wheelchair",
  "args": [
    { "name": "uphill_max",  "type": "float", "default": 0.0833 },
    { "name": "downhill_max","type": "float", "default": -0.1   },
    { "name": "avoid_curbs", "type": "bool",  "default": true   }
  ],
  "cost": {
    "impassable_if": [
      { "attr": "incline", "op": "gt", "param": "uphill_max"  },
      { "attr": "incline", "op": "lt", "param": "downhill_max"},
      { "all": [
        { "param": "avoid_curbs", "op": "eq", "value": true        },
        { "attr": "footway",      "op": "eq", "value": "crossing"  },
        { "attr": "curbramps",    "op": "eq", "value": false        }
      ]}
    ],
    "base": "length",
    "multipliers": []
  }
}
```

**Condition operators:** `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`  
**Compound forms:** `all` (AND), `any` (OR)  
**Comparand:** `value` (literal) or `param` (resolved runtime arg)

This encodes Unweaver's wheelchair cost function exactly. See `DECISIONS.md §D1`
for the full rationale for rule-trees over alternative approaches.

---

## Building

```bash
# prerequisites
rustup target add wasm32-unknown-unknown
cargo install wasm-pack

# browser (ESM)
wasm-pack build --target web --release

# Node.js (CJS)
wasm-pack build --target nodejs --release --out-dir pkg-node

# tests
cargo test
```

---

## Project layout

```
src/
  lib.rs      . WASM entry points, module wiring
  graph.rs    . OSW GeoJSON → petgraph StableDiGraph
  profile.rs  . Profile JSON parsing and arg resolution
  cost.rs     . Rule-tree evaluation (eval_cost)
  routing.rs  . Dijkstra with profile-driven weights
  api.rs      . #[wasm_bindgen] Router struct and JSON serialisation
examples/
  profile-manual_wheelchair.json
  profile-low_vision.json
  profile-generic_pedestrian.json
  browser-demo/index.html
  node-demo/demo.cjs
tests/
  fixtures/small_osw.geojson  . 4-node test graph
  routing.rs                  . End-to-end routing tests
```

---

## For the OSW community

If you know Unweaver, here's what's the same and what's different:

| Aspect | Unweaver | unweaver-wasm |
|--------|----------|---------------|
| Graph format | GeoPackage (SQLite) | OSW GeoJSON in memory |
| Cost functions | Python files, loaded at runtime | JSON rule-trees |
| Routing algorithm | NetworkX `multi_source_dijkstra` | Petgraph-based Dijkstra |
| Runtime | Python + Flask server | WASM module |
| Waypoint projection | Projects onto nearest edge | Snaps to nearest node (V1) |
| Response JSON | HTTP API | Same shape, returned as string |

The three reference profiles in `examples/` encode Unweaver's wheelchair and
distance profiles using the rule-tree DSL with no loss of expressiveness.

---

## For WASM developers

The module exports a single `Router` class via `wasm-bindgen`. All arguments
and return values are primitive JS types or strings (JSON). No `SharedArrayBuffer`,
no Web Workers, no Atomics. The module is single-threaded and runs in any
WASM-capable environment including Cloudflare Workers.

The WASM binary is built with `opt-level = "s"` (size). `wasm-opt` runs
automatically during `wasm-pack build`. Gzipped size is ~117 KB.
