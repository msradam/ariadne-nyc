//! unweaver-wasm: WebAssembly port of Unweaver's profile-based routing pattern.
//!
//! See README.md for the full mission statement and DECISIONS.md for architectural choices.
//!
//! Exposed JS API:
//!   Router.fromOSWGeoJSON(geojson: string) -> Router
//!   router.addProfile(id: string, profileJson: string)
//!   router.shortestPath(profileId, [lat,lon], [lat,lon]) -> RouteResult
//!   router.shortestPathTree(profileId, [lat,lon], maxCost) -> TreeResult
//!   router.shortestPathJSON(profileId, [lat,lon], [lat,lon]) -> string (Unweaver-compatible JSON)

use wasm_bindgen::prelude::*;

mod api;
pub mod cost;
pub mod graph;
pub mod profile;
pub mod routing;

pub use api::Router;
pub use graph::OswGraph;
pub use profile::Profile;

#[wasm_bindgen(start)]
pub fn main() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}
