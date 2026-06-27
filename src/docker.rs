use crate::collector::{Collector, Sample, now_ts};
use anyhow::Result;
use bollard::Docker;
use bollard::container::LogOutput;
use bollard::models::{ContainerStatsResponse, ContainerSummaryStateEnum};
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
}

impl Collector for DockerCollector {
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
}
