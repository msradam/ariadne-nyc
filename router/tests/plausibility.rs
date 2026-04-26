//! Routing plausibility tests for the NYC pedestrian graph.
//!
//! These tests verify behavioural correctness beyond simple connectivity:
//! detour ratios, edge attribute sanity, profile differentiation, incline
//! enforcement, mixed edge-type presence, R-tree snap accuracy, and path-tree
//! coverage comparisons.
//!
//! All tests skip gracefully (not fail) when the binary is absent.
//! Run from repo root:
//!   cargo test --test plausibility

use std::collections::HashMap;
use unweaver_wasm::{
    graph::OswGraph,
    profile::Profile,
    routing::{shortest_path, shortest_path_tree},
};

const BINARY_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../output/nyc-pedestrian.bin"
);

fn load_binary() -> Option<OswGraph> {
    let bytes = std::fs::read(BINARY_PATH).ok()?;
    Some(OswGraph::from_binary(&bytes).expect("binary should parse"))
}

fn pedestrian() -> Profile {
    Profile::from_json(include_str!("../examples/profile-generic_pedestrian.json")).unwrap()
}

fn wheelchair() -> Profile {
    Profile::from_json(include_str!("../examples/profile-manual_wheelchair.json")).unwrap()
}

fn low_vision() -> Profile {
    Profile::from_json(include_str!("../examples/profile-low_vision.json")).unwrap()
}

