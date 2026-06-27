mod api;
mod collector;
mod db;
mod docker;

use crate::collector::{Collector, Sample};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;

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

    spawn_collector(docker.clone(), writer, events.clone());

    let app = api::router(api::AppState {
        docker,
        db_read,
        events,
    });
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("yagura listening on {bind}");
    axum::serve(listener, app).await?;
    Ok(())
}

/// Tick loop: collect each interval, fan every sample to the writer + broadcast.
fn spawn_collector(
    docker: Arc<docker::DockerCollector>,
    writer: tokio::sync::mpsc::Sender<Sample>,
    events: broadcast::Sender<Sample>,
) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(TICK_SECS));
        loop {
            tick.tick().await;
            for s in docker.collect().await {
                // Live fan-out first so SSE never waits on the DB write.
                let _ = events.send(s.clone());
                if let Err(e) = writer.send(s).await {
                    tracing::warn!("sample write dropped: {e}");
                }
            }
        }
    });
}
