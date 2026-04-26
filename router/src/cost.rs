//! Cost rule-tree evaluation.
//!
//! Given a CostRules, an edge's attributes, and the resolved runtime args,
//! this module computes the edge traversal cost (or None = impassable).
//!
//! Corresponds to Unweaver's cost_fun_generator pattern: the profile is
//! the "generator" (loaded once), and eval_cost() is the "cost_fun" (called
//! per edge during Dijkstra). See DECISIONS.md for why we use rule-trees
//! instead of arbitrary code.

use serde_json::Value;

use crate::profile::{CompOp, Condition, CostRules, EdgeAttrs, RuntimeArgs};

/// Evaluate the cost rule-tree for one edge.
///
/// Returns None if the edge is impassable under this profile+args.
/// Returns Some(cost) otherwise (cost is non-negative, in metres or
/// metre-equivalent weighted units).
pub fn eval_cost(rules: &CostRules, attrs: &EdgeAttrs, args: &RuntimeArgs) -> Option<f64> {
    // Step 1: impassability check
    for cond in &rules.impassable_if {
        if eval_condition(cond, attrs, args) {
            return None;
        }
    }

    // Step 2: base cost from named attribute
    let base = attrs
        .get(&rules.base)
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);

    if base <= 0.0 {
        // Zero-length edges are passable at zero cost (e.g. injected snap nodes).
        return Some(0.0);
    }

    // Step 3: apply multipliers
    let cost = rules.multipliers.iter().fold(base, |acc, m| {
        if eval_condition(&m.condition, attrs, args) {
            acc * m.multiply
        } else {
            acc
        }
    });

    Some(cost)
}

/// Evaluate a Condition recursively.
fn eval_condition(cond: &Condition, attrs: &EdgeAttrs, args: &RuntimeArgs) -> bool {
    match cond {
        Condition::All { all } => all.iter().all(|c| eval_condition(c, attrs, args)),
        Condition::Any { any } => any.iter().any(|c| eval_condition(c, attrs, args)),

        Condition::AttrVsParam { attr, op, param } => {
            let lhs = attrs.get(attr);
            let rhs = args.get(param);
            match (lhs, rhs) {
                (Some(l), Some(r)) => compare(l, *op, r),
                _ => false,
            }
        }

        Condition::AttrVsValue { attr, op, value } => {
            let lhs = attrs.get(attr);
            match lhs {
                Some(l) => compare(l, *op, value),
                None => false,
            }
        }

        Condition::ParamVsValue { param, op, value } => {
            let lhs = args.get(param);
            match lhs {
                Some(l) => compare(l, *op, value),
                None => false,
            }
        }
    }
}

/// Compare two JSON Values with a CompOp.
fn compare(lhs: &Value, op: CompOp, rhs: &Value) -> bool {
    match op {
        CompOp::Eq => json_eq(lhs, rhs),
        CompOp::Ne => !json_eq(lhs, rhs),
        CompOp::Gt => float_cmp(lhs, rhs).map(|o| o > 0).unwrap_or(false),
        CompOp::Gte => float_cmp(lhs, rhs).map(|o| o >= 0).unwrap_or(false),
        CompOp::Lt => float_cmp(lhs, rhs).map(|o| o < 0).unwrap_or(false),
        CompOp::Lte => float_cmp(lhs, rhs).map(|o| o <= 0).unwrap_or(false),
        CompOp::In => match rhs {
            Value::Array(arr) => arr.iter().any(|item| json_eq(lhs, item)),
            _ => false,
        },
        CompOp::NotIn => match rhs {
            Value::Array(arr) => !arr.iter().any(|item| json_eq(lhs, item)),
            _ => true,
        },
    }
}

fn json_eq(a: &Value, b: &Value) -> bool {
    // String comparison is case-insensitive for OSW attribute values
    // (OSM tags are lowercase by convention, but be defensive).
    match (a, b) {
        (Value::String(sa), Value::String(sb)) => sa.to_lowercase() == sb.to_lowercase(),
        _ => a == b,
    }
}

