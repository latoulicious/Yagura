//! gRPC client for the Tsugi agent control channel — dials the localhost agent for
//! release history. Contract: `proto/tsugi_agent.proto`. Only the read path is wired;
//! the generated Deploy/Rollback service stays unused for now.
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

/// Lazy gRPC client to the Tsugi agent. `connect_lazy` dials per request and reconnects,
/// so the dashboard stays up whether or not the agent is running — calls just return a
/// transport error when it's down.
#[derive(Clone)]
pub struct TsugiClient {
    inner: TsugiAgentClient<Channel>,
}

impl TsugiClient {
    /// Build a lazy client for `addr` (e.g. `http://127.0.0.1:50051`). Errors only on a
    /// malformed address, not on the agent being unreachable.
    pub fn connect(addr: String) -> anyhow::Result<Self> {
        let channel = Channel::from_shared(addr)?
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .connect_lazy();
        Ok(Self {
            inner: TsugiAgentClient::new(channel),
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
}
