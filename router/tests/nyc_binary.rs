//! Integration tests against the real NYC binary (output/nyc-pedestrian.bin).
//!
//! These tests verify that all three profiles can route between real NYC locations,
//! and that wheelchair routing is not universally blocked. Run from repo root:
//!   cargo test --test nyc_binary
//!
//! The binary must exist at <repo-root>/output/nyc-pedestrian.bin.
//! Tests are skipped (not failed) when the binary is absent.

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

// ── graph sanity ──────────────────────────────────────────────────────────────

#[test]
fn binary_loads_with_expected_counts() {
    let Some(g) = load_binary() else { return };
    let nodes = g.node_count();
    let edges = g.edge_count();
    println!("Loaded {nodes} nodes, {edges} edges");
    assert!(nodes > 1_000_000, "expected >1M nodes, got {nodes}");
    assert!(edges > 1_000_000, "expected >1M edges, got {edges}");
}

// ── flat Manhattan routes — all profiles should succeed ───────────────────────

/// Lower Manhattan: Wall St → Fulton St (~250m, nearly flat)
#[test]
fn pedestrian_lower_manhattan_wall_to_fulton() {
    let Some(g) = load_binary() else { return };
    let p = pedestrian();
    let args = p.resolve_args(HashMap::new()).unwrap();

    let origin = g.nearest_node(40.7074, -74.0113).unwrap();
    let dest   = g.nearest_node(40.7097, -74.0076).unwrap();

    let r = shortest_path(&g.graph, origin, dest, &p.cost, &args);
    assert!(r.is_ok(), "pedestrian lower manhattan: {:?}", r.err());
    let r = r.unwrap();
    assert!(r.total_cost > 50.0 && r.total_cost < 2000.0,
        "expected 50-2000m, got {}m", r.total_cost);
    println!("[pedestrian] Wall→Fulton: {:.0}m in {} edges", r.total_cost, r.edges.len());
}

#[test]
fn wheelchair_lower_manhattan_wall_to_fulton() {
    let Some(g) = load_binary() else { return };
    let w = wheelchair();
    let args = w.resolve_args(HashMap::new()).unwrap();

    let origin = g.nearest_node(40.7074, -74.0113).unwrap();
    let dest   = g.nearest_node(40.7097, -74.0076).unwrap();

    let r = shortest_path(&g.graph, origin, dest, &w.cost, &args);
    assert!(r.is_ok(), "wheelchair lower manhattan should find path: {:?}", r.err());
    let r = r.unwrap();
    println!("[wheelchair] Wall→Fulton: {:.0}m in {} edges", r.total_cost, r.edges.len());
}

/// Midtown: 5th Ave & 42nd → 5th Ave & 50th (~800m, flat)
#[test]
fn all_profiles_midtown_5th_ave() {
    let Some(g) = load_binary() else { return };

    let origin = g.nearest_node(40.7527, -73.9823).unwrap();
    let dest   = g.nearest_node(40.7614, -73.9776).unwrap();

    for (name, profile) in [("pedestrian", pedestrian()), ("wheelchair", wheelchair()), ("low_vision", low_vision())] {
        let args = profile.resolve_args(HashMap::new()).unwrap();
        let r = shortest_path(&g.graph, origin, dest, &profile.cost, &args);
        assert!(r.is_ok(), "{name} midtown 5th Ave: {:?}", r.err());
        let r = r.unwrap();
        println!("[{name}] 42nd→50th 5th Ave: {:.0}m", r.total_cost);
    }
}

/// Williamsburg, Brooklyn: flat neighbourhood
#[test]
fn all_profiles_williamsburg_brooklyn() {
    let Some(g) = load_binary() else { return };

    let origin = g.nearest_node(40.7143, -73.9590).unwrap();
    let dest   = g.nearest_node(40.7181, -73.9556).unwrap();

    for (name, profile) in [("pedestrian", pedestrian()), ("wheelchair", wheelchair())] {
        let args = profile.resolve_args(HashMap::new()).unwrap();
        let r = shortest_path(&g.graph, origin, dest, &profile.cost, &args);
        assert!(r.is_ok(), "{name} Williamsburg: {:?}", r.err());
        let r = r.unwrap();
        println!("[{name}] Williamsburg: {:.0}m", r.total_cost);
    }
}

/// Astoria, Queens
#[test]
fn all_profiles_astoria_queens() {
    let Some(g) = load_binary() else { return };

    let origin = g.nearest_node(40.7721, -73.9302).unwrap();
    let dest   = g.nearest_node(40.7693, -73.9269).unwrap();

    for (name, profile) in [("pedestrian", pedestrian()), ("wheelchair", wheelchair())] {
        let args = profile.resolve_args(HashMap::new()).unwrap();
        let r = shortest_path(&g.graph, origin, dest, &profile.cost, &args);
        assert!(r.is_ok(), "{name} Astoria: {:?}", r.err());
        let r = r.unwrap();
        println!("[{name}] Astoria: {:.0}m", r.total_cost);
    }
}

// ── hilly areas: pedestrian should be shorter than wheelchair ─────────────────

