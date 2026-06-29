mod agent;
mod alert;
mod api;
mod beat;
mod collector;
mod db;
mod docker;
mod drift;
mod host;
mod probe;
mod version;

use crate::collector::{Collector, Sample};
use futures_util::StreamExt;
use std::io::IsTerminal;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc};

const TICK_SECS: u64 = 5;
// Docker event stream can end on a daemon restart; wait this long before resubscribing.
const EVENTS_RECONNECT_SECS: u64 = 5;
// Routes change rarely; a 30s drift sweep is plenty and keeps the TCP probes cheap.
const DRIFT_TICK_SECS: u64 = 30;
// Heartbeat deadlines are minutes-to-hours; a 60s deadman scan is fine-grained enough.
const BEAT_TICK_SECS: u64 = 60;
// Deploys are infrequent; poll each service /version once a minute.
const VERSION_TICK_SECS: u64 = 60;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Color only on an interactive terminal; plain text under docker logs/journald
    // so the ANSI escapes don't litter piped or copied output.
    tracing_subscriber::fmt()
        .with_ansi(std::io::stderr().is_terminal())
        .init();

    let bind = std::env::var("YAGURA_BIND").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let db_path = std::env::var("YAGURA_DB").unwrap_or_else(|_| "yagura.db".into());
    // Localhost Tsugi agent (its TSUGI_AGENT_ADDR). Lazy dial — fine if it's not up yet.
    let tsugi_addr =
        std::env::var("YAGURA_TSUGI_ADDR").unwrap_or_else(|_| "http://127.0.0.1:8091".into());

    let writer = db::spawn_writer(&db_path)?;
    let db_read = Arc::new(Mutex::new(db::open_read(&db_path)?));
    let (events, _) = broadcast::channel::<Sample>(256);
    let docker = Arc::new(docker::DockerCollector::connect()?);
    let host = Arc::new(host::HostCollector::new());
    let http = reqwest::Client::builder().build()?;

    let thresholds = alert::spawn_thresholds(http.clone());
    spawn_collector(docker.clone(), host, writer.clone(), events.clone(), thresholds);
    spawn_docker_events(docker.clone(), writer.clone());

    let alerts = alert::spawn(http.clone());
    let prober = Arc::new(probe::ProbeCollector::new(http.clone(), db::open_read(&db_path)?));
    spawn_prober(prober, writer.clone(), events.clone(), alerts);

    let drift_state = Arc::new(Mutex::new(Vec::<drift::Route>::new()));
    let status_alerts = alert::spawn_status(http.clone());
    spawn_drift(drift::DriftCollector::new(), drift_state.clone(), status_alerts.clone());

    let beats = Arc::new(beat::registry());
    spawn_beats(beats.clone(), Mutex::new(db::open_read(&db_path)?), status_alerts);

    let versions_state = Arc::new(Mutex::new(Vec::<version::VersionStatus>::new()));
    spawn_versions(version::VersionCollector::new(http), versions_state.clone());

    let tsugi = agent::TsugiClient::connect(tsugi_addr)?;

    let app = api::router(api::AppState {
        docker,
        db_read,
        events,
        db_write: writer,
        drift: drift_state,
        beats,
        versions: versions_state,
        tsugi,
    });
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("yagura listening on {bind}");
    axum::serve(listener, app).await?;
    Ok(())
}

/// Tick loop: collect docker + host each interval, fan every sample to the writer
/// + broadcast, and feed host disk/ram into the threshold alerter.
fn spawn_collector(
    docker: Arc<docker::DockerCollector>,
    host: Arc<host::HostCollector>,
    writer: mpsc::Sender<db::DbMsg>,
    events: broadcast::Sender<Sample>,
    thresholds: mpsc::Sender<alert::ThresholdReading>,
) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(TICK_SECS));
        loop {
            tick.tick().await;
            for s in docker.collect().await {
                fan(&events, &writer, s).await;
            }
            let host_samples = host.collect().await;
            send_thresholds(&thresholds, &host_samples).await;
            for s in host_samples {
                fan(&events, &writer, s).await;
            }
        }
    });
}

/// Subscribe to the Docker daemon event stream and persist container lifecycle
/// events (start/die/restart/oom/health) for the overview feed. The stream ends on a
/// daemon restart, so resubscribe after a short backoff — the feed self-heals.
fn spawn_docker_events(docker: Arc<docker::DockerCollector>, writer: mpsc::Sender<db::DbMsg>) {
    tokio::spawn(async move {
        loop {
            {
                let stream = docker.events();
                futures_util::pin_mut!(stream);
                while let Some(ev) = stream.next().await {
                    if writer.send(db::DbMsg::Event(ev)).await.is_err() {
                        return; // writer gone → app shutting down
                    }
                }
            }
            tracing::warn!("docker event stream ended; reconnecting in {EVENTS_RECONNECT_SECS}s");
            tokio::time::sleep(Duration::from_secs(EVENTS_RECONNECT_SECS)).await;
        }
    });
}

