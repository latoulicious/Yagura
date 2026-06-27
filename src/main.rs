mod alert;
mod api;
mod collector;
mod db;
mod docker;
mod probe;

use crate::collector::{Collector, Sample};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc};

const TICK_SECS: u64 = 5;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let bind = std::env::var("YAGURA_BIND").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let db_path = std::env::var("YAGURA_DB").unwrap_or_else(|_| "yagura.db".into());

    let writer = db::spawn_writer(&db_path)?;
    let db_read = Arc::new(Mutex::new(db::open_read(&db_path)?));
    let (events, _) = broadcast::channel::<Sample>(256);
    let docker = Arc::new(docker::DockerCollector::connect()?);
    let http = reqwest::Client::builder().build()?;

    spawn_collector(docker.clone(), writer.clone(), events.clone());

    let alerts = alert::spawn(http.clone());
    let prober = Arc::new(probe::ProbeCollector::new(http, db::open_read(&db_path)?));
    spawn_prober(prober, writer.clone(), events.clone(), alerts);

    let app = api::router(api::AppState {
        docker,
        db_read,
        events,
        db_write: writer,
    });
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("yagura listening on {bind}");
    axum::serve(listener, app).await?;
    Ok(())
}

/// Tick loop: collect each interval, fan every sample to the writer + broadcast.
fn spawn_collector(
    docker: Arc<docker::DockerCollector>,
    writer: mpsc::Sender<db::DbMsg>,
    events: broadcast::Sender<Sample>,
) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(TICK_SECS));
        loop {
            tick.tick().await;
            for s in docker.collect().await {
                // Live fan-out first so SSE never waits on the DB write.
                let _ = events.send(s.clone());
                if let Err(e) = writer.send(db::DbMsg::Sample(s)).await {
                    tracing::warn!("sample write dropped: {e}");
                }
            }
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
