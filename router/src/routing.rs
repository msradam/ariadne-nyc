//! Profile-driven Dijkstra routing over an OswGraph.
//!
//! Mirrors Unweaver's use of NetworkX multi_source_dijkstra and
//! single_source_dijkstra. The cost function is the CostRules from the
//! loaded profile, evaluated per edge during graph traversal.
//!
//! Rust note: petgraph's built-in dijkstra() accepts a fixed edge weight;
//! we need a per-query cost function, so we roll our own priority-queue
//! Dijkstra. This also lets us handle None (impassable) edges cleanly.

use std::collections::{BinaryHeap, HashMap};

use ordered_float::NotNan;
use petgraph::stable_graph::{EdgeIndex, NodeIndex, StableDiGraph};
use petgraph::visit::EdgeRef;

use crate::cost::eval_cost;
use crate::graph::{OswEdge, OswNode};
use crate::profile::{CostRules, RuntimeArgs};

/// A waypoint in a computed shortest path.
#[derive(Debug, Clone)]
pub struct PathEdge {
    pub edge_id: String,
    pub u_id: String,
    pub v_id: String,
    pub cost: f64,
    pub coords: Vec<[f64; 2]>,
    pub attrs: crate::profile::EdgeAttrs,
}

/// Result of a shortest_path query.
#[derive(Debug)]
pub struct ShortestPathResult {
    pub total_cost: f64,
    pub edges: Vec<PathEdge>,
}

/// Result of a shortest_path_tree query.
#[derive(Debug)]
pub struct ShortestPathTreeResult {
    /// node_id → cumulative cost from origin
    pub node_costs: HashMap<String, f64>,
    /// node_id → sequence of node_ids from origin to that node
    pub paths: HashMap<String, Vec<String>>,
    /// all edges traversed in the tree
    pub edges: Vec<PathEdge>,
}

#[derive(Debug, thiserror::Error)]
pub enum RoutingError {
    #[error("no path found")]
    NoPath,
    #[error("origin waypoint not found in graph")]
    InvalidOrigin,
    #[error("destination waypoint not found in graph")]
    InvalidDestination,
}

/// Compute the shortest path between two node indices using the given profile.
Pub fn shortest_path(
    graph: &StableDiGraph<OswNode, OswEdge>,
    origin: NodeIndex,
    destination: NodeIndex,
    rules: &CostRules,
    args: &RuntimeArgs,
) -> Result<ShortestPathResult, RoutingError> {
    let (dist, prev) = dijkstra(graph, origin, Some(destination), rules, args);

    let dest_cost = dist.get(&destination).copied().ok_or(RoutingError::NoPath)?;

    // Reconstruct path by following prev pointers from destination to origin.
    let mut path_nodes: Vec<NodeIndex> = vec![destination];
    let mut cur = destination;
    while cur != origin {
        match prev.get(&cur) {
            Some(&(p, _)) => {
                path_nodes.push(p);
                cur = p;
            }
            None => return Err(RoutingError::NoPath),
        }
    }
    path_nodes.reverse();

    let mut edges = Vec::new();
    for window in path_nodes.windows(2) {
        let (u_idx, v_idx) = (window[0], window[1]);
        // Find the edge taken (the one stored in prev for v_idx).
        if let Some(&(_, Some(eidx))) = prev.get(&v_idx) {
            let edge = &graph[eidx];
            let cost = eval_cost(rules, &edge.attrs, args).unwrap_or(0.0);
            edges.push(PathEdge {
                edge_id: edge.id.clone(),
                u_id: graph[u_idx].id.clone(),
                v_id: graph[v_idx].id.clone(),
                cost,
                coords: edge.coords.clone(),
                attrs: edge.attrs.clone(),
            });
        }
    }

    Ok(ShortestPathResult {
        total_cost: dest_cost,
        edges,
    })
}

/// Compute the shortest path tree up to max_cost from origin.
Pub fn shortest_path_tree(
    graph: &StableDiGraph<OswNode, OswEdge>,
    origin: NodeIndex,
    max_cost: f64,
    rules: &CostRules,
    args: &RuntimeArgs,
) -> ShortestPathTreeResult {
    let (dist, prev) = dijkstra_bounded(graph, origin, max_cost, rules, args);

    let node_costs: HashMap<String, f64> = dist
        .iter()
        .map(|(idx, &cost)| (graph[*idx].id.clone(), cost))
        .collect();

    // Build paths by back-tracing prev pointers for each reachable node.
    let mut paths: HashMap<String, Vec<String>> = HashMap::new();
    let origin_id = graph[origin].id.clone();
    paths.insert(origin_id.clone(), vec![origin_id.clone()]);

    for &node_idx in dist.keys() {
        if node_idx == origin {
            continue;
        }
        let mut path_ids: Vec<String> = Vec::new();
        let mut cur = node_idx;
        loop {
            path_ids.push(graph[cur].id.clone());
            match prev.get(&cur).map(|&(p, _)| p) {
                Some(p) if p != origin => cur = p,
                Some(_) => {
                    path_ids.push(origin_id.clone());
                    break;
                }
                None => break,
            }
        }
        path_ids.reverse();
        paths.insert(graph[node_idx].id.clone(), path_ids);
    }

    // Collect all traversed edges.
    let mut seen_edges = std::collections::HashSet::new();
    let mut edges = Vec::new();
    for (&v_idx, &(u_idx, maybe_eidx)) in &prev {
        if let Some(eidx) = maybe_eidx {
            if seen_edges.insert(eidx) {
                let edge = &graph[eidx];
                let cost = eval_cost(rules, &edge.attrs, args).unwrap_or(0.0);
                edges.push(PathEdge {
                    edge_id: edge.id.clone(),
                    u_id: graph[u_idx].id.clone(),
                    v_id: graph[v_idx].id.clone(),
                    cost,
                    coords: edge.coords.clone(),
                    attrs: edge.attrs.clone(),
                });
            }
        }
    }

    ShortestPathTreeResult {
        node_costs,
        paths,
        edges,
    }
}

