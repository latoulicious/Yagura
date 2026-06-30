//! gRPC client for the Tsugi agent control channel — dials the localhost agent for
//! release history (unary) and to drive deploys (server-streamed log lines).
//! Contract: `proto/tsugi_agent.proto`.
#![allow(dead_code)]

use serde::Serialize;
use std::time::Duration;
use tonic::transport::Channel;

tonic::include_proto!("tsugi.agent.v1");

use tsugi_agent_client::TsugiAgentClient;

// Bounds so a half-open / firewalled agent host can't hang a request indefinitely;
// both sit under the dashboard's 10s poll.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);

/// A release-per-env row for the API/UI — proto `Release` flattened, with `deployed_at`
/// normalized (proto sends 0 for "never deployed" → None so the UI shows "—").
#[derive(Serialize)]
pub struct ReleaseRow {
    pub env: String,
    pub service: String,
    pub commit: String,
    pub tag: String,
    pub deployed_at: Option<i64>,
    pub status: String,
}

impl From<Release> for ReleaseRow {
    fn from(r: Release) -> Self {
        Self {
            env: r.env,
            service: r.service,
            commit: r.commit,
            tag: r.tag,
            deployed_at: (r.deployed_at != 0).then_some(r.deployed_at),
            status: r.status,
        }
    }
}

/// One line of streamed deploy output for the SSE relay — proto `LogLine` flattened.
#[derive(Serialize)]
pub struct DeployLine {
    pub ts: i64,
    pub stream: String,
    pub text: String,
}

impl From<LogLine> for DeployLine {
    fn from(l: LogLine) -> Self {
        Self {
            ts: l.ts,
            stream: l.stream,
            text: l.text,
        }
    }
}

/// Lazy gRPC client to the Tsugi agent. `connect_lazy` dials per request and reconnects,
/// so the dashboard stays up whether or not the agent is running — calls just return a
/// transport error when it's down.
#[derive(Clone)]
pub struct TsugiClient {
    inner: TsugiAgentClient<Channel>,
    // Deploys stream for minutes; this client has no per-request timeout (Tsugi caps
    // the deploy itself). Separate from `inner` so reads keep their tight bound.
    stream: TsugiAgentClient<Channel>,
}

impl TsugiClient {
    /// Build a lazy client for `addr` (e.g. `http://127.0.0.1:8091`). Errors only on a
    /// malformed address, not on the agent being unreachable.
    pub fn connect(addr: String) -> anyhow::Result<Self> {
        let endpoint = Channel::from_shared(addr)?.connect_timeout(CONNECT_TIMEOUT);
        let inner = endpoint.clone().timeout(REQUEST_TIMEOUT).connect_lazy();
        let stream = endpoint.connect_lazy();
        Ok(Self {
            inner: TsugiAgentClient::new(inner),
            stream: TsugiAgentClient::new(stream),
        })
    }

    /// Fetch the per-env release list, mapped to serializable rows.
    pub async fn list_releases(&self) -> Result<Vec<ReleaseRow>, tonic::Status> {
        let resp = self.inner.clone().list_releases(ListReleasesReq {}).await?;
        Ok(resp
            .into_inner()
            .releases
            .into_iter()
            .map(ReleaseRow::from)
            .collect())
    }

    /// Promote a staging release (by commit) to production; server-streams deploy log.
    pub async fn promote(
        &self,
        service: String,
        env: String,
        commit: String,
    ) -> Result<tonic::Streaming<LogLine>, tonic::Status> {
        let req = DeployReq { service, env, commit: Some(commit) };
        Ok(self.stream.clone().promote(req).await?.into_inner())
    }

    /// Roll back to an archived release (by commit); server-streams deploy log.
    pub async fn rollback(
        &self,
        service: String,
        env: String,
        commit: String,
    ) -> Result<tonic::Streaming<LogLine>, tonic::Status> {
        let req = DeployReq { service, env, commit: Some(commit) };
        Ok(self.stream.clone().rollback(req).await?.into_inner())
    }
}
