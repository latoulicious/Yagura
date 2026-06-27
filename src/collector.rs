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

/// A source of metric samples; the seam for future multi-host collectors.
// Single impl (DockerCollector) for now; the trait is the boundary a
// remote/scrape collector would plug into if multi-host ever arrives.
pub trait Collector {
    async fn collect(&self) -> Vec<Sample>;
}

/// Unix epoch seconds. Clock-skew before 1970 collapses to 0.
pub fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
