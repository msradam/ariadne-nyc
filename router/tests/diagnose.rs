//! Diagnostic test to understand NoPath failures on the real binary.

use std::collections::HashMap;
use petgraph::visit::EdgeRef;
use unweaver_wasm::{
    graph::OswGraph,
    profile::Profile,
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

#[test]
fn diagnose_midtown_origin_edges() {
    let Some(g) = load() else { return };

    // 5th Ave & 42nd St area
    let origin = g.nearest_node(40.7527, -73.9823).unwrap();
    let node = &g.graph[origin];

    println!("Origin node id: {}", node.id);
    println!("Origin coords: {:?}", node.coords);

    // Count outgoing edges
    let out_edges: Vec<_> = g.graph.edges(origin).collect();
    println!("Outgoing edges: {}", out_edges.len());

    for (i, eref) in out_edges.iter().take(5).enumerate() {
        let e = eref.weight();
        println!("  edge[{i}]: id={} u={} v={}", e.id, e.u_id, e.v_id);
        println!("    length={:?}", e.attrs.get("length"));
        println!("    incline={:?}", e.attrs.get("incline"));
        println!("    footway={:?}", e.attrs.get("footway"));
    }

    // Try to traverse the first edge manually
    if let Some(first) = out_edges.first() {
        let edge = first.weight();
        let p = ped();
        let args = p.resolve_args(HashMap::new()).unwrap();
        let cost = eval_cost(&p.cost, &edge.attrs, &args);
        println!("First edge eval_cost: {:?}", cost);
    }

    // Check how many nodes are adjacent (in AND out)
    let in_edges: Vec<_> = g.graph.edges_directed(origin, petgraph::Direction::Incoming).collect();
    println!("Incoming edges: {}", in_edges.len());

    // Try nearest node for dest
    let dest = g.nearest_node(40.7614, -73.9776).unwrap();
    let dest_node = &g.graph[dest];
    println!("\nDest node id: {}", dest_node.id);
    println!("Dest coords: {:?}", dest_node.coords);
    let dest_out: Vec<_> = g.graph.edges(dest).collect();
    println!("Dest outgoing edges: {}", dest_out.len());
}

#[test]
fn diagnose_astoria_vs_midtown() {
    let Some(g) = load() else { return };

    let locations = [
        ("Astoria origin",   40.7721, -73.9302),
        ("Astoria dest",     40.7693, -73.9269),
        ("Midtown 42nd",     40.7527, -73.9823),
        ("Midtown 50th",     40.7614, -73.9776),
        ("Lower Manhattan A",40.7074, -74.0113),
        ("Lower Manhattan B",40.7097, -74.0076),
    ];

    for (name, lat, lon) in &locations {
        let idx = g.nearest_node(*lat, *lon).unwrap();
        let node = &g.graph[idx];
        let out = g.graph.edges(idx).count();
        let inc = g.graph.edges_directed(idx, petgraph::Direction::Incoming).count();
        println!("{name}: id={} coords={:.5},{:.5} out={out} in={inc}",
            node.id, node.coords[1], node.coords[0]);
    }
}

#[test]
fn diagnose_sample_edges_from_binary() {
    let Some(g) = load() else { return };

    // Sample the first 10 edges in the graph and inspect their attrs
    let mut count = 0;
    for eidx in g.graph.edge_indices() {
        if count >= 10 { break; }
        let e = &g.graph[eidx];
        let (u, v) = g.graph.edge_endpoints(eidx).unwrap();
        println!("Edge {}: u={} v={} length={:?} incline={:?} footway={:?}",
            count,
            g.graph[u].id, g.graph[v].id,
            e.attrs.get("length").and_then(|v| v.as_f64()),
            e.attrs.get("incline").and_then(|v| v.as_f64()),
            e.attrs.get("footway").and_then(|v| v.as_str()),
        );
        count += 1;
    }
}

#[test]
fn diagnose_connected_component_of_midtown() {
    let Some(g) = load() else { return };
    let p = ped();
    let args = p.resolve_args(HashMap::new()).unwrap();

    // BFS from Midtown origin to see reachable nodes
    let origin = g.nearest_node(40.7527, -73.9823).unwrap();

    let mut visited = std::collections::HashSet::new();
    let mut queue = std::collections::VecDeque::new();
    queue.push_back(origin);
    visited.insert(origin);

    while let Some(node) = queue.pop_front() {
        for eref in g.graph.edges(node) {
            let e = eref.weight();
            // Only traverse passable edges
            if eval_cost(&p.cost, &e.attrs, &args).is_some() {
                let v = eref.target();
                if visited.insert(v) {
                    queue.push_back(v);
                }
            }
        }
        if visited.len() >= 10000 { break; }
    }

    println!("BFS from Midtown: visited {} nodes (capped at 10k)", visited.len());

    // Also try BFS ignoring costs (raw connectivity)
    let mut visited2 = std::collections::HashSet::new();
    let mut queue2 = std::collections::VecDeque::new();
    queue2.push_back(origin);
    visited2.insert(origin);

    while let Some(node) = queue2.pop_front() {
        for eref in g.graph.edges(node) {
            let v = eref.target();
            if visited2.insert(v) {
                queue2.push_back(v);
            }
        }
        if visited2.len() >= 10000 { break; }
    }

    println!("BFS (no cost filter) from Midtown: visited {} nodes (capped at 10k)", visited2.len());
    assert!(visited2.len() > 100, "Midtown should have >100 nodes in its raw component");
}
