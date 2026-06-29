use crate::agent;
use crate::beat;
use crate::collector::{Sample, now_ts};
use crate::db;
use crate::docker::DockerCollector;
use crate::drift;
use crate::version;
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, Uri, header};
use axum::response::IntoResponse;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use futures_util::{Stream, StreamExt};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc};
use tokio_stream::wrappers::BroadcastStream;

const KEEPALIVE_SECS: u64 = 15;
// Overview event feed: how far back to look and how many to show per container.
const EVENTS_WINDOW_SECS: i64 = 24 * 3600;
const EVENTS_PER_CONTAINER: usize = 3;

#[derive(Clone)]
pub struct AppState {
    pub docker: Arc<DockerCollector>,
    // One read conn behind a Mutex, queried in spawn_blocking; a pool only if
    // read concurrency ever matters (it won't at this traffic level).
    pub db_read: Arc<Mutex<Connection>>,
    pub events: broadcast::Sender<Sample>,
    pub db_write: mpsc::Sender<db::DbMsg>,
    // Latest route-drift sweep, refreshed by the drift ticker.
    pub drift: Arc<Mutex<Vec<drift::Route>>>,
    // Expected heartbeats (registry), joined with last-seen at request time.
    pub beats: Arc<Vec<beat::BeatSpec>>,
    // Latest per-service version poll, refreshed by the version ticker.
    pub versions: Arc<Mutex<Vec<version::VersionStatus>>>,
    // gRPC client to the localhost Tsugi agent — release history.
    pub tsugi: agent::TsugiClient,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/overview", get(overview))
        .route("/api/logs/{id}", get(logs))
        .route("/api/stream", get(stream))
        .route("/api/checks", get(checks_list).post(checks_create))
        .route("/api/checks/{id}", delete(checks_delete))
        .route("/api/checks/{id}/history", get(checks_history))
        .route("/api/host/history", get(host_history))
        .route("/api/drift", get(drift_list))
        .route("/api/beats", get(beats_list))
        .route("/api/versions", get(versions_list))
        .route("/api/releases", get(releases_list))
        .route("/beat/{name}", post(beat))
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
    created: i64,
    // Recent lifecycle events (start/die/restart/…), newest-first.
    events: Vec<db::EventRow>,
}

/// Container grid: bollard list merged with the latest persisted cpu/ram.
async fn overview(State(st): State<AppState>) -> Result<impl IntoResponse, StatusCode> {
    let containers = st
        .docker
        .list()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let db = st.db_read.clone();
    let (latest, mut events) = tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let latest = db::latest_samples(&conn).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        let cutoff = now_ts() - EVENTS_WINDOW_SECS;
        let events = db::recent_events(&conn, cutoff, EVENTS_PER_CONTAINER)
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        Ok::<_, StatusCode>((latest, events))
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
                events: events.remove(&c.id).unwrap_or_default(),
                id: c.id,
                name: c.name,
                state: c.state,
                status: c.status,
                created: c.created,
            }
        })
        .collect();

    // Single-host: one name for the whole grid (frontend renders it per row).
    // From the Docker daemon, not sysinfo — Yagura runs in a container.
    let host = st.docker.host_name().await.unwrap_or_default();
    Ok(Json(serde_json::json!({ "host": host, "containers": rows })))
}

/// Latest route-drift sweep — each cloudflared route and whether a listener answers.
async fn drift_list(State(st): State<AppState>) -> Result<impl IntoResponse, StatusCode> {
    let routes = st
        .drift
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .clone();
    Ok(Json(routes))
}

/// Latest per-service version/commit poll.
async fn versions_list(State(st): State<AppState>) -> Result<impl IntoResponse, StatusCode> {
    let versions = st
        .versions
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .clone();
    Ok(Json(versions))
}

/// Release-per-env list from the Tsugi agent. A gRPC error — agent down or the RPC
/// unimplemented — returns `ok:false` (HTTP 200) so the tab shows an "unreachable" empty
/// state instead of failing the fetch. Calm-until-broken.
async fn releases_list(State(st): State<AppState>) -> impl IntoResponse {
    match st.tsugi.list_releases().await {
        Ok(releases) => Json(serde_json::json!({ "ok": true, "releases": releases })),
        Err(status) => Json(serde_json::json!({
            "ok": false,
            "releases": [],
            "reason": format!("{:?}", status.code()),
        })),
    }
}

