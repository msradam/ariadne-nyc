//! Find Washington Heights coord pairs where wheelchair detour exists.

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
fn find_working_wheelchair_detour() {
    let Some(g) = load() else { return };
    let ped = Profile::from_json(include_str!("../examples/profile-generic_pedestrian.json")).unwrap();
    let wc  = Profile::from_json(include_str!("../examples/profile-manual_wheelchair.json")).unwrap();
    let p_args = ped.resolve_args(HashMap::new()).unwrap();
    let w_args = wc.resolve_args(HashMap::new()).unwrap();

    // Steep edges are around 40.84768,-73.92914 and 40.85675,-73.93249
    // Try pairs near those steep edges
    let candidates = [
        // Around Fort Washington Ave (very hilly)
        ("FW: 186th N→184th S",   40.8560, -73.9320, 40.8520, -73.9295),
        ("FW: 185th NW→184th SE", 40.8550, -73.9330, 40.8515, -73.9295),
        ("FW: 184th→182nd",       40.8530, -73.9315, 40.8490, -73.9290),
        // Near the steep edge at 40.84768,-73.92914
        ("WH: steep cross N→S",   40.8510, -73.9320, 40.8440, -73.9270),
        ("WH: steep cross NW→SE", 40.8510, -73.9310, 40.8455, -73.9280),
        ("WH: 181st fw→ew",       40.8490, -73.9300, 40.8490, -73.9260),
        // Broader area
        ("WH: 192nd → 181st",     40.8595, -73.9335, 40.8490, -73.9300),
        ("WH: Ft Tryon → 181st",  40.8572, -73.9311, 40.8490, -73.9290),
    ];

    for (name, olat, olon, dlat, dlon) in &candidates {
        let origin = g.nearest_node(*olat, *olon).unwrap();
        let dest   = g.nearest_node(*dlat, *dlon).unwrap();
        let p_r = shortest_path(&g.graph, origin, dest, &ped.cost, &p_args);
        let w_r = shortest_path(&g.graph, origin, dest, &wc.cost, &w_args);
        match (&p_r, &w_r) {
            (Ok(p), Ok(w)) if w.total_cost > p.total_cost * 1.05 => {
                println!("✓ DETOUR FOUND: {name}");
                println!("  pedestrian={:.0}m wheelchair={:.0}m ratio={:.2}",
                    p.total_cost, w.total_cost, w.total_cost / p.total_cost);
                println!("  origin_coords: ({olat},{olon}) dest_coords: ({dlat},{dlon})");
            }
            (Ok(p), Ok(w)) => {
                println!("  same: {name} ped={:.0}m wc={:.0}m", p.total_cost, w.total_cost);
            }
            (Ok(p), Err(_)) => println!("  NoPath: {name} ped={:.0}m wc=NoPath", p.total_cost),
            (Err(_), _) => println!("  both NoPath: {name}"),
        }
    }
}
