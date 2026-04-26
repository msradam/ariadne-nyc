//! OSW graph construction. Two loaders:
//!   from_geojson(): parses an OSW FeatureCollection (small fixtures, tests)
//!   from_binary():  parses the compact OSWB binary (full city, production)
//!
//! Both produce the same OswGraph. The graph is directed because OSW incline
//! is signed: u→v and v→u are different edges with opposite grades.

use std::collections::HashMap;
use std::io::{Cursor, Read};

use geojson::{Feature, GeoJson, Geometry, Value as GeoValue};
use rstar::{PointDistance, RTree, RTreeObject, AABB};
use serde_json::Value;
use thiserror::Error;

use crate::profile::EdgeAttrs;

// ── OSWB binary constants ────────────────────────────────────────────────────

const MAGIC: &[u8; 4] = b"OSWB";
const SUPPORTED_VERSION: u8 = 2;

// Footway byte values written by the Python exporter
const FOOTWAY_SIDEWALK: u8 = 0;
const FOOTWAY_CROSSING: u8 = 1;
const FOOTWAY_FOOTWAY:  u8 = 2;
const FOOTWAY_STEPS:    u8 = 3;

// Surface byte values
const SURFACE_NAMES: &[&str] = &[
    "unknown", "asphalt", "concrete", "paving_stones",
    "cobblestone", "gravel", "unpaved", "other_paved",
];

const CURBRAMPS_BIT: u8             = 0b0000_0001;
const CROSSING_MARKINGS_MASK: u8   = 0b0000_0110;
const CROSSING_MARKINGS_SHIFT: u8  = 1;

// ── Error ────────────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum GraphError {
    #[error("JSON parse error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("GeoJSON parse error: {0}")]
    GeoJson(String),
    #[error("Binary parse error: {0}")]
    Binary(String),
    #[error("Feature missing _id property")]
    MissingId,
}

// ── Node / Edge types ────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct OswNode {
    pub id: String,
    /// [longitude, latitude]
    pub coords: [f64; 2],
    pub attrs: EdgeAttrs,
}

#[derive(Debug, Clone)]
pub struct OswEdge {
    pub id: String,
    pub u_id: String,
    pub v_id: String,
    pub coords: Vec<[f64; 2]>,
    pub length: f64,
    pub attrs: EdgeAttrs,
}

// ── R-tree entry for nearest-node lookup ─────────────────────────────────────

struct NodePoint {
    lon: f64,
    lat: f64,
    idx: petgraph::stable_graph::NodeIndex,
}

impl RTreeObject for NodePoint {
    type Envelope = AABB<[f64; 2]>;
    fn envelope(&self) -> Self::Envelope {
        AABB::from_point([self.lon, self.lat])
    }
}

impl PointDistance for NodePoint {
    fn distance_2(&self, point: &[f64; 2]) -> f64 {
        let dx = self.lon - point[0];
        let dy = self.lat - point[1];
        dx * dx + dy * dy
    }
}

// ── OswGraph ─────────────────────────────────────────────────────────────────

pub struct OswGraph {
    pub graph: petgraph::stable_graph::StableDiGraph<OswNode, OswEdge>,
    pub node_index: HashMap<String, petgraph::stable_graph::NodeIndex>,
    rtree: RTree<NodePoint>,
}

impl OswGraph {
    // ── public constructors ──────────────────────────────────────────────────

