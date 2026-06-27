use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

/// One metric point — one row in the `samples` table.
#[derive(Debug, Clone, Serialize)]
pub struct Sample {
    pub ts: i64,
    pub source: String,
    pub metric: String,
    pub value: f64,
}

/// One probe outcome. `target` rides along for alert labelling; only ts/check_id/
/// up/latency_ms are persisted to `check_results`.
#[derive(Debug, Clone)]
pub struct CheckResult {
    pub ts: i64,
    pub check_id: i64,
    pub target: String,
    pub up: bool,
    pub latency_ms: Option<i64>,
}

/// A source of collected data; the seam for future multi-host collectors.
// `Out` lets one trait cover both metric Samples (docker) and CheckResults
// (probes) without forcing probe data into the Sample shape.
pub trait Collector {
    type Out;
    async fn collect(&self) -> Vec<Self::Out>;
}

/// Unix epoch seconds. Clock-skew before 1970 collapses to 0.
pub fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