/// One sample out: broadcast first so SSE never waits on the DB write.
async fn fan(events: &broadcast::Sender<Sample>, writer: &mpsc::Sender<db::DbMsg>, s: Sample) {
    let _ = events.send(s.clone());
    if let Err(e) = writer.send(db::DbMsg::Sample(s)).await {
        tracing::warn!("sample write dropped: {e}");
    }
}

/// Derive disk%/ram% from this tick's host samples and feed the threshold alerter.
async fn send_thresholds(tx: &mpsc::Sender<alert::ThresholdReading>, samples: &[Sample]) {
    let Some(ts) = samples.first().map(|s| s.ts) else {
        return;
    };
    let v = |metric: &str| samples.iter().find(|s| s.metric == metric).map(|s| s.value);
    let reading = |key, used: Option<f64>, total: Option<f64>, limit| match (used, total) {
        (Some(u), Some(t)) => Some(alert::ThresholdReading {
            key,
            pct: host::pct(u, t),
            limit,
            ts,
        }),
        _ => None,
    };
    let readings = [
        reading("disk", v("disk_used"), v("disk_total"), alert::DISK_LIMIT_PCT),
        reading("ram", v("mem_used"), v("mem_total"), alert::RAM_LIMIT_PCT),
    ];
    for r in readings.into_iter().flatten() {
        let _ = tx.send(r).await;
    }
}

/// Drift tick loop: sweep cloudflared routes, publish each route's up/down to the
/// status alerter (orphan = one alert), and stash the latest set for the API.
fn spawn_drift(
    collector: drift::DriftCollector,
    state: Arc<Mutex<Vec<drift::Route>>>,
    alerts: mpsc::Sender<alert::StatusEvent>,
) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(DRIFT_TICK_SECS));
        loop {
            tick.tick().await;
            let routes = collector.check().await;
            for r in &routes {
                let _ = alerts
                    .send(alert::StatusEvent {
                        key: format!("route:{}", r.hostname),
                        up: r.up,
                        ts: r.ts,
                        label: format!("{} → {}", r.hostname, r.target),
                        kind: "route",
                    })
                    .await;
            }
            *state.lock().unwrap() = routes;
        }
    });
}

/// Deadman loop: each tick, flag any expected beat whose last check-in is older than
/// its deadline (or never seen) and feed it to the status alerter (debounced).
fn spawn_beats(
    registry: Arc<Vec<beat::BeatSpec>>,
    conn: Mutex<rusqlite::Connection>,
    alerts: mpsc::Sender<alert::StatusEvent>,
) {
    if registry.is_empty() {
        return; // no expected beats configured → no deadman task
    }
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(BEAT_TICK_SECS));
        loop {
            tick.tick().await;
            let last = {
                let c = conn.lock().unwrap();
                match db::list_beats(&c) {
                    Ok(last) => last,
                    // A read failure must not look like "all beats missing" → skip the tick.
                    Err(e) => {
                        tracing::warn!("beat scan skipped: {e}");
                        continue;
                    }
                }
            };
            let now = collector::now_ts();
            for spec in registry.iter() {
                let missing = last
                    .get(&spec.name)
                    .is_none_or(|&ts| now - ts > spec.deadline_s);
                let _ = alerts
                    .send(alert::StatusEvent {
                        key: format!("beat:{}", spec.name),
                        up: !missing,
                        ts: now,
                        label: spec.name.clone(),
                        kind: "beat",
                    })
                    .await;
            }
        }
    });
}

/// Version poll loop: poll each service `/version` and stash the latest set for the
/// API. No-op when nothing is configured.
fn spawn_versions(
    collector: version::VersionCollector,
    state: Arc<Mutex<Vec<version::VersionStatus>>>,
) {
    if collector.is_empty() {
        return;
    }
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(VERSION_TICK_SECS));
        loop {
            tick.tick().await;
            let v = collector.check().await;
            *state.lock().unwrap() = v;
        }
    });
}

/// Probe tick loop: each result fans out live (as `check:<id>` samples), to the
/// alerter, then to the writer.
fn spawn_prober(
    prober: Arc<probe::ProbeCollector>,
    writer: mpsc::Sender<db::DbMsg>,
    events: broadcast::Sender<Sample>,
    alerts: mpsc::Sender<collector::CheckResult>,
) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(TICK_SECS));
        loop {
            tick.tick().await;
            for r in prober.collect().await {
                let src = format!("check:{}", r.check_id);
                let _ = events.send(Sample {
                    ts: r.ts,
                    source: src.clone(),
                    metric: "up".into(),
                    value: r.up as i64 as f64,
                });
                if let Some(ms) = r.latency_ms {
                    let _ = events.send(Sample {
                        ts: r.ts,
                        source: src,
                        metric: "latency_ms".into(),
                        value: ms as f64,
                    });
                }
                let _ = alerts.send(r.clone()).await;
                if let Err(e) = writer.send(db::DbMsg::Result(r)).await {
                    tracing::warn!("check result write dropped: {e}");
                }
            }
        }
    });
}