    /// Load from an OSW GeoJSON FeatureCollection (used for tests and small fixtures).
    pub fn from_geojson(geojson_str: &str) -> Result<Self, GraphError> {
        let gj: GeoJson = geojson_str
            .parse()
            .map_err(|e: geojson::Error| GraphError::GeoJson(e.to_string()))?;

        let fc = match gj {
            GeoJson::FeatureCollection(fc) => fc,
            _ => return Err(GraphError::GeoJson("expected FeatureCollection".into())),
        };

        let mut g = petgraph::stable_graph::StableDiGraph::new();
        let mut node_index: HashMap<String, petgraph::stable_graph::NodeIndex> = HashMap::new();
        let mut edge_features: Vec<Feature> = Vec::new();

        for feature in fc.features {
            let geom = match &feature.geometry {
                Some(g) => g.clone(),
                None => continue,
            };
            match &geom.value {
                GeoValue::Point(_) => {
                    let id = extract_id(&feature)?;
                    let coords = point_coords(&geom)?;
                    let attrs = props_to_attrs(feature.properties.as_ref());
                    let idx = g.add_node(OswNode { id: id.clone(), coords, attrs });
                    node_index.insert(id, idx);
                }
                GeoValue::LineString(_) => edge_features.push(feature),
                _ => {}
            }
        }

        for feature in edge_features {
            let id = extract_id(&feature)?;
            let props = feature.properties.as_ref();
            let u_id = prop_str(props, "_u_id").unwrap_or_default();
            let v_id = prop_str(props, "_v_id").unwrap_or_default();
            if u_id.is_empty() || v_id.is_empty() { continue; }

            let geom = feature.geometry.as_ref().unwrap();
            let line_coords = linestring_coords(geom)?;
            let length = prop_f64(props, "length")
                .unwrap_or_else(|| haversine_length(&line_coords));
            let attrs = props_to_attrs(props);
            let edge = OswEdge { id, u_id: u_id.clone(), v_id: v_id.clone(),
                                 coords: line_coords, length, attrs };

            let u_idx = *node_index.entry(u_id.clone())
                .or_insert_with(|| g.add_node(bare_node(&u_id, &edge, true)));
            let v_idx = *node_index.entry(v_id.clone())
                .or_insert_with(|| g.add_node(bare_node(&v_id, &edge, false)));
            g.add_edge(u_idx, v_idx, edge);
        }

        let rtree = build_rtree(&g);
        Ok(OswGraph { graph: g, node_index, rtree })
    }

