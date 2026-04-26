//! Targeted diagnostics for the 2 remaining test failures.

use std::collections::HashMap;
use petgraph::visit::EdgeRef;
use unweaver_wasm::{
    graph::OswGraph,
    profile::Profile,
    routing::shortest_path,
    cost::eval_cost,
};

const BINARY_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../output/nyc-pedestrian.bin"
);

fn load() -> Option<OswGraph> {
    let bytes = std::fs::read(BINARY_PATH).ok()?;
    Some(OswGraph::from_binary(&bytes).expect("binary should parse"))
}

fn ped() -> Profile {
    Profile::from_json(include_str!("../examples/profile-generic_pedestrian.json")).unwrap()
}
fn wc() -> Profile {
    Profile::from_json(include_str!("../examples/profile-manual_wheelchair.json")).unwrap()
}

/// Check whether Brooklyn DUMBO and Manhattan City Hall are in the same component.
#[test]
fn diagnose_brooklyn_manhattan_connectivity() {
    let Some(g) = load() else { return };
    let p = ped();
    let _args = p.resolve_args(HashMap::new()).unwrap();

    let dumbo      = g.nearest_node(40.7035, -73.9888).unwrap();
    let city_hall  = g.nearest_node(40.7128, -74.0059).unwrap();

    println!("DUMBO node: {}", g.graph[dumbo].id);
    println!("City Hall node: {}", g.graph[city_hall].id);

    // BFS from DUMBO — how many nodes reachable?
    let mut visited = std::collections::HashSet::new();
    let mut queue = std::collections::VecDeque::new();
    queue.push_back(dumbo);
    visited.insert(dumbo);
    while let Some(node) = queue.pop_front() {
        for eref in g.graph.edges(node) {
            let v = eref.target();
            if visited.insert(v) {
                queue.push_back(v);
            }
        }
        if visited.len() >= 50_000 { break; }
    }
    println!("BFS from DUMBO: {} nodes (cap 50k). City Hall reachable: {}",
        visited.len(), visited.contains(&city_hall));

    // Try nearby points that might be in a larger component
    let bridge_coords = [
        ("Brooklyn Bridge BK side",  40.7060, -73.9971),
        ("Brooklyn Bridge MH side",  40.7081, -74.0015),
        ("Manhattan Bridge BK side", 40.7068, -73.9900),
        ("Manhattan Bridge MH side", 40.7145, -73.9988),
    ];
    for (name, lat, lon) in &bridge_coords {
        let idx = g.nearest_node(*lat, *lon).unwrap();
        let node = &g.graph[idx];
        let out = g.graph.edges(idx).count();
        let inc = g.graph.edges_directed(idx, petgraph::Direction::Incoming).count();
        println!("  {name}: id={} out={out} in={inc}", node.id);
    }
}

/// Diagnose wheelchair routing in Washington Heights.
#[test]
fn diagnose_washington_heights_wheelchair() {
    let Some(g) = load() else { return };
    let w = wc();
    let args = w.resolve_args(HashMap::new()).unwrap();

    let origin = g.nearest_node(40.8499, -73.9390).unwrap();
    let dest   = g.nearest_node(40.8464, -73.9318).unwrap();

    println!("Origin: {} out={}", g.graph[origin].id, g.graph.edges(origin).count());
    println!("Dest:   {} out={}", g.graph[dest].id,   g.graph.edges(dest).count());

    // Check inclines on edges around origin
    println!("\nEdges from origin:");
    for eref in g.graph.edges(origin) {
        let e = eref.weight();
        let cost = eval_cost(&w.cost, &e.attrs, &args);
        println!("  → {} incline={:.4} footway={} cost={:?}",
            e.v_id,
            e.attrs.get("incline").and_then(|v| v.as_f64()).unwrap_or(0.0),
            e.attrs.get("footway").and_then(|v| v.as_str()).unwrap_or("?"),
            cost,
        );
    }

    // BFS from origin counting reachable vs blocked
    let mut reachable = 0usize;
    let mut blocked_incline = 0usize;
    let mut blocked_cross = 0usize;
    let mut visited = std::collections::HashSet::new();
    let mut queue = std::collections::VecDeque::new();
    queue.push_back(origin);
    visited.insert(origin);

    while let Some(node) = queue.pop_front() {
        for eref in g.graph.edges(node) {
            let e = eref.weight();
            let v = eref.target();
            let inc = e.attrs.get("incline").and_then(|v| v.as_f64()).unwrap_or(0.0);
            match eval_cost(&w.cost, &e.attrs, &args) {
                Some(_) => {
                    reachable += 1;
                    if visited.insert(v) {
                        queue.push_back(v);
                    }
                }
                None => {
                    if inc.abs() > 0.0833 { blocked_incline += 1; }
                    else { blocked_cross += 1; }
                }
            }
        }
        if visited.len() >= 5000 { break; }
    }

    println!("\nWashington Heights wheelchair BFS (cap 5k nodes):");
    println!("  Reachable from origin: {} nodes", visited.len());
    println!("  Passable edges encountered: {reachable}");
    println!("  Blocked by incline: {blocked_incline}");
    println!("  Blocked by other: {blocked_cross}");

    // Is dest reachable at all with pedestrian?
    let p = ped();
    let p_args = p.resolve_args(HashMap::new()).unwrap();
    let r = shortest_path(&g.graph, origin, dest, &p.cost, &p_args);
    println!("  Pedestrian route: {:?}", r.map(|r| r.total_cost));

    // Try wheelchair with relaxed uphill (1.0 = no slope limit)
    let relaxed_args: HashMap<String, serde_json::Value> = [
        ("uphill_max".to_owned(),   serde_json::json!(1.0)),
        ("downhill_max".to_owned(), serde_json::json!(-1.0)),
        ("avoid_curbs".to_owned(),  serde_json::json!(false)),
    ].into_iter().collect();
    let r_relaxed = shortest_path(&g.graph, origin, dest, &w.cost, &relaxed_args);
    println!("  Wheelchair (relaxed all limits): {:?}", r_relaxed.map(|r| r.total_cost));
}