/// Returns Some(sign) where sign < 0 means lhs < rhs, 0 means equal, > 0 means lhs > rhs.
fn float_cmp(a: &Value, b: &Value) -> Option<i8> {
    let fa = a.as_f64()?;
    let fb = b.as_f64()?;
    if (fa - fb).abs() < f64::EPSILON {
        Some(0)
    } else if fa < fb {
        Some(-1)
    } else {
        Some(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::Profile;
    use serde_json::json;
    use std::collections::HashMap;

    fn make_edge(attrs: serde_json::Map<String, Value>) -> EdgeAttrs {
        attrs.into_iter().collect()
    }

    #[test]
    fn generic_pedestrian_always_passable() {
        let profile_json = include_str!("../examples/profile-generic_pedestrian.json");
        let profile = Profile::from_json(profile_json).unwrap();
        let attrs = make_edge(serde_json::from_str(r#"{"length": 50.0, "incline": 0.3}"#).unwrap());
        let args = HashMap::new();
        let cost = eval_cost(&profile.cost, &attrs, &args);
        assert_eq!(cost, Some(50.0));
    }

    #[test]
    fn wheelchair_blocked_by_steep_uphill() {
        let profile_json = include_str!("../examples/profile-manual_wheelchair.json");
        let profile = Profile::from_json(profile_json).unwrap();
        let attrs = make_edge(
            serde_json::from_str(r#"{"length": 30.0, "incline": 0.15, "footway": "sidewalk"}"#)
                .unwrap(),
        );
        // Default uphill_max is 0.0833 (~5%); incline 0.15 > 0.0833 → impassable
        let args = profile.resolve_args(HashMap::new()).unwrap();
        let cost = eval_cost(&profile.cost, &attrs, &args);
        assert_eq!(cost, None, "steep uphill should be impassable for wheelchair");
    }

    #[test]
    fn wheelchair_passable_on_gentle_grade() {
        let profile_json = include_str!("../examples/profile-manual_wheelchair.json");
        let profile = Profile::from_json(profile_json).unwrap();
        let attrs = make_edge(
            serde_json::from_str(r#"{"length": 30.0, "incline": 0.03, "footway": "sidewalk"}"#)
                .unwrap(),
        );
        let args = profile.resolve_args(HashMap::new()).unwrap();
        let cost = eval_cost(&profile.cost, &attrs, &args);
        assert!(cost.is_some(), "gentle grade should be passable");
    }

    #[test]
    fn wheelchair_blocked_at_crossing_without_curbramps() {
        let profile_json = include_str!("../examples/profile-manual_wheelchair.json");
        let profile = Profile::from_json(profile_json).unwrap();
        let attrs = make_edge(
            serde_json::from_str(
                r#"{"length": 10.0, "incline": 0.0, "footway": "crossing", "curbramps": false}"#,
            )
            .unwrap(),
        );
        // avoid_curbs=true and footway=crossing and curbramps=false → impassable
        let args = profile
            .resolve_args(
                [("avoid_curbs".to_owned(), json!(true))]
                    .into_iter()
                    .collect(),
            )
            .unwrap();
        let cost = eval_cost(&profile.cost, &attrs, &args);
        assert_eq!(cost, None, "crossing without curb ramp should be impassable when avoid_curbs=true");
    }

    #[test]
    fn wheelchair_passable_at_crossing_with_curbramps() {
        let profile_json = include_str!("../examples/profile-manual_wheelchair.json");
        let profile = Profile::from_json(profile_json).unwrap();
        let attrs = make_edge(
            serde_json::from_str(
                r#"{"length": 10.0, "incline": 0.0, "footway": "crossing", "curbramps": true}"#,
            )
            .unwrap(),
        );
        let args = profile
            .resolve_args(
                [("avoid_curbs".to_owned(), json!(true))]
                    .into_iter()
                    .collect(),
            )
            .unwrap();
        let cost = eval_cost(&profile.cost, &attrs, &args);
        assert!(cost.is_some(), "crossing WITH curb ramp should be passable");
    }

    #[test]
    fn low_vision_blocked_on_gravel() {
        let profile_json = include_str!("../examples/profile-low_vision.json");
        let profile = Profile::from_json(profile_json).unwrap();
        let attrs = make_edge(
            serde_json::from_str(r#"{"length": 20.0, "surface": "gravel"}"#).unwrap(),
        );
        // avoid_unpaved=true (default) + surface=gravel → impassable
        let args = profile.resolve_args(HashMap::new()).unwrap();
        let cost = eval_cost(&profile.cost, &attrs, &args);
        assert_eq!(cost, None, "gravel should be impassable for low_vision with avoid_unpaved=true");
    }

    #[test]
    fn low_vision_cobblestone_penalised() {
        let profile_json = include_str!("../examples/profile-low_vision.json");
        let profile = Profile::from_json(profile_json).unwrap();
        let attrs = make_edge(
            serde_json::from_str(r#"{"length": 20.0, "surface": "cobblestone"}"#).unwrap(),
        );
        let args = profile.resolve_args(HashMap::new()).unwrap();
        let cost = eval_cost(&profile.cost, &attrs, &args).unwrap();
        assert!(cost > 20.0, "cobblestone should have penalty applied");
    }
}