    /// Load from an OSWB compact binary (full city production use).
    ///
    /// Format (all little-endian):
    ///   Header 16 bytes: magic(4) version(1) pad(3) node_count(4) edge_count(4)
    ///   Nodes  10 bytes: lon(f32) lat(f32) attrs(u8) pad(u8)
    ///   Edges  18 bytes: u_idx(u32) v_idx(u32) length(f32) incline_i16(i16)
    ///                    footway(u8) surface(u8) flags(u8) width(u8)
    pub fn from_binary(bytes: &[u8]) -> Result<Self, GraphError> {
        let mut cur = Cursor::new(bytes);

        // Header
        let mut magic = [0u8; 4];
        cur.read_exact(&mut magic)
            .map_err(|e| GraphError::Binary(e.to_string()))?;
        if &magic != MAGIC {
            return Err(GraphError::Binary("bad magic bytes".into()));
        }
        let version = read_u8(&mut cur)?;
        if version != SUPPORTED_VERSION {
            return Err(GraphError::Binary(format!("unsupported version {version}")));
        }
        let _pad = [read_u8(&mut cur)?, read_u8(&mut cur)?, read_u8(&mut cur)?];
        let node_count = read_u32_le(&mut cur)? as usize;
        let edge_count = read_u32_le(&mut cur)? as usize;

        let mut g = petgraph::stable_graph::StableDiGraph::with_capacity(node_count, edge_count);
        let mut node_index = HashMap::with_capacity(node_count);

        // Nodes
        for _ in 0..node_count {
            let lon = read_f32_le(&mut cur)? as f64;
            let lat = read_f32_le(&mut cur)? as f64;
            let _attrs_byte = read_u8(&mut cur)?;
            let _pad = read_u8(&mut cur)?;

            // Node ID matches Unweaver's "lon,lat" convention
            let id = format!("{lon:.6},{lat:.6}");
            let mut attrs = HashMap::new();
            if _attrs_byte & 1 != 0 { attrs.insert("kerb".into(), Value::String("lowered".into())); }
            if _attrs_byte & 2 != 0 { attrs.insert("kerb".into(), Value::String("raised".into())); }
            if _attrs_byte & 4 != 0 { attrs.insert("tactile_paving".into(), Value::Bool(true)); }

            let idx = g.add_node(OswNode { id: id.clone(), coords: [lon, lat], attrs });
            node_index.insert(id, idx);
        }

        // Edges
        let indices: Vec<petgraph::stable_graph::NodeIndex> = g.node_indices().collect();

        for i in 0..edge_count {
            let u_raw  = read_u32_le(&mut cur)? as usize;
            let v_raw  = read_u32_le(&mut cur)? as usize;
            let length = read_f32_le(&mut cur)? as f64;
            let incline_i16 = read_i16_le(&mut cur)?;
            let footway_b   = read_u8(&mut cur)?;
            let surface_b   = read_u8(&mut cur)?;
            let flags       = read_u8(&mut cur)?;
            let width_b     = read_u8(&mut cur)?;

            if u_raw >= indices.len() || v_raw >= indices.len() {
                return Err(GraphError::Binary(
                    format!("edge {i}: node index out of range ({u_raw}, {v_raw})"),
                ));
            }

            let u_idx = indices[u_raw];
            let v_idx = indices[v_raw];
            let u_id  = g[u_idx].id.clone();
            let v_id  = g[v_idx].id.clone();

            let incline = (incline_i16 as f64) / 10_000.0;
            let width   = if width_b == 0 { None } else { Some((width_b as f64) / 5.0) };

            let footway = match footway_b {
                FOOTWAY_SIDEWALK => "sidewalk",
                FOOTWAY_CROSSING => "crossing",
                FOOTWAY_FOOTWAY  => "footway",
                FOOTWAY_STEPS    => "steps",
                _                => "other",
            };
            let surface = SURFACE_NAMES
                .get(surface_b as usize)
                .copied()
                .unwrap_or("unknown");
            // curbramps: v2 exporter derives this from OSW CurbRamp Point nodes.
            // Only store when confirmed present. Absent attr means unknown,
            // which the profile treats as passable (benefit of the doubt).
            let has_curbramp = (flags & CURBRAMPS_BIT) != 0;

            // crossing:markings: physical markings on the crossing surface.
            // 0=unknown, 1=marked(yes), 2=zebra
            let crossing_markings_raw = (flags & CROSSING_MARKINGS_MASK) >> CROSSING_MARKINGS_SHIFT;
            let crossing_markings = match crossing_markings_raw {
                1 => "marked",
                2 => "zebra",
                _ => "unknown",
            };

            let mut attrs: EdgeAttrs = HashMap::new();
            attrs.insert("length".into(),  Value::from(length));
            attrs.insert("incline".into(), Value::from(incline));
            attrs.insert("footway".into(), Value::String(footway.into()));
            attrs.insert("surface".into(), Value::String(surface.into()));
            // Always store curbramps on crossing edges so the profile condition
            // `curbramps eq false` can fire. The exporter derives this from OSW
            // CurbRamp Point nodes; absent in the binary = not confirmed.
            if footway == "crossing" {
                attrs.insert("curbramps".into(), Value::Bool(has_curbramp));
                attrs.insert("crossing_markings".into(),
                             Value::String(crossing_markings.into()));
            }
            if let Some(w) = width {
                attrs.insert("width".into(), Value::from(w));
            }

            // Edge geometry: straight line between endpoints (sufficient for routing)
            let u_coords = g[u_idx].coords;
            let v_coords = g[v_idx].coords;
            let edge_id = format!("{u_raw}_{v_raw}_{i}");

            g.add_edge(u_idx, v_idx, OswEdge {
                id: edge_id,
                u_id, v_id,
                coords: vec![u_coords, v_coords],
                length,
                attrs,
            });
        }

        let rtree = build_rtree(&g);
        Ok(OswGraph { graph: g, node_index, rtree })
    }

    // ── public methods ───────────────────────────────────────────────────────

    pub fn node_count(&self) -> usize { self.graph.node_count() }
    pub fn edge_count(&self) -> usize { self.graph.edge_count() }

    pub fn node_by_id(&self, id: &str) -> Option<petgraph::stable_graph::NodeIndex> {
        self.node_index.get(id).copied()
    }

    /// Nearest graph node to (lat, lon). O(log n) via R-tree.
    pub fn nearest_node(&self, lat: f64, lon: f64) -> Option<petgraph::stable_graph::NodeIndex> {
        self.rtree
            .nearest_neighbor(&[lon, lat])
            .map(|p| p.idx)
    }
}

// ── R-tree builder ────────────────────────────────────────────────────────────

fn build_rtree(
    g: &petgraph::stable_graph::StableDiGraph<OswNode, OswEdge>,
) -> RTree<NodePoint> {
    // Only index nodes that have at least one edge (connected nodes).
    // Isolated nodes (OSW Point features not endpoints of any pedestrian edge)
    // would cause nearest_node to snap to an unreachable node → NoPath.
    let points: Vec<NodePoint> = g
        .node_indices()
        .filter(|&idx| {
            g.edges(idx).next().is_some()
                || g.edges_directed(idx, petgraph::Direction::Incoming)
                    .next()
                    .is_some()
        })
        .map(|idx| NodePoint {
            lon: g[idx].coords[0],
            lat: g[idx].coords[1],
            idx,
        })
        .collect();
    RTree::bulk_load(points)
}

