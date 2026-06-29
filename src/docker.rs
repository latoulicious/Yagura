use crate::collector::{Collector, Event, Sample, now_ts};
use anyhow::Result;
use bollard::Docker;
use bollard::container::LogOutput;
use bollard::models::{
    ContainerStatsResponse, ContainerSummaryStateEnum, EventMessage, EventMessageTypeEnum,
};
use bollard::query_parameters::{
    ListContainersOptionsBuilder, LogsOptionsBuilder, StatsOptionsBuilder,
};
use futures_util::{Stream, StreamExt};
use serde::Serialize;

/// Container as shown in the overview grid / sidebar.
#[derive(Debug, Clone, Serialize)]
pub struct ContainerInfo {
    pub id: String,
    pub name: String,
    pub state: String,
    pub status: String,
    /// Unix seconds the container was created (bollard summary; already fetched).
    pub created: i64,
}

pub struct DockerCollector {
    docker: Docker,
}

impl DockerCollector {
    /// Connect to the local Docker daemon (socket / Desktop / env defaults).
    pub fn connect() -> Result<Self> {
        Ok(Self {
            docker: Docker::connect_with_local_defaults()?,
        })
    }

    /// Docker daemon's hostname — the real host even when Yagura runs in a
    /// container (where `sysinfo` would report the container id instead).
    pub async fn host_name(&self) -> Option<String> {
        self.docker.info().await.ok()?.name
    }

    /// All containers (running + stopped) with current state/status.
    pub async fn list(&self) -> Result<Vec<ContainerInfo>> {
        let opts = ListContainersOptionsBuilder::new().all(true).build();
        let summaries = self.docker.list_containers(Some(opts)).await?;
        Ok(summaries
            .into_iter()
            .map(|c| ContainerInfo {
                id: c.id.unwrap_or_default(),
                name: c
                    .names
                    .as_ref()
                    .and_then(|n| n.first())
                    .map(|s| s.trim_start_matches('/').to_string())
                    .unwrap_or_default(),
                state: c.state.map(state_str).unwrap_or("").to_string(),
                status: c.status.unwrap_or_default(),
                created: c.created.unwrap_or(0),
            })
            .collect())
    }

    /// One-shot cpu%/mem/mem_limit for a single container. `stream=false,
    /// one_shot=false` makes Docker supply precpu so cpu% is valid on first read.
    async fn stats_once(&self, id: &str) -> Option<(f64, f64, f64)> {
        let opts = StatsOptionsBuilder::new()
            .stream(false)
            .one_shot(false)
            .build();
        let stat = self.docker.stats(id, Some(opts)).next().await?.ok()?;
        Some((cpu_percent(&stat), mem_used(&stat), mem_limit(&stat)))
    }

    /// Live log stream for a container (tails the last 200 lines, then follows).
    /// Borrows `self`; SSE handlers own the `Arc<DockerCollector>` for the
    /// stream's lifetime.
    pub fn follow_logs(&self, id: &str) -> impl Stream<Item = String> + '_ {
        let opts = LogsOptionsBuilder::new()
            .follow(true)
            .stdout(true)
            .stderr(true)
            .tail("200")
            .build();
        self.docker
            .logs(id, Some(opts))
            .filter_map(|res| async move { res.ok().map(line_of) })
    }

    /// Stream container lifecycle events (start/die/restart/oom/health…). Yields one
    /// `Event` per interesting container action; exec/attach/image noise is dropped.
    // Client-side filter (events(None) returns every object type); add a server-side
    // type=container filter only if event volume ever shows up in profiling.
    pub fn events(&self) -> impl Stream<Item = Event> + '_ {
        self.docker
            .events(None)
            .filter_map(|res| async move { res.ok().and_then(container_event) })
    }
}

/// Container lifecycle actions worth surfacing. Excludes the high-noise ones
/// (`exec_*`, `attach`, `top`, `create`/`destroy`) so the overview feed stays calm.
const INTERESTING: &[&str] = &[
    "start", "die", "stop", "kill", "restart", "oom", "pause", "unpause", "health_status",
];

/// Map a raw daemon event to an `Event`, or `None` if it's not an interesting
/// container action. `health_status: healthy` splits into kind + payload.
fn container_event(ev: EventMessage) -> Option<Event> {
    if ev.typ != Some(EventMessageTypeEnum::CONTAINER) {
        return None;
    }
    let action = ev.action?;
    let (kind, detail) = match action.split_once(':') {
        Some((k, v)) => (k.trim().to_string(), v.trim().to_string()),
        None => (action, String::new()),
    };
    if !INTERESTING.contains(&kind.as_str()) {
        return None;
    }
    let actor = ev.actor?;
    let id = actor.id?;
    let attrs = actor.attributes.unwrap_or_default();
    // Prefer the action's own detail (health word); else surface exit code / signal.
    let payload = if !detail.is_empty() {
        detail
    } else if kind == "die" {
        attrs.get("exitCode").map(|c| format!("exit {c}")).unwrap_or_default()
    } else if kind == "kill" {
        attrs.get("signal").map(|s| format!("signal {s}")).unwrap_or_default()
    } else {
        String::new()
    };
    Some(Event {
        ts: ev.time.unwrap_or_else(now_ts),
        source: id,
        kind,
        payload,
    })
}

impl Collector for DockerCollector {
    type Out = Sample;