/// Heartbeat ingest — a registered job checks in; stamp receipt time for the deadman.
/// Unknown names are rejected so the table can't grow unbounded from the tunnel.
async fn beat(State(st): State<AppState>, Path(name): Path<String>) -> StatusCode {
    if !st.beats.iter().any(|spec| spec.name == name) {
        return StatusCode::NOT_FOUND;
    }
    match st.db_write.send(db::DbMsg::Beat(name, now_ts())).await {
        Ok(_) => StatusCode::NO_CONTENT,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// Expected heartbeats joined with last-seen + whether each is overdue.
async fn beats_list(State(st): State<AppState>) -> Result<impl IntoResponse, StatusCode> {
    let db = st.db_read.clone();
    let last = tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        db::list_beats(&conn).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)??;

    let now = now_ts();
    let out: Vec<_> = st
        .beats
        .iter()
        .map(|s| {
            let last_ts = last.get(&s.name).copied();
            serde_json::json!({
                "name": s.name,
                "deadline_s": s.deadline_s,
                "last_ts": last_ts,
                "missing": last_ts.is_none_or(|ts| now - ts > s.deadline_s),
            })
        })
        .collect();
    Ok(Json(out))
}

/// Host sparkline seed: recent samples per metric (`{ cpu:[{ts,value}…], … }`), one
/// request for every section so the Overview tab doesn't fan out N polls.
async fn host_history(State(st): State<AppState>) -> Result<impl IntoResponse, StatusCode> {
    let db = st.db_read.clone();
    let pts = tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        db::host_history(&conn).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)??;

    let mut out: HashMap<String, Vec<serde_json::Value>> = HashMap::new();
    for p in pts {
        out.entry(p.metric)
            .or_default()
            .push(serde_json::json!({ "ts": p.ts, "value": p.value }));
    }
    Ok(Json(out))
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

/// Probe list: each check merged with its latest result + last-down time.
async fn checks_list(State(st): State<AppState>) -> Result<impl IntoResponse, StatusCode> {
    let db = st.db_read.clone();
    let rows = tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        db::list_checks(&conn).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)??;
    Ok(Json(rows))
}

#[derive(Deserialize)]
struct NewCheckReq {
    kind: String,
    target: String,
    interval_s: i64,
    enabled: Option<bool>,
}

/// Create a probe. Validates kind/target/interval at the trust boundary.
async fn checks_create(
    State(st): State<AppState>,
    Json(req): Json<NewCheckReq>,
) -> Result<impl IntoResponse, StatusCode> {
    if !matches!(req.kind.as_str(), "http" | "tcp")
        || req.target.trim().is_empty()
        || req.interval_s < 5
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let new = db::NewCheck {
        kind: req.kind,
        target: req.target.trim().to_string(),
        interval_s: req.interval_s,
        enabled: req.enabled.unwrap_or(true),
    };
    let id = db::add_check(&st.db_write, new)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok((StatusCode::CREATED, Json(serde_json::json!({ "id": id }))))
}

/// Delete a probe; 404 when nothing matched.
async fn checks_delete(Path(id): Path<i64>, State(st): State<AppState>) -> StatusCode {
    match db::del_check(&st.db_write, id).await {
        Ok(0) => StatusCode::NOT_FOUND,
        Ok(_) => StatusCode::NO_CONTENT,
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

#[derive(Deserialize)]
struct HistoryQ {
    limit: Option<i64>,
}

/// Recent results for one probe, oldest-first — the sparkline source.
async fn checks_history(
    Path(id): Path<i64>,
    Query(q): Query<HistoryQ>,
    State(st): State<AppState>,
) -> Result<impl IntoResponse, StatusCode> {
    let limit = q.limit.unwrap_or(100).clamp(1, 1000);
    let db = st.db_read.clone();
    let rows = tokio::task::spawn_blocking(move || {
        let conn = db.lock().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        db::history(&conn, id, limit).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)??;
    Ok(Json(rows))
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