// ── binary read helpers ───────────────────────────────────────────────────────

fn read_u8(cur: &mut Cursor<&[u8]>) -> Result<u8, GraphError> {
    let mut b = [0u8; 1];
    cur.read_exact(&mut b).map_err(|e| GraphError::Binary(e.to_string()))?;
    Ok(b[0])
}

fn read_u32_le(cur: &mut Cursor<&[u8]>) -> Result<u32, GraphError> {
    let mut b = [0u8; 4];
    cur.read_exact(&mut b).map_err(|e| GraphError::Binary(e.to_string()))?;
    Ok(u32::from_le_bytes(b))
}

fn read_i16_le(cur: &mut Cursor<&[u8]>) -> Result<i16, GraphError> {
    let mut b = [0u8; 2];
    cur.read_exact(&mut b).map_err(|e| GraphError::Binary(e.to_string()))?;
    Ok(i16::from_le_bytes(b))
}

fn read_f32_le(cur: &mut Cursor<&[u8]>) -> Result<f32, GraphError> {
    let mut b = [0u8; 4];
    cur.read_exact(&mut b).map_err(|e| GraphError::Binary(e.to_string()))?;
    Ok(f32::from_le_bytes(b))
}

// ── GeoJSON helpers ───────────────────────────────────────────────────────────

fn extract_id(f: &Feature) -> Result<String, GraphError> {
    f.properties.as_ref()
        .and_then(|p| p.get("_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_owned())
        .ok_or(GraphError::MissingId)
}

fn point_coords(geom: &Geometry) -> Result<[f64; 2], GraphError> {
    match &geom.value {
        GeoValue::Point(c) => Ok([c[0], c[1]]),
        _ => Err(GraphError::GeoJson("expected Point".into())),
    }
}

fn linestring_coords(geom: &Geometry) -> Result<Vec<[f64; 2]>, GraphError> {
    match &geom.value {
        GeoValue::LineString(c) => Ok(c.iter().map(|p| [p[0], p[1]]).collect()),
        _ => Err(GraphError::GeoJson("expected LineString".into())),
    }
}

fn prop_str(props: Option<&serde_json::Map<String, Value>>, key: &str) -> Option<String> {
    props?.get(key)?.as_str().map(|s| s.to_owned())
}

fn prop_f64(props: Option<&serde_json::Map<String, Value>>, key: &str) -> Option<f64> {
    props?.get(key)?.as_f64()
}

fn props_to_attrs(props: Option<&serde_json::Map<String, Value>>) -> EdgeAttrs {
    let mut map = HashMap::new();
    if let Some(p) = props {
        for (k, v) in p { map.insert(k.clone(), v.clone()); }
    }
    map
}

fn bare_node(id: &str, edge: &OswEdge, is_start: bool) -> OswNode {
    let coords = if is_start {
        *edge.coords.first().unwrap_or(&[0.0, 0.0])
    } else {
        *edge.coords.last().unwrap_or(&[0.0, 0.0])
    };
    OswNode { id: id.to_owned(), coords, attrs: HashMap::new() }
}

// ── geometry helpers ──────────────────────────────────────────────────────────

pub fn haversine_length(coords: &[[f64; 2]]) -> f64 {
    coords.windows(2)
        .map(|w| haversine_dist(w[0][1], w[0][0], w[1][1], w[1][0]))
        .sum()
}

pub fn haversine_dist(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const R: f64 = 6_371_000.0;
    let dlat = (lat2 - lat1).to_radians();
    let dlon = (lon2 - lon1).to_radians();
    let a = (dlat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (dlon / 2.0).sin().powi(2);
    R * 2.0 * a.sqrt().asin()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn haversine_zero() {
        assert_eq!(haversine_dist(40.7, -74.0, 40.7, -74.0), 0.0);
    }

    #[test]
    fn haversine_roughly_correct() {
        let d = haversine_dist(0.0, 0.0, 1.0, 0.0);
        assert!((d - 110_574.0).abs() < 1000.0, "got {d}");
    }
}
