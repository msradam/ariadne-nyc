//! WASM-exposed Router API.
//!
//! JSON response shapes match Unweaver's HTTP API so clients written
//! against Unweaver can be pointed at this engine without code changes.
//! See https://github.com/nbolten/unweaver for the reference shapes.

use std::collections::HashMap;

use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

use crate::graph::OswGraph;
use crate::profile::{Profile, RuntimeArgs};
use crate::routing::{shortest_path, shortest_path_tree, PathEdge};

#[wasm_bindgen]
pub struct Router {
    graph: OswGraph,
    profiles: HashMap<String, Profile>,
}

#[wasm_bindgen]
impl Router {
    /// Load a Router from an OSW GeoJSON FeatureCollection string.
    #[wasm_bindgen(js_name = fromOSWGeoJSON)]
    pub fn from_osw_geojson(geojson: &str) -> Result<Router, JsValue> {
        let graph = OswGraph::from_geojson(geojson)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(Router { graph, profiles: HashMap::new() })
    }

    /// Load a Router from an OSWB compact binary (Uint8Array from JS).
    /// 10.5 MB gzipped for all of NYC. Much faster to parse than GeoJSON.
    #[wasm_bindgen(js_name = fromBinary)]
    pub fn from_binary(data: &[u8]) -> Result<Router, JsValue> {
        let graph = OswGraph::from_binary(data)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(Router { graph, profiles: HashMap::new() })
    }

    /// Register a profile from a profile JSON string.
    #[wasm_bindgen(js_name = addProfile)]
    pub fn add_profile(&mut self, id: &str, profile_json: &str) -> Result<(), JsValue> {
        let profile = Profile::from_json(profile_json)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        self.profiles.insert(id.to_owned(), profile);
        Ok(())
    }

    /// Number of nodes in the loaded graph.
    #[wasm_bindgen(js_name = nodeCount)]
    pub fn node_count(&self) -> usize {
        self.graph.node_count()
    }

    /// Number of edges in the loaded graph.
    #[wasm_bindgen(js_name = edgeCount)]
    pub fn edge_count(&self) -> usize {
        self.graph.edge_count()
    }

    /// Compute the shortest path and return a Unweaver-compatible JSON string.
    ///
    /// origin/destination are [lat, lon] as JS arrays.
    /// args_json is an optional JSON object of profile runtime args (e.g. {"uphill_max": 0.05}).
    #[wasm_bindgen(js_name = shortestPathJSON)]
    pub fn shortest_path_json(
        &self,
        profile_id: &str,
        origin_lat: f64,
        origin_lon: f64,
        dest_lat: f64,
        dest_lon: f64,
        args_json: Option<String>,
    ) -> String {
        let result = self.do_shortest_path(
            profile_id,
            origin_lat,
            origin_lon,
            dest_lat,
            dest_lon,
            args_json,
        );
        serde_json::to_string_pretty(&result).unwrap_or_else(|_| "{}".into())
    }

    /// Compute a shortest-path tree (reachability within a cost budget).
    /// Returns a Unweaver-compatible JSON string.
    #[wasm_bindgen(js_name = shortestPathTreeJSON)]
    pub fn shortest_path_tree_json(
        &self,
        profile_id: &str,
        origin_lat: f64,
        origin_lon: f64,
        max_cost: f64,
        args_json: Option<String>,
    ) -> String {
        let result = self.do_shortest_path_tree(
            profile_id,
            origin_lat,
            origin_lon,
            max_cost,
            args_json,
        );
        serde_json::to_string_pretty(&result).unwrap_or_else(|_| "{}".into())
    }
}

// ---------- internal implementation ----------

impl Router {
    fn resolve_profile_and_args(
        &self,
        profile_id: &str,
        args_json: Option<String>,
    ) -> Result<(&Profile, RuntimeArgs), Value> {
        let profile = self
            .profiles
            .get(profile_id)
            .ok_or_else(|| json!({"status": "Error", "code": "UnknownProfile"}))?;

        let supplied: RuntimeArgs = match args_json {
            Some(j) => serde_json::from_str(&j)
                .unwrap_or_default(),
            None => HashMap::new(),
        };

        let args = profile
            .resolve_args(supplied)
            .map_err(|e| json!({"status": "Error", "code": "InvalidArgs", "message": e.to_string()}))?;

        Ok((profile, args))
    }