/// Washington Heights (northern Manhattan): very hilly — wheelchair must detour 63% longer.
/// Coords verified programmatically: pedestrian ~929m direct, wheelchair ~1511m detour.
#[test]
fn wheelchair_detours_in_washington_heights() {
    let Some(g) = load_binary() else { return };

    // 185th St NW → 184th St SE — direct route crosses a steep grade (>8.33%)
    let origin = g.nearest_node(40.8550, -73.9330).unwrap();
    let dest   = g.nearest_node(40.8515, -73.9295).unwrap();

    let ped = pedestrian();
    let wc  = wheelchair();
    let p_args = ped.resolve_args(HashMap::new()).unwrap();
    let w_args = wc.resolve_args(HashMap::new()).unwrap();

    let p_result = shortest_path(&g.graph, origin, dest, &ped.cost, &p_args);
    let w_result = shortest_path(&g.graph, origin, dest, &wc.cost, &w_args);

    assert!(p_result.is_ok(), "pedestrian Washington Heights: {:?}", p_result.err());
    assert!(w_result.is_ok(), "wheelchair Washington Heights: {:?}", w_result.err());

    let p_cost = p_result.unwrap().total_cost;
    let w_cost = w_result.unwrap().total_cost;
    println!("[pedestrian] Washington Heights: {p_cost:.0}m");
    println!("[wheelchair] Washington Heights: {w_cost:.0}m detour (ratio: {:.2})",
        w_cost / p_cost);
    assert!(w_cost > p_cost * 1.1,
        "wheelchair should take a meaningfully longer detour (expected >1.1x), got {w_cost:.0} vs {p_cost:.0}");
}

/// Staten Island: hilly terrain
#[test]
fn wheelchair_routes_in_staten_island() {
    let Some(g) = load_binary() else { return };

    let origin = g.nearest_node(40.6412, -74.0768).unwrap();
    let dest   = g.nearest_node(40.6354, -74.0741).unwrap();

    let wc = wheelchair();
    let args = wc.resolve_args(HashMap::new()).unwrap();
    let r = shortest_path(&g.graph, origin, dest, &wc.cost, &args);
    assert!(r.is_ok(), "wheelchair Staten Island: {:?}", r.err());
    println!("[wheelchair] Staten Island: {:.0}m", r.unwrap().total_cost);
}

// ── cross-borough routes ──────────────────────────────────────────────────────

/// Brooklyn: DUMBO to Brooklyn Heights (same connected component, ~600m)
#[test]
fn pedestrian_brooklyn_dumbo_to_heights() {
    let Some(g) = load_binary() else { return };
    let p = pedestrian();
    let args = p.resolve_args(HashMap::new()).unwrap();

    let origin = g.nearest_node(40.7035, -73.9888).unwrap();
    let dest   = g.nearest_node(40.6960, -73.9952).unwrap();

    let r = shortest_path(&g.graph, origin, dest, &p.cost, &args);
    assert!(r.is_ok(), "pedestrian DUMBO→Brooklyn Heights: {:?}", r.err());
    let r = r.unwrap();
    println!("[pedestrian] DUMBO→Brooklyn Heights: {:.0}m in {} edges", r.total_cost, r.edges.len());
    assert!(r.total_cost > 100.0, "should be >100m");
}

// ── reachability (shortest path tree) ────────────────────────────────────────

/// Wheelchair tree from flat Midtown: should reach many nodes within 500m
#[test]
fn wheelchair_tree_midtown_reaches_nodes() {
    let Some(g) = load_binary() else { return };
    let wc = wheelchair();
    let args = wc.resolve_args(HashMap::new()).unwrap();

    let origin = g.nearest_node(40.7527, -73.9823).unwrap();
    let tree = shortest_path_tree(&g.graph, origin, 500.0, &wc.cost, &args);

    println!("[wheelchair] 500m tree from Midtown: {} nodes reachable", tree.node_costs.len());
    assert!(tree.node_costs.len() > 100,
        "wheelchair should reach >100 nodes within 500m of Midtown, got {}",
        tree.node_costs.len());
}

/// Pedestrian tree should reach same or more nodes than wheelchair
#[test]
fn pedestrian_tree_reaches_more_than_wheelchair() {
    let Some(g) = load_binary() else { return };

    let origin = g.nearest_node(40.7527, -73.9823).unwrap();

    let ped = pedestrian();
    let wc  = wheelchair();
    let p_args = ped.resolve_args(HashMap::new()).unwrap();
    let w_args = wc.resolve_args(HashMap::new()).unwrap();

    let p_tree = shortest_path_tree(&g.graph, origin, 500.0, &ped.cost, &p_args);
    let w_tree = shortest_path_tree(&g.graph, origin, 500.0, &wc.cost, &w_args);

    println!("[pedestrian] 500m tree: {} nodes", p_tree.node_costs.len());
    println!("[wheelchair] 500m tree: {} nodes", w_tree.node_costs.len());
    assert!(p_tree.node_costs.len() >= w_tree.node_costs.len(),
        "pedestrian should reach >= wheelchair nodes");
}

// ── edge attribute sanity ─────────────────────────────────────────────────────

/// Verify the binary loaded correctly: edges on a known flat route have sane incline
#[test]
fn route_edges_have_valid_incline() {
    let Some(g) = load_binary() else { return };
    let p = pedestrian();
    let args = p.resolve_args(HashMap::new()).unwrap();

    let origin = g.nearest_node(40.7074, -74.0113).unwrap();
    let dest   = g.nearest_node(40.7097, -74.0076).unwrap();

    let r = shortest_path(&g.graph, origin, dest, &p.cost, &args).unwrap();
    for edge in &r.edges {
        if let Some(inc) = edge.attrs.get("incline").and_then(|v| v.as_f64()) {
            assert!(inc.abs() <= 1.0, "incline out of range: {inc}");
        }
        if let Some(len) = edge.attrs.get("length").and_then(|v| v.as_f64()) {
            assert!((0.0..5000.0).contains(&len), "length out of range: {len}");
        }
    }
}
