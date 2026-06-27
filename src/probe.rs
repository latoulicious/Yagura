use crate::collector::{CheckResult, Collector, now_ts};
use crate::db::{self, Check};
use rusqlite::Connection;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::net::TcpStream;

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Runs HTTP/TCP probes on a per-check schedule. The 5s collector tick is the
/// granularity; each check fires when `interval_s` has elapsed since its last run.
pub struct ProbeCollector {
    client: reqwest::Client,
    conn: Mutex<Connection>,
    last_run: Mutex<HashMap<i64, i64>>,
}

impl ProbeCollector {
    pub fn new(client: reqwest::Client, conn: Connection) -> Self {
        Self {
            client,
            conn: Mutex::new(conn),
            last_run: Mutex::new(HashMap::new()),
        }
    }

    /// Enabled checks whose interval has elapsed. Locks are dropped before any
    /// `.await`, so the returned future stays `Send`.
    fn due(&self, now: i64) -> Vec<Check> {
        let checks = {
            let conn = self.conn.lock().unwrap();
            match db::enabled_checks(&conn) {
                Ok(c) => c,
                Err(e) => {
                    tracing::warn!("check list failed: {e}");
                    return Vec::new();
                }
            }
        };
        let last = self.last_run.lock().unwrap();
        checks
            .into_iter()
            .filter(|c| now - last.get(&c.id).copied().unwrap_or(0) >= c.interval_s)
            .collect()
    }

    async fn probe(&self, c: &Check, ts: i64) -> CheckResult {
        let (up, latency_ms) = match c.kind.as_str() {
            "http" => self.probe_http(&c.target).await,
            "tcp" => probe_tcp(&c.target).await,
            other => {
                tracing::warn!("check {} has unknown kind {other}", c.id);
                (false, None)
            }
        };
        CheckResult {
            ts,
            check_id: c.id,
            target: c.target.clone(),
            up,
            latency_ms,
        }
    }

    /// HTTP probe: any response under 400 is up; connect/timeout error is down.
    async fn probe_http(&self, target: &str) -> (bool, Option<i64>) {
        let start = Instant::now();
        match self.client.get(target).timeout(PROBE_TIMEOUT).send().await {
            Ok(resp) => (
                resp.status().as_u16() < 400,
                Some(start.elapsed().as_millis() as i64),
            ),
            Err(_) => (false, None),
        }
    }
}

/// TCP probe: a successful connect within the timeout is up.
async fn probe_tcp(target: &str) -> (bool, Option<i64>) {
    let start = Instant::now();
    match tokio::time::timeout(PROBE_TIMEOUT, TcpStream::connect(target)).await {
        Ok(Ok(_)) => (true, Some(start.elapsed().as_millis() as i64)),
        _ => (false, None),
    }
}

impl Collector for ProbeCollector {
    type Out = CheckResult;

    async fn collect(&self) -> Vec<CheckResult> {
        let now = now_ts();
        let due = self.due(now);
        if due.is_empty() {
            return Vec::new();
        }
        // Probe due checks concurrently so one slow target can't delay the rest.
        let results = futures_util::future::join_all(due.iter().map(|c| self.probe(c, now))).await;
        let mut last = self.last_run.lock().unwrap();
        for c in &due {
            last.insert(c.id, now);
        }
        results
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn tcp_probe_up_when_listening_down_when_closed() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();

        let (up, latency) = probe_tcp(&addr).await;
        assert!(up);
        assert!(latency.is_some());

        drop(listener); // port now refuses connections
        let (up, latency) = probe_tcp(&addr).await;
        assert!(!up);
        assert!(latency.is_none());
    }
}