// ---------- internal Dijkstra ----------

/// Priority queue entry: (negative_cost, node_index). BinaryHeap is max-heap.
#[derive(PartialEq, Eq)]
struct HeapEntry(NotNan<f64>, NodeIndex);

impl PartialOrd for HeapEntry {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for HeapEntry {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        // Min-heap: negate cost so smallest cost has highest priority.
        other.0.cmp(&self.0)
    }
}

/// Dijkstra from `origin`, optionally stopping early at `target`.
/// Returns (dist, prev) where prev maps node → (predecessor_node, edge_index).
Fn dijkstra(
    graph: &StableDiGraph<OswNode, OswEdge>,
    origin: NodeIndex,
    target: Option<NodeIndex>,
    rules: &CostRules,
    args: &RuntimeArgs,
) -> (
    HashMap<NodeIndex, f64>,
    HashMap<NodeIndex, (NodeIndex, Option<EdgeIndex>)>,
) {
    let mut dist: HashMap<NodeIndex, f64> = HashMap::new();
    let mut prev: HashMap<NodeIndex, (NodeIndex, Option<EdgeIndex>)> = HashMap::new();
    let mut heap = BinaryHeap::new();

    dist.insert(origin, 0.0);
    heap.push(HeapEntry(NotNan::new(0.0).unwrap(), origin));

    while let Some(HeapEntry(cost_neg, u)) = heap.pop() {
        let cost_u = dist[&u]; // canonical distance (heap entry may be stale)

        if target == Some(u) {
            break;
        }

        if cost_neg > NotNan::new(dist[&u]).unwrap_or(NotNan::new(f64::MAX).unwrap()) {
            continue; // stale entry
        }

        for eidx in graph.edges(u).map(|e| e.id()) {
            let edge_ref = graph.edge_endpoints(eidx).unwrap();
            let v = edge_ref.1;
            let edge_data = &graph[eidx];

            if let Some(edge_cost) = eval_cost(rules, &edge_data.attrs, args) {
                let new_cost = cost_u + edge_cost;
                let best = dist.get(&v).copied().unwrap_or(f64::MAX);
                if new_cost < best {
                    dist.insert(v, new_cost);
                    prev.insert(v, (u, Some(eidx)));
                    if let Ok(nc) = NotNan::new(new_cost) {
                        heap.push(HeapEntry(nc, v));
                    }
                }
            }
        }
    }

    (dist, prev)
}

/// Dijkstra from `origin` with a cost cutoff (for path tree queries).
Fn dijkstra_bounded(
    graph: &StableDiGraph<OswNode, OswEdge>,
    origin: NodeIndex,
    max_cost: f64,
    rules: &CostRules,
    args: &RuntimeArgs,
) -> (
    HashMap<NodeIndex, f64>,
    HashMap<NodeIndex, (NodeIndex, Option<EdgeIndex>)>,
) {
    let mut dist: HashMap<NodeIndex, f64> = HashMap::new();
    let mut prev: HashMap<NodeIndex, (NodeIndex, Option<EdgeIndex>)> = HashMap::new();
    let mut heap = BinaryHeap::new();

    dist.insert(origin, 0.0);
    heap.push(HeapEntry(NotNan::new(0.0).unwrap(), origin));

    while let Some(HeapEntry(_, u)) = heap.pop() {
        let cost_u = dist[&u];

        for eidx in graph.edges(u).map(|e| e.id()) {
            let edge_ref = graph.edge_endpoints(eidx).unwrap();
            let v = edge_ref.1;
            let edge_data = &graph[eidx];

            if let Some(edge_cost) = eval_cost(rules, &edge_data.attrs, args) {
                let new_cost = cost_u + edge_cost;
                if new_cost > max_cost {
                    continue;
                }
                let best = dist.get(&v).copied().unwrap_or(f64::MAX);
                if new_cost < best {
                    dist.insert(v, new_cost);
                    prev.insert(v, (u, Some(eidx)));
                    if let Ok(nc) = NotNan::new(new_cost) {
                        heap.push(HeapEntry(nc, v));
                    }
                }
            }
        }
    }

    (dist, prev)
}