/// Haversine distance in metres between two (lat, lon) points.
fn haversine(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const R: f64 = 6_371_000.0; // Earth radius in metres
    let dlat = (lat2 - lat1).to_radians();
    let dlon = (lon2 - lon1).to_radians();
    let a = (dlat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (dlon / 2.0).sin().powi(2);
    let c = 2.0 * a.sqrt().asin();
    R * c
}

// ── Category 1: Detour factor ─────────────────────────────────────────────────

/// For pedestrian routing the total route distance should be ≤ 3.5× the
/// straight-line (haversine) distance between origin and destination.
/// Tests 6 diverse NYC point pairs across boroughs.
#[test]
fn detour_factor_is_reasonable() {
    let Some(g) = load_binary() else { return };
    let p = pedestrian();
    let args = p.resolve_args(HashMap::new()).unwrap();

    // (label, origin_lat, origin_lon, dest_lat, dest_lon)
    let pairs: &[(&str, f64, f64, f64, f64)] = &[
        // Lower Manhattan — Wall St → Bowling Green
        ("Lower Manhattan", 40.7074, -74.0113, 40.7035, -74.0135),
        // Midtown — Penn Station → Grand Central
        ("Midtown", 40.7506, -73.9971, 40.7527, -73.9772),
        // Harlem — 125th & Lex → 125th & St Nick
        ("Harlem", 40.7957, -73.9390, 40.8091, -73.9495),
        // Flushing, Queens — Main St → Northern Blvd
        ("Flushing Queens", 40.7575, -73.8303, 40.7638, -73.8330),
        // Bay Ridge, Brooklyn — 86th & 4th → Shore Rd
        ("Bay Ridge Brooklyn", 40.6227, -74.0285, 40.6174, -74.0341),
        // Bronx near Fordham — Fordham Rd & Grand Concourse → Creston Ave
        ("Bronx Fordham", 40.8613, -73.8900, 40.8654, -73.8958),
    ];

    const MAX_DETOUR: f64 = 3.5;
    let mut exceeded: Vec<String> = Vec::new();

    for &(label, olat, olon, dlat, dlon) in pairs {
        let origin = match g.nearest_node(olat, olon) {
            Some(n) => n,
            None => {
                println!("[detour] {label}: could not snap origin, skipping");
                continue;
            }
        };
        let dest = match g.nearest_node(dlat, dlon) {
            Some(n) => n,
            None => {
                println!("[detour] {label}: could not snap destination, skipping");
                continue;
            }
        };

        let straight = haversine(olat, olon, dlat, dlon);
        match shortest_path(&g.graph, origin, dest, &p.cost, &args) {
            Ok(r) => {
                let ratio = r.total_cost / straight;
                println!(
                    "[detour] {label}: route={:.0}m straight={:.0}m ratio={:.2}x",
                    r.total_cost, straight, ratio
                );
                if ratio > MAX_DETOUR {
                    exceeded.push(format!(
                        "{label}: {:.0}m / {:.0}m = {:.2}x (max {MAX_DETOUR}x)",
                        r.total_cost, straight, ratio
                    ));
                }
            }
            Err(e) => {
                println!("[detour] {label}: routing failed ({e:?}), skipping pair");
            }
        }
    }

    assert!(
        exceeded.is_empty(),
        "Pairs with detour factor > {MAX_DETOUR}x:\n{}",
        exceeded.join("\n")
    );
}

// ── Category 2: Route edge attribute sanity ───────────────────────────────────

/// Every edge in 5 pedestrian routes must satisfy:
/// - footway attr is one of the expected values
/// - incline is within [-1.0, 1.0]
/// - length is positive and < 2000m
/// - coords has ≥ 2 points
/// - consecutive edges share an endpoint (v_id[i] == u_id[i+1])
#[test]
fn route_edge_attrs_are_sane() {
    let Some(g) = load_binary() else { return };
    let p = pedestrian();
    let args = p.resolve_args(HashMap::new()).unwrap();

    let valid_footways: &[&str] = &["sidewalk", "crossing", "footway", "steps", "other"];

    // (label, origin_lat, origin_lon, dest_lat, dest_lon)
    let routes: &[(&str, f64, f64, f64, f64)] = &[
        ("Wall St → Fulton", 40.7074, -74.0113, 40.7097, -74.0076),
        ("42nd → 50th 5th Ave", 40.7527, -73.9823, 40.7614, -73.9776),
        ("Williamsburg", 40.7143, -73.9590, 40.7181, -73.9556),
        ("Astoria", 40.7721, -73.9302, 40.7693, -73.9269),
        ("DUMBO → Brooklyn Heights", 40.7035, -73.9888, 40.6960, -73.9952),
    ];

    for &(label, olat, olon, dlat, dlon) in routes {
        let origin = match g.nearest_node(olat, olon) {
            Some(n) => n,
            None => {
                println!("[attrs] {label}: could not snap origin, skipping");
                continue;
            }
        };
        let dest = match g.nearest_node(dlat, dlon) {
            Some(n) => n,
            None => {
                println!("[attrs] {label}: could not snap destination, skipping");
                continue;
            }
        };

        let r = match shortest_path(&g.graph, origin, dest, &p.cost, &args) {
            Ok(r) => r,
            Err(e) => {
                println!("[attrs] {label}: routing failed ({e:?}), skipping");
                continue;
            }
        };

        println!("[attrs] {label}: {} edges", r.edges.len());

        for (i, edge) in r.edges.iter().enumerate() {
            // footway must be a known value (if present)
            if let Some(fw) = edge.attrs.get("footway").and_then(|v| v.as_str()) {
                assert!(
                    valid_footways.contains(&fw),
                    "{label} edge {i} ({}): unexpected footway value '{fw}'",
                    edge.edge_id
                );
            }

            // incline within [-1.0, 1.0]
            if let Some(inc) = edge.attrs.get("incline").and_then(|v| v.as_f64()) {
                assert!(
                    inc.abs() <= 1.0,
                    "{label} edge {i} ({}): incline {inc} out of [-1, 1]",
                    edge.edge_id
                );
            }

            // length positive and < 2000m
            if let Some(len) = edge.attrs.get("length").and_then(|v| v.as_f64()) {
                assert!(
                    len > 0.0,
                    "{label} edge {i} ({}): length {len} is not positive",
                    edge.edge_id
                );
                assert!(
                    len < 2000.0,
                    "{label} edge {i} ({}): length {len} >= 2000m",
                    edge.edge_id
                );
            }

            // coords has ≥ 2 points
            assert!(
                edge.coords.len() >= 2,
                "{label} edge {i} ({}): only {} coord(s), need ≥ 2",
                edge.edge_id,
                edge.coords.len()
            );
        }

        // consecutive edges must share an endpoint
        for i in 0..r.edges.len().saturating_sub(1) {
            let v_id = &r.edges[i].v_id;
            let u_id_next = &r.edges[i + 1].u_id;
            assert_eq!(
                v_id, u_id_next,
                "{label}: edge {i} v_id '{v_id}' != edge {} u_id '{u_id_next}' — path is disconnected",
                i + 1
            );
        }
    }
}

// ── Category 3: Profile differences are observable ───────────────────────────

/// Washington Heights detour pair: all 3 profiles find routes, and wheelchair
/// costs are meaningfully higher than pedestrian (the direct path crosses steep
/// grades that are impassable for wheelchairs).
#[test]
fn profiles_differ_meaningfully_in_washington_heights() {
    let Some(g) = load_binary() else { return };

    // 185th St NW → 184th St SE — verified detour pair
    let origin = g.nearest_node(40.8550, -73.9330).unwrap();
    let dest   = g.nearest_node(40.8515, -73.9295).unwrap();

    let ped = pedestrian();
    let wc  = wheelchair();
    let lv  = low_vision();
    let p_args = ped.resolve_args(HashMap::new()).unwrap();
    let w_args = wc.resolve_args(HashMap::new()).unwrap();
    let l_args = lv.resolve_args(HashMap::new()).unwrap();

    let p_result = shortest_path(&g.graph, origin, dest, &ped.cost, &p_args);
    let w_result = shortest_path(&g.graph, origin, dest, &wc.cost,  &w_args);
    let l_result = shortest_path(&g.graph, origin, dest, &lv.cost,  &l_args);

    // All three profiles must find a route
    assert!(p_result.is_ok(), "pedestrian Washington Heights failed: {:?}", p_result.err());
    assert!(w_result.is_ok(), "wheelchair Washington Heights failed: {:?}", w_result.err());
    assert!(l_result.is_ok(), "low_vision Washington Heights failed: {:?}", l_result.err());

    let p_cost = p_result.unwrap().total_cost;
    let w_cost = w_result.unwrap().total_cost;
    let l_cost = l_result.unwrap().total_cost;

    println!("[profiles] Washington Heights pedestrian: {p_cost:.0}m");
    println!("[profiles] Washington Heights wheelchair:  {w_cost:.0}m  (ratio: {:.2}x)", w_cost / p_cost);
    println!("[profiles] Washington Heights low_vision:  {l_cost:.0}m  (ratio: {:.2}x)", l_cost / p_cost);

    // Wheelchair must always cost at least as much as pedestrian
    assert!(
        w_cost >= p_cost,
        "wheelchair cost ({w_cost:.0}m) should be >= pedestrian ({p_cost:.0}m)"
    );

    // Wheelchair must be at least 10% longer (expected ~63% from verified tests)
    assert!(
        w_cost >= p_cost * 1.10,
        "wheelchair ({w_cost:.0}m) should be ≥ 10% longer than pedestrian ({p_cost:.0}m), ratio={:.2}",
        w_cost / p_cost
    );

    // Low-vision must cost at least as much as pedestrian
    assert!(
        l_cost >= p_cost,
        "low_vision cost ({l_cost:.0}m) should be >= pedestrian ({p_cost:.0}m)"
    );
}

// ── Category 4: Incline budget on wheelchair routes ───────────────────────────

/// On flat-area wheelchair routes every edge must have abs(incline) ≤ 0.0834.
/// This verifies the impassability logic is enforced on the actual returned path.
#[test]
fn wheelchair_respects_incline_limit() {
    let Some(g) = load_binary() else { return };
    let wc = wheelchair();
    let args = wc.resolve_args(HashMap::new()).unwrap();

    // Flat-area pairs: (label, origin_lat, origin_lon, dest_lat, dest_lon)
    let routes: &[(&str, f64, f64, f64, f64)] = &[
        // Lower Manhattan — Wall St area
        ("Lower Manhattan Wall St", 40.7074, -74.0113, 40.7097, -74.0076),
        // Midtown
        ("Midtown", 40.7527, -73.9823, 40.7614, -73.9776),
        // Williamsburg, Brooklyn
        ("Williamsburg", 40.7143, -73.9590, 40.7181, -73.9556),
        // Astoria, Queens
        ("Astoria", 40.7721, -73.9302, 40.7693, -73.9269),
    ];

    // Wheelchair profile defaults: uphill_max=0.0833, downhill_max=-0.10
    // A passable edge must satisfy: downhill_max <= incline <= uphill_max
    const UPHILL_LIMIT: f64   =  0.0834;  // 0.0833 + fp tolerance
    const DOWNHILL_LIMIT: f64 = -0.1001;  // -0.10 - fp tolerance

    for &(label, olat, olon, dlat, dlon) in routes {
        let origin = match g.nearest_node(olat, olon) {
            Some(n) => n,
            None => {
                println!("[incline] {label}: could not snap origin, skipping");
                continue;
            }
        };
        let dest = match g.nearest_node(dlat, dlon) {
            Some(n) => n,
            None => {
                println!("[incline] {label}: could not snap destination, skipping");
                continue;
            }
        };

        let r = match shortest_path(&g.graph, origin, dest, &wc.cost, &args) {
            Ok(r) => r,
            Err(e) => {
                println!("[incline] {label}: routing failed ({e:?}), skipping");
                continue;
            }
        };

        println!("[incline] {label}: {} edges", r.edges.len());

        for (i, edge) in r.edges.iter().enumerate() {
            if let Some(inc) = edge.attrs.get("incline").and_then(|v| v.as_f64()) {
                assert!(
                    (DOWNHILL_LIMIT..=UPHILL_LIMIT).contains(&inc),
                    "{label} wheelchair edge {i} ({}): incline {inc:.4} outside passable range \
                     [{DOWNHILL_LIMIT}, {UPHILL_LIMIT}] — impassability logic broken",
                    edge.edge_id
                );
            }
        }
    }
}

// ── Category 5: Route has mixed edge types ────────────────────────────────────

/// A multi-block pedestrian route must contain at least one crossing and at
/// least one sidewalk edge. We use a ~600m route (Wall St → Fulton St)
/// that definitely crosses several intersections.
#[test]
fn routes_contain_mixed_edge_types() {
    let Some(g) = load_binary() else { return };
    let p = pedestrian();
    let args = p.resolve_args(HashMap::new()).unwrap();

    // Wall St & Broadway → Fulton St & Broadway (~600m, crosses multiple blocks)
    let origin = match g.nearest_node(40.7074, -74.0113) {
        Some(n) => n,
        None => { println!("[mixed] could not snap origin"); return; }
    };
    let dest = match g.nearest_node(40.7097, -74.0076) {
        Some(n) => n,
        None => { println!("[mixed] could not snap destination"); return; }
    };

    let r = match shortest_path(&g.graph, origin, dest, &p.cost, &args) {
        Ok(r) => r,
        Err(e) => {
            println!("[mixed] routing failed ({e:?}), skipping test");
            return;
        }
    };

    println!("[mixed] Wall St → Fulton St: {} edges", r.edges.len());

    let mut has_crossing = false;
    let mut has_sidewalk = false;

    for edge in &r.edges {
        if let Some(fw) = edge.attrs.get("footway").and_then(|v| v.as_str()) {
            println!("[mixed]   edge {} footway={fw}", edge.edge_id);
            if fw == "crossing" { has_crossing = true; }
            if fw == "sidewalk" { has_sidewalk = true; }
        }
    }

    assert!(
        has_crossing,
        "expected at least one crossing edge in a short urban route ({} edges total)",
        r.edges.len()
    );
    assert!(
        has_sidewalk,
        "expected at least one sidewalk edge in a short urban route ({} edges total)",
        r.edges.len()
    );
}

// ── Category 6: Nearest-node snap accuracy ────────────────────────────────────

/// For 8 query points across all 5 boroughs the snapped node must be within
/// 0.001 degrees (~111m) of the query point. This validates the R-tree.
/// Note: OswNode.coords is [longitude, latitude].
#[test]
fn nearest_node_snap_accuracy() {
    let Some(g) = load_binary() else { return };

    // (label, query_lat, query_lon)
    let points: &[(&str, f64, f64)] = &[
        ("Manhattan — Wall St",          40.7074, -74.0113),
        ("Manhattan — Times Square",     40.7580, -73.9855),
        ("Manhattan — Harlem 125th",     40.8036, -73.9496),
        ("Brooklyn — Williamsburg",      40.7143, -73.9590),
        ("Brooklyn — Bay Ridge",         40.6227, -74.0285),
        ("Queens — Flushing Main St",    40.7575, -73.8303),
        ("Bronx — Fordham Rd",           40.8613, -73.8900),
        ("Staten Island — St George",    40.6436, -74.0736),
    ];

    const MAX_DELTA_DEG: f64 = 0.001; // ~111m at NYC latitudes

    for &(label, qlat, qlon) in points {
        let idx = match g.nearest_node(qlat, qlon) {
            Some(n) => n,
            None => {
                println!("[snap] {label}: nearest_node returned None, skipping");
                continue;
            }
        };

        // OswNode.coords = [longitude, latitude]
        let node_coords = g.graph[idx].coords;
        let node_lon = node_coords[0];
        let node_lat = node_coords[1];

        let dlat = (node_lat - qlat).abs();
        let dlon = (node_lon - qlon).abs();
        let delta = dlat.hypot(dlon);

        println!(
            "[snap] {label}: query=({qlat:.4},{qlon:.4}) snapped=({node_lat:.4},{node_lon:.4}) Δ={delta:.5}°"
        );

        assert!(
            delta <= MAX_DELTA_DEG,
            "{label}: snapped node is {delta:.5}° away from query point (max {MAX_DELTA_DEG}°) — R-tree may be broken"
        );
    }
}

// ── Category 7: Path tree coverage ───────────────────────────────────────────

/// From 3 origins (Midtown, Downtown Brooklyn, Astoria) run shortest_path_tree
/// with a 300m budget. Assert ≥ 50 nodes reachable for pedestrian.
/// Assert wheelchair node count ≤ pedestrian (wheelchair reaches same or fewer).
#[test]
fn path_tree_coverage() {
    let Some(g) = load_binary() else { return };

    let ped = pedestrian();
    let wc  = wheelchair();
    let p_args = ped.resolve_args(HashMap::new()).unwrap();
    let w_args = wc.resolve_args(HashMap::new()).unwrap();

    // (label, origin_lat, origin_lon)
    let origins: &[(&str, f64, f64)] = &[
        ("Midtown",           40.7527, -73.9823),
        ("Downtown Brooklyn", 40.6926, -73.9902),
        ("Astoria",           40.7721, -73.9302),
    ];

    const BUDGET: f64 = 300.0;
    const MIN_PED_NODES: usize = 50;

    for &(label, olat, olon) in origins {
        let origin = match g.nearest_node(olat, olon) {
            Some(n) => n,
            None => {
                println!("[tree] {label}: could not snap origin, skipping");
                continue;
            }
        };

        let p_tree = shortest_path_tree(&g.graph, origin, BUDGET, &ped.cost, &p_args);
        let w_tree = shortest_path_tree(&g.graph, origin, BUDGET, &wc.cost,  &w_args);

        let p_count = p_tree.node_costs.len();
        let w_count = w_tree.node_costs.len();

        println!(
            "[tree] {label}: pedestrian={p_count} nodes, wheelchair={w_count} nodes within {BUDGET}m"
        );

        assert!(
            p_count >= MIN_PED_NODES,
            "{label}: pedestrian tree reached only {p_count} nodes within {BUDGET}m (expected ≥ {MIN_PED_NODES})"
        );

        assert!(
            w_count <= p_count,
            "{label}: wheelchair ({w_count}) reached MORE nodes than pedestrian ({p_count}) — unexpected"
        );
    }
}
