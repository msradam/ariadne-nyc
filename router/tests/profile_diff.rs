//! Check whether profiles actually produce different routes with the new binary.

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

fn ped() -> Profile {
    Profile::from_json(include_str!("../examples/profile-generic_pedestrian.json")).unwrap()
}
fn wc() -> Profile {
    Profile::from_json(include_str!("../examples/profile-manual_wheelchair.json")).unwrap()
}
fn lv() -> Profile {
    Profile::from_json(include_str!("../examples/profile-low_vision.json")).unwrap()
}

/// For several flat-area routes, print ped vs wheelchair vs low_vision cost.
/// With new binary (curbramps + crossing_markings), profiles should diverge.
#[test]
fn flat_area_profile_comparison() {
    let Some(g) = load() else { return };

    let pairs = [
        ("Midtown 42nd→50th 5th Ave",  40.7527, -73.9823, 40.7614, -73.9776),
        ("Lower Manhattan Wall→Fulton", 40.7074, -74.0113, 40.7097, -74.0076),
        ("Williamsburg",               40.7143, -73.9590, 40.7181, -73.9556),
        ("Astoria",                    40.7721, -73.9302, 40.7693, -73.9269),
        ("Downtown Brooklyn",          40.6928, -73.9903, 40.6895, -73.9844),
    ];

    let p = ped(); let pa = p.resolve_args(HashMap::new()).unwrap();
    let w = wc();  let wa = w.resolve_args(HashMap::new()).unwrap();
    let l = lv();  let la = l.resolve_args(HashMap::new()).unwrap();

    let mut any_differ = false;

    for (name, olat, olon, dlat, dlon) in &pairs {
        let origin = g.nearest_node(*olat, *olon).unwrap();
        let dest   = g.nearest_node(*dlat, *dlon).unwrap();

        let pr = shortest_path(&g.graph, origin, dest, &p.cost, &pa);
        let wr = shortest_path(&g.graph, origin, dest, &w.cost, &wa);
        let lr = shortest_path(&g.graph, origin, dest, &l.cost, &la);

        print!("{name}: ");
        match &pr { Ok(r) => print!("ped={:.0}m ", r.total_cost), Err(_) => print!("ped=NoPath ") }
        match &wr { Ok(r) => print!("wc={:.0}m ", r.total_cost),  Err(_) => print!("wc=NoPath ") }
        match &lr { Ok(r) => print!("lv={:.0}m", r.total_cost),   Err(_) => print!("lv=NoPath") }
        println!();

        if let (Ok(p_r), Ok(w_r)) = (&pr, &wr) {
            if (w_r.total_cost - p_r.total_cost).abs() > 1.0 { any_differ = true; }
        }
    }

    println!("\nAny flat-area ped/wheelchair difference: {any_differ}");
}

/// Check what fraction of crossings on a specific route have curbramps.
#[test]
fn crossing_curbramp_coverage_on_route() {
    let Some(g) = load() else { return };
    let p = ped();
    let args = p.resolve_args(HashMap::new()).unwrap();

    // Wall St → Fulton — 29 edges, known to have crossings
    let origin = g.nearest_node(40.7074, -74.0113).unwrap();
    let dest   = g.nearest_node(40.7097, -74.0076).unwrap();
    let r = shortest_path(&g.graph, origin, dest, &p.cost, &args).unwrap();

    let mut crossings_total = 0;
    let mut crossings_with_ramp = 0;
    let mut crossings_marked = 0;

    for e in &r.edges {
        let fw = e.attrs.get("footway").and_then(|v| v.as_str()).unwrap_or("");
        if fw == "crossing" {
            crossings_total += 1;
            if e.attrs.get("curbramps").and_then(|v| v.as_bool()).unwrap_or(false) {
                crossings_with_ramp += 1;
            }
            let cm = e.attrs.get("crossing_markings").and_then(|v| v.as_str()).unwrap_or("?");
            if cm != "unknown" { crossings_marked += 1; }
            println!("  crossing: curbramps={} marking={}",
                e.attrs.get("curbramps").and_then(|v| v.as_bool()).unwrap_or(false),
                cm);
        }
    }

    println!("Wall→Fulton: {} crossings, {} with curbramps, {} with markings",
        crossings_total, crossings_with_ramp, crossings_marked);
}

/// If avoid_curbs=true blocks crossings without ramps, does wheelchair take
/// a longer route on a flat multi-block route in lower Manhattan?
#[test]
fn wheelchair_avoid_curbs_effect() {
    let Some(g) = load() else { return };
    let w = wc();

    let origin = g.nearest_node(40.7074, -74.0113).unwrap();
    let dest   = g.nearest_node(40.7097, -74.0076).unwrap();

    // Default: avoid_curbs=true
    let args_strict = w.resolve_args(HashMap::new()).unwrap();
    // Relaxed: avoid_curbs=false
    let args_relaxed = w.resolve_args(
        [("avoid_curbs".to_owned(), serde_json::json!(false))].into_iter().collect()
    ).unwrap();

    let strict  = shortest_path(&g.graph, origin, dest, &w.cost, &args_strict);
    let relaxed = shortest_path(&g.graph, origin, dest, &w.cost, &args_relaxed);

    println!("Wheelchair Wall→Fulton:");
    println!("  avoid_curbs=true:  {:?}", strict.as_ref().map(|r| r.total_cost));
    println!("  avoid_curbs=false: {:?}", relaxed.as_ref().map(|r| r.total_cost));

    match (&strict, &relaxed) {
        (Ok(s), Ok(r)) => {
            if s.total_cost > r.total_cost + 1.0 {
                println!("  → avoid_curbs adds {:.0}m detour", s.total_cost - r.total_cost);
            } else {
                println!("  → same route (all crossings on route have curbramps)");
            }
        }
        (Err(_), Ok(_)) => println!("  → strict=NoPath, curb avoidance disconnected the route"),
        _ => println!("  → both NoPath"),
    }
}
