//! Check if Washington Heights dest is reachable from origin for wheelchair.

use std::collections::HashMap;
use unweaver_wasm::{graph::OswGraph, profile::Profile, routing::shortest_path};

const BINARY_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../output/nyc-pedestrian.bin"
);

fn load() -> Option<OswGraph> {
    let bytes = std::fs::read(BINARY_PATH).ok()?;
    Some(OswGraph::from_binary(&bytes).expect("binary should parse"))
}

#[test]
fn find_hilly_wheelchair_detour_coords() {
    let Some(g) = load() else { return };
    let ped = Profile::from_json(include_str!("../examples/profile-generic_pedestrian.json")).unwrap();
    let wc  = Profile::from_json(include_str!("../examples/profile-manual_wheelchair.json")).unwrap();
    let p_args = ped.resolve_args(HashMap::new()).unwrap();
    let w_args = wc.resolve_args(HashMap::new()).unwrap();

    // Try several pairs of coords in Washington Heights and surrounding hilly areas.
    // We want: pedestrian finds path, wheelchair finds a LONGER path.
    let candidates = [
        // Washington Heights — around Fort Tryon Park area, very hilly
        ("WH: 187th & Ft Washington→186th & Broadway",
            40.8528, -73.9409,
            40.8516, -73.9382),
        // WH: 181st St east-west variation
        ("WH: 181st & Ft Washington→181st & Broadway",
            40.8499, -73.9390,
            40.8499, -73.9340),
        // WH: trying 183rd St
        ("WH: 183rd & Pinehurst→183rd & Broadway",
            40.8510, -73.9380,
            40.8510, -73.9340),
        // Inwood Hill area
        ("Inwood: 207th & Isham→207th & Broadway",
            40.8680, -73.9218,
            40.8680, -73.9185),
        // Bay Ridge Brooklyn — hilly residential
        ("BayRidge: 4th Ave & 80th→4th Ave & 86th",
            40.6425, -74.0185,
            40.6367, -74.0185),
    ];

    for (name, olat, olon, dlat, dlon) in &candidates {
        let origin = g.nearest_node(*olat, *olon).unwrap();
        let dest   = g.nearest_node(*dlat, *dlon).unwrap();
        let p_r = shortest_path(&g.graph, origin, dest, &ped.cost, &p_args);
        let w_r = shortest_path(&g.graph, origin, dest, &wc.cost, &w_args);
        println!("{name}:");
        match (&p_r, &w_r) {
            (Ok(p), Ok(w)) => {
                println!("  pedestrian={:.0}m wheelchair={:.0}m ratio={:.2}",
                    p.total_cost, w.total_cost, w.total_cost / p.total_cost);
            }
            (Ok(p), Err(_)) => println!("  pedestrian={:.0}m wheelchair=NoPath", p.total_cost),
            (Err(_), _)     => println!("  pedestrian=NoPath"),
        }
    }
}