    async fn collect(&self) -> Vec<Sample> {
        let containers = match self.list().await {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("container list failed: {e}");
                return Vec::new();
            }
        };
        let ts = now_ts();
        let mut samples = Vec::new();
        for c in containers.iter().filter(|c| c.state == "running") {
            if let Some((cpu, mem, lim)) = self.stats_once(&c.id).await {
                let push = |samples: &mut Vec<Sample>, metric: &str, value: f64| {
                    samples.push(Sample {
                        ts,
                        source: c.id.clone(),
                        metric: metric.to_string(),
                        value,
                    });
                };
                push(&mut samples, "cpu", cpu);
                push(&mut samples, "mem", mem);
                push(&mut samples, "mem_limit", lim);
            }
        }
        samples
    }
}

/// cpu% = cpu_delta / system_delta * online_cpus * 100 (Docker's documented formula).
fn cpu_percent(stat: &ContainerStatsResponse) -> f64 {
    let (Some(cpu), Some(pre)) = (&stat.cpu_stats, &stat.precpu_stats) else {
        return 0.0;
    };
    let total = |c: &bollard::models::ContainerCpuStats| {
        c.cpu_usage
            .as_ref()
            .and_then(|u| u.total_usage)
            .unwrap_or(0)
    };
    let cpu_delta = total(cpu).saturating_sub(total(pre)) as f64;
    let sys_delta = cpu
        .system_cpu_usage
        .unwrap_or(0)
        .saturating_sub(pre.system_cpu_usage.unwrap_or(0)) as f64;
    let ncpu = cpu
        .online_cpus
        .or_else(|| {
            cpu.cpu_usage
                .as_ref()
                .and_then(|u| u.percpu_usage.as_ref())
                .map(|v| v.len() as u32)
        })
        .unwrap_or(1)
        .max(1) as f64;
    if sys_delta > 0.0 && cpu_delta > 0.0 {
        (cpu_delta / sys_delta) * ncpu * 100.0
    } else {
        0.0
    }
}

fn mem_used(stat: &ContainerStatsResponse) -> f64 {
    stat.memory_stats
        .as_ref()
        .and_then(|m| m.usage)
        .unwrap_or(0) as f64
}

fn mem_limit(stat: &ContainerStatsResponse) -> f64 {
    stat.memory_stats
        .as_ref()
        .and_then(|m| m.limit)
        .unwrap_or(0) as f64
}

fn state_str(e: ContainerSummaryStateEnum) -> &'static str {
    use ContainerSummaryStateEnum::*;
    match e {
        RUNNING => "running",
        CREATED => "created",
        PAUSED => "paused",
        RESTARTING => "restarting",
        EXITED => "exited",
        REMOVING => "removing",
        DEAD => "dead",
        STOPPING => "stopping",
        EMPTY => "",
    }
}

/// bollard demuxes the stream header already; just decode + strip the trailing newline.
fn line_of(out: LogOutput) -> String {
    let bytes = match out {
        LogOutput::StdErr { message }
        | LogOutput::StdOut { message }
        | LogOutput::StdIn { message }
        | LogOutput::Console { message } => message,
    };
    String::from_utf8_lossy(&bytes)
        .trim_end_matches(['\n', '\r'])
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use bollard::models::{ContainerCpuStats, ContainerCpuUsage, ContainerStatsResponse};

    fn cpu_stat(total: u64, system: u64, cpus: u32) -> ContainerCpuStats {
        ContainerCpuStats {
            cpu_usage: Some(ContainerCpuUsage {
                total_usage: Some(total),
                ..Default::default()
            }),
            system_cpu_usage: Some(system),
            online_cpus: Some(cpus),
            ..Default::default()
        }
    }

    #[test]
    fn cpu_percent_uses_deltas_and_core_count() {
        // container burned 25% of system time across 2 cores -> 50%.
        let stat = ContainerStatsResponse {
            cpu_stats: Some(cpu_stat(250, 1000, 2)),
            precpu_stats: Some(cpu_stat(0, 0, 2)),
            ..Default::default()
        };
        assert!((cpu_percent(&stat) - 50.0).abs() < 1e-9);
    }

    #[test]
    fn cpu_percent_zero_when_no_movement() {
        let stat = ContainerStatsResponse {
            cpu_stats: Some(cpu_stat(100, 1000, 1)),
            precpu_stats: Some(cpu_stat(100, 1000, 1)),
            ..Default::default()
        };
        assert_eq!(cpu_percent(&stat), 0.0);
    }

    use bollard::models::EventActor;
    use std::collections::HashMap;

    fn ev(typ: EventMessageTypeEnum, action: &str, attrs: &[(&str, &str)]) -> EventMessage {
        EventMessage {
            typ: Some(typ),
            action: Some(action.into()),
            actor: Some(EventActor {
                id: Some("c1".into()),
                attributes: Some(
                    attrs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<HashMap<_, _>>(),
                ),
            }),
            time: Some(100),
            ..Default::default()
        }
    }

    #[test]
    fn maps_die_with_exit_code() {
        let e = container_event(ev(EventMessageTypeEnum::CONTAINER, "die", &[("exitCode", "137")])).unwrap();
        assert_eq!(e.source, "c1");
        assert_eq!(e.kind, "die");
        assert_eq!(e.payload, "exit 137");
        assert_eq!(e.ts, 100);
    }

    #[test]
    fn parses_health_status_and_filters_noise() {
        let h = container_event(ev(EventMessageTypeEnum::CONTAINER, "health_status: unhealthy", &[])).unwrap();
        assert_eq!(h.kind, "health_status");
        assert_eq!(h.payload, "unhealthy");
        // exec/attach chatter is dropped.
        assert!(container_event(ev(EventMessageTypeEnum::CONTAINER, "exec_start: /bin/sh", &[])).is_none());
        // non-container objects (image pull, network connect) are dropped.
        assert!(container_event(ev(EventMessageTypeEnum::IMAGE, "pull", &[])).is_none());
    }
}
