//! End-to-end routing tests on the small_osw.geojson fixture.
//!
//! Graph topology (all edges directed A→B→C, B→D→C):
//!
//!   A --[AB: incline=0.02]-- B --[BC: incline=0.12, STEEP]--> C
//!                            |
//!                        [BD: crossing, curbramps=true]
//!                            |
//!                            D --[DC: incline=0.01]----------> C
//!
//! A→C via B (direct): AB(84) + BC(84) = 168m, but BC has incline=0.12 > 0.0833
//!   → impassable for wheelchair profile.
//! A→C via D (detour): AB(84) + BD(111) + DC(140) = 335m
//!   → passable for wheelchair (all grades ≤ 0.08, crossing has curb ramps).
//! Generic pedestrian takes the shorter direct route A→B→C.

use std::collections::HashMap;
use unweaver_wasm::{
    graph::OswGraph,
    profile::Profile,
    routing::{shortest_path, shortest_path_tree},
};

const FIXTURE: &str = include_str!("fixtures/small_osw.geojson");

fn load_graph() -> OswGraph {
    OswGraph::from_geojson(FIXTURE).expect("fixture should load")
}

#[test]
fn graph_loads_correct_counts() {
    let g = load_graph();
    assert_eq!(g.node_count(), 4, "4 nodes in fixture");
    assert_eq!(g.edge_count(), 4, "4 directed edges in fixture");
}

#[test]
fn generic_pedestrian_takes_direct_route() {
    let g = load_graph();
    let profile = Profile::from_json(include_str!(
        "../examples/profile-generic_pedestrian.json"
    ))
    .unwrap();
    let args = profile.resolve_args(HashMap::new()).unwrap();

    let a = g.nearest_node(40.692, -73.990).unwrap();
    let c = g.nearest_node(40.692, -73.988).unwrap();

    let result = shortest_path(&g.graph, a, c, &profile.cost, &args).unwrap();

    // Direct route A→B→C: 84 + 84 = 168m
    assert!(
        (result.total_cost - 168.0).abs() < 1.0,
        "expected ~168m, got {}",
        result.total_cost
    );
    assert_eq!(result.edges.len(), 2, "two edges for direct route");
}

#[test]
fn wheelchair_avoids_steep_edge_takes_detour() {
    let g = load_graph();
    let profile =
        Profile::from_json(include_str!("../examples/profile-manual_wheelchair.json")).unwrap();
    let args = profile.resolve_args(HashMap::new()).unwrap();

    let a = g.nearest_node(40.692, -73.990).unwrap();
    let c = g.nearest_node(40.692, -73.988).unwrap();

    let result = shortest_path(&g.graph, a, c, &profile.cost, &args).unwrap();

    // Detour A→B→D→C: 84 + 111 + 140 = 335m
    assert!(
        (result.total_cost - 335.0).abs() < 1.0,
        "expected ~335m detour, got {}",
        result.total_cost
    );
    assert_eq!(result.edges.len(), 3, "three edges for detour");
}

#[test]
fn different_profiles_produce_different_routes() {
    let g = load_graph();
    let wheelchair =
        Profile::from_json(include_str!("../examples/profile-manual_wheelchair.json")).unwrap();
    let pedestrian = Profile::from_json(include_str!(
        "../examples/profile-generic_pedestrian.json"
    ))
    .unwrap();

    let w_args = wheelchair.resolve_args(HashMap::new()).unwrap();
    let p_args = pedestrian.resolve_args(HashMap::new()).unwrap();

    let a = g.nearest_node(40.692, -73.990).unwrap();
    let c = g.nearest_node(40.692, -73.988).unwrap();

    let w_result = shortest_path(&g.graph, a, c, &wheelchair.cost, &w_args).unwrap();
    let p_result = shortest_path(&g.graph, a, c, &pedestrian.cost, &p_args).unwrap();

    assert_ne!(
        w_result.total_cost, p_result.total_cost,
        "profiles should produce different costs"
    );
    assert!(
        w_result.total_cost > p_result.total_cost,
        "wheelchair detour should be longer"
    );
}

#[test]
fn shortest_path_tree_reachability() {
    let g = load_graph();
    let profile = Profile::from_json(include_str!(
        "../examples/profile-generic_pedestrian.json"
    ))
    .unwrap();
    let args = profile.resolve_args(HashMap::new()).unwrap();

    let a = g.nearest_node(40.692, -73.990).unwrap();

    // budget of 100m: should reach B (84m away) but not C (168m) or D (195m)
    let tree = shortest_path_tree(&g.graph, a, 100.0, &profile.cost, &args);

    assert!(
        tree.node_costs.contains_key("node_B"),
        "node_B should be reachable at 100m"
    );
    assert!(
        !tree.node_costs.contains_key("node_C"),
        "node_C should NOT be reachable at 100m"
    );
}