    fn do_shortest_path(
        &self,
        profile_id: &str,
        origin_lat: f64,
        origin_lon: f64,
        dest_lat: f64,
        dest_lon: f64,
        args_json: Option<String>,
    ) -> Value {
        let (profile, args) = match self.resolve_profile_and_args(profile_id, args_json) {
            Ok(v) => v,
            Err(e) => return e,
        };

        let origin_idx = match self.graph.nearest_node(origin_lat, origin_lon) {
            Some(idx) => idx,
            None => return json!({"status": "Error", "code": "InvalidWaypoint"}),
        };
        let dest_idx = match self.graph.nearest_node(dest_lat, dest_lon) {
            Some(idx) => idx,
            None => return json!({"status": "Error", "code": "InvalidWaypoint"}),
        };

        match shortest_path(&self.graph.graph, origin_idx, dest_idx, &profile.cost, &args) {
            Ok(result) => {
                json!({
                    "status": "Ok",
                    "origin": point_feature(origin_lon, origin_lat),
                    "destination": point_feature(dest_lon, dest_lat),
                    "total_cost": result.total_cost,
                    "edges": result.edges.iter().map(edge_to_json).collect::<Vec<_>>()
                })
            }
            Err(_) => json!({"status": "Error", "code": "NoPath"}),
        }
    }

    fn do_shortest_path_tree(
        &self,
        profile_id: &str,
        origin_lat: f64,
        origin_lon: f64,
        max_cost: f64,
        args_json: Option<String>,
    ) -> Value {
        let (profile, args) = match self.resolve_profile_and_args(profile_id, args_json) {
            Ok(v) => v,
            Err(e) => return e,
        };

        let origin_idx = match self.graph.nearest_node(origin_lat, origin_lon) {
            Some(idx) => idx,
            None => return json!({"status": "Error", "code": "InvalidWaypoint"}),
        };

        let result = shortest_path_tree(
            &self.graph.graph,
            origin_idx,
            max_cost,
            &profile.cost,
            &args,
        );

        let node_cost_features: Vec<Value> = result
            .node_costs
            .iter()
            .filter_map(|(node_id, &cost)| {
                let idx = self.graph.node_by_id(node_id)?;
                let coords = self.graph.graph[idx].coords;
                Some(json!({
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [coords[0], coords[1]]},
                    "properties": {"_id": node_id, "cost": cost}
                }))
            })
            .collect();

        json!({
            "status": "Ok",
            "origin": point_feature(origin_lon, origin_lat),
            "paths": result.paths,
            "edges": {
                "type": "FeatureCollection",
                "features": result.edges.iter().map(edge_to_geojson_feature).collect::<Vec<_>>()
            },
            "node_costs": {
                "type": "FeatureCollection",
                "features": node_cost_features
            }
        })
    }
}

// ---------- JSON helpers ----------

fn point_feature(lon: f64, lat: f64) -> Value {
    json!({
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": {}
    })
}

fn edge_to_json(e: &PathEdge) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("_u".into(), json!(e.u_id));
    obj.insert("_v".into(), json!(e.v_id));
    obj.insert("cost".into(), json!(e.cost));
    obj.insert(
        "geom".into(),
        json!({
            "type": "LineString",
            "coordinates": e.coords.iter().map(|c| json!([c[0], c[1]])).collect::<Vec<_>>()
        }),
    );
    for (k, v) in &e.attrs {
        obj.entry(k).or_insert_with(|| v.clone());
    }
    Value::Object(obj)
}

fn edge_to_geojson_feature(e: &PathEdge) -> Value {
    let mut props = serde_json::Map::new();
    props.insert("_u".into(), json!(e.u_id));
    props.insert("_v".into(), json!(e.v_id));
    for (k, v) in &e.attrs {
        props.entry(k).or_insert_with(|| v.clone());
    }
    json!({
        "type": "Feature",
        "geometry": {
            "type": "LineString",
            "coordinates": e.coords.iter().map(|c| json!([c[0], c[1]])).collect::<Vec<_>>()
        },
        "properties": props
    })
}
