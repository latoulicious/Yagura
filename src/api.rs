use crate::collector::Sample;
use crate::db;
use crate::docker::DockerCollector;
use axum::extract::{Path, State};
use axum::http::{StatusCode, Uri, header};
use axum::response::IntoResponse;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::{Stream, StreamExt};
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;

const KEEPALIVE_SECS: u64 = 15;

#[derive(Clone)]
pub struct AppState {
    pub docker: Arc<DockerCollector>,
    // One read conn behind a Mutex, queried in spawn_blocking; a pool only if
    // read concurrency ever matters (it won't at this traffic level).
    pub db_read: Arc<Mutex<Connection>>,
    pub events: broadcast::Sender<Sample>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/overview", get(overview))
        .route("/api/logs/{id}", get(logs))
        .route("/api/stream", get(stream))
        .fallback(static_handler)
        .with_state(state)
}

#[derive(Serialize)]
struct ContainerRow {
    id: String,
    name: String,
    state: String,
    status: String,
    cpu: Option<f64>,
    mem: Option<f64>,
    mem_limit: Option<f64>,
}

/// Container grid: bollard list merged with the latest persisted cpu/ram.
async fn overview(State(st): State<AppState>) -> Result<impl IntoResponse, StatusCode> {
    let containers = st
        .docker
        .list()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let db = st.db_read.clone();
    let latest = tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        db::latest_samples(&conn).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)??;

    let mut map: HashMap<(String, String), f64> = HashMap::new();
    for s in latest {
        map.insert((s.source, s.metric), s.value);
    }

    let rows: Vec<ContainerRow> = containers
        .into_iter()
        .map(|c| {
            let g = |m: &str| map.get(&(c.id.clone(), m.to_string())).copied();
            ContainerRow {
                cpu: g("cpu"),
                mem: g("mem"),
                mem_limit: g("mem_limit"),
                id: c.id,
                name: c.name,
                state: c.state,
                status: c.status,
            }
        })
        .collect();

    Ok(Json(serde_json::json!({ "containers": rows })))
}

/// SSE: live log stream for one container.
async fn logs(
    Path(id): Path<String>,
    State(st): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let docker = st.docker.clone();
    let body = async_stream::stream! {
        let lines = docker.follow_logs(&id);
        futures_util::pin_mut!(lines);
        while let Some(line) = lines.next().await {
            yield Ok(Event::default().data(line));
        }
    };
    Sse::new(body).keep_alive(KeepAlive::new().interval(Duration::from_secs(KEEPALIVE_SECS)))
}

/// SSE: live metric samples fanned out from the broadcast channel.
async fn stream(State(st): State<AppState>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let body = BroadcastStream::new(st.events.subscribe()).filter_map(|res| async move {
        let sample = res.ok()?;
        let json = serde_json::to_string(&sample).ok()?;
        Some(Ok(Event::default().data(json)))
    });
    Sse::new(body).keep_alive(KeepAlive::new().interval(Duration::from_secs(KEEPALIVE_SECS)))
}

#[derive(rust_embed::RustEmbed)]
#[folder = "web/dist"]
struct Assets;

/// Serve an embedded asset by path; fall back to index.html for SPA routes only.
/// Unknown API paths and missing assets get a real 404, not the HTML shell.
async fn static_handler(uri: Uri) -> impl IntoResponse {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    if let Some(asset) = Assets::get(path) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        return (
            [(header::CONTENT_TYPE, mime.to_string())],
            asset.data.into_owned(),
        )
            .into_response();
    }
    let looks_like_asset = path.rsplit('/').next().is_some_and(|seg| seg.contains('.'));
    if path.starts_with("api/") || looks_like_asset {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    }
    match Assets::get("index.html") {
        Some(asset) => (
            [(header::CONTENT_TYPE, "text/html".to_string())],
            asset.data.into_owned(),
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}
