# Architectural Decisions

## D1. Cost function portability: Option B (JSON rule-trees)

**Context.** Unweaver's defining feature is that cost functions are arbitrary Python
files loaded at server start. The user expresses any logic ("if incline > threshold
and user's max_incline param is below threshold, return None") in unrestricted Python.
WASM can't execute arbitrary Python. Four options were considered:

| Option | Mechanism | Flexibility | Binary size impact | Rebuild needed? |
|--------|-----------|-------------|--------------------|-----------------|
| A | Compiled-in Rust functions | Low | None | Yes, per new profile |
| **B** | **JSON rule-trees (chosen)** | **Medium** | **None** | **No** |
| C | JavaScript callbacks across FFI | High | None | No (but slow) |
| D | Embedded scripting (Lua / Rhai) | High | +100-300 KB | No |

**Choice: B as primary, A as fallback.**

Reasons:
- Unweaver's three reference profiles (wheelchair, low_vision, generic_pedestrian)
  fit the rule-tree DSL completely. No escape hatch was needed.
- Rule-trees are serialisable, diffable, and human-readable. The profile JSON
  is self-documenting.
- No FFI boundary crossings per edge (vs. Option C), so routing stays fast.
- No binary size penalty (vs. Option D).
- For profiles that genuinely need Turing-complete logic, a new Rust cost function
  can be compiled in (Option A) and registered by name in the profile JSON.
  This is explicitly out of scope for V1.

**DSL shape:**

```json
{
  "id": "my_profile",
  "args": [
    {"name": "uphill_max", "type": "float", "default": 0.0833}
  ],
  "cost": {
    "impassable_if": [
      {"attr": "incline", "op": "gt", "param": "uphill_max"},
      {"all": [
        {"attr": "footway", "op": "eq", "value": "crossing"},
        {"attr": "curbramps", "op": "eq", "value": false}
      ]}
    ],
    "base": "length",
    "multipliers": [
      {"if": {"attr": "surface", "op": "in", "value": ["cobblestone"]}, "multiply": 1.5}
    ]
  }
}
```

Condition operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`.
Compound forms: `all` (AND), `any` (OR). Comparand is either `value` (literal) or
`param` (resolved runtime arg).

---

## D2. Graph data structure: petgraph StableDiGraph

**Context.** Unweaver uses NetworkX's DiGraph backed by a GeoPackage (SQLite/SpatiaLite).

**Choice.** `petgraph::stable_graph::StableDiGraph<OswNode, OswEdge>`.

Reasons:
- petgraph is the de-facto NetworkX equivalent in Rust with mature WASM support.
- `StableDiGraph` preserves node/edge indices across removals (safe for future
  waypoint-overlay logic where temporary nodes are inserted and removed).
- Full graph lives in memory. Acceptable for city-scale OSW (~500k edges ≈ ~100 MB).
- No SQLite dependency in WASM (SpatiaLite is not WASM-portable).

---

## D3. Nearest-node lookup: brute-force scan

**Context.** When a caller supplies a lat/lon query point, we need to find the
nearest graph node to use as the routing origin/destination.

**Choice.** Linear scan over all nodes for V1.

Reasons:
- Correct and simple to implement.
- For a demo on a small fixture (4 nodes), this is instantaneous.
- On a city-scale graph (~1M nodes), a single scan takes ~5ms. Acceptable for
  interactive routing where route computation itself dominates.

**V1.1 upgrade path.** Replace with an `rstar` R-tree (already a dependency of
the `geo` crate family). The `OswGraph` structure is designed so `nearest_node()`
can be swapped without touching routing logic.

---

## D4. Directed graph and OSW incline sign convention

OSW incline is signed: positive = net uphill u→v, negative = net downhill u→v.
The graph is directed so that edge u→v and reverse edge v→u have opposite incline
values. Unweaver also uses a directed graph for the same reason.

This means shortest_path is asymmetric: A→C and C→A may traverse different edges
under the wheelchair profile (uphill limit and downhill limit differ).

---

## D5. Response shape matches Unweaver's HTTP API

The JSON returned by `shortestPathJSON` and `shortestPathTreeJSON` matches
Unweaver's HTTP response shapes (`/shortest_path/<profile>.json` and
`/shortest_path_tree/<profile>.json`) field-for-field. This allows clients
written against the Unweaver API to be pointed at this engine without code changes.

Key field names preserved: `status`, `origin`, `destination`, `total_cost`,
`edges`, `paths`, `node_costs`. Edge endpoint fields use `_u` / `_v` (Unweaver's
convention, not `_u_id` / `_v_id` used in the OSW feature properties).

---

## Benchmark numbers (V1)

Measured on Apple M-series, macOS 14, wasm-pack --release, Node.js 20.

| Metric | Fixture (4 nodes) | Notes |
|--------|-------------------|-------|
| WASM binary (gzipped) | **116.8 KB** | Target: <500 KB ✓ |
| Graph load | <1 ms | Target: <2 s ✓ |
| Shortest path query | <1 ms | Target: <200 ms ✓ |

City-scale benchmarks (NYC ~1M nodes, ~2.5M edges) are not yet run. The brute-force
nearest-node scan will dominate at that scale. R-tree upgrade is the first
optimisation to make before city-scale deployment.

---

## What's not implemented (V1 scope boundary)

- **Waypoint-on-edge projection.** Unweaver projects off-graph query points onto
  the nearest edge and creates temporary overlay nodes. This experiment snaps to
  the nearest node instead. For dense urban graphs the difference is small.
- **Reachable-tree partial-edge trimming.** Unweaver trims edges at the cost boundary
  and creates new nodes there. This implementation includes full edges only.
- **Pre-calculated edge weights.** Unweaver's `precalculate: true` profile option
  stores weights in the GeoPackage for fast lookup. Not applicable in our
  in-memory model; all weights are computed at query time.
- **Multiple simultaneous graphs.** One `Router` = one graph. Multi-graph federation
  is out of scope.
- **GTFS / transit integration.** Unweaver supports transit-linked graphs. Out of scope.
