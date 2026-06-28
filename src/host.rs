use crate::collector::{Collector, Sample, now_ts};
use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;
use sysinfo::{Disks, Networks, ProcessRefreshKind, ProcessesToUpdate, System};

const SOURCE: &str = "host";
// Fallback divisor for throughput when there's no prior tick to measure against.
const TICK_SECS: f64 = 5.0;

/// Curated host metrics via sysinfo — the ~9 read numbers, not Netdata's firehose.
/// Refresh state (cpu baseline, net/disk deltas) lives across ticks → `Mutex<Inner>`.
pub struct HostCollector {
    inner: Mutex<Inner>,
}

struct Inner {
    sys: System,
    nets: Networks,
    disks: Disks,
    last: Option<Instant>,
}

impl HostCollector {
    pub fn new() -> Self {
        let mut sys = System::new();
        // cpu% is a delta — prime a baseline so the first real reading isn't 0.
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        Self {
            inner: Mutex::new(Inner {
                sys,
                nets: Networks::new_with_refreshed_list(),
                disks: Disks::new_with_refreshed_list(),
                last: None,
            }),
        }
    }
}

impl Default for HostCollector {
    fn default() -> Self {
        Self::new()
    }
}

impl Collector for HostCollector {
    type Out = Sample;

    // ponytail: sysinfo refresh (incl. the per-process disk-usage scan) runs inline
    // on the 5s tick; move to spawn_blocking only if it shows up in profiling.
    async fn collect(&self) -> Vec<Sample> {
        let ts = now_ts();
        let mut g = self.inner.lock().unwrap();

        // Throughput = bytes-since-last-refresh / real elapsed, so a drifted or
        // missed tick doesn't skew B/s.
        let now = Instant::now();
        let secs = g
            .last
            .replace(now)
            .map(|prev| (now - prev).as_secs_f64())
            .filter(|s| *s > 0.0)
            .unwrap_or(TICK_SECS);

        g.sys.refresh_cpu_usage();
        g.sys.refresh_memory();
        g.sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_disk_usage(),
        );
        g.nets.refresh(true);
        g.disks.refresh(true);

        let cpu = g.sys.global_cpu_usage() as f64;
        let mem_used = g.sys.used_memory() as f64;
        let mem_total = g.sys.total_memory() as f64;
        let swap_used = g.sys.used_swap() as f64;
        let swap_total = g.sys.total_swap() as f64;
        let (disk_used, disk_total) = root_disk(&g.disks);

        // Disk I/O is per-process in sysinfo; sum per-tick deltas for a host total.
        // ponytail: reads 0 on macOS dev without entitlement; works on Linux target.
        let (mut read, mut written) = (0u64, 0u64);
        for p in g.sys.processes().values() {
            let d = p.disk_usage();
            read += d.read_bytes;
            written += d.written_bytes;
        }

        let (mut rx, mut tx) = (0u64, 0u64);
        for n in g.nets.list().values() {
            rx += n.received();
            tx += n.transmitted();
        }

        let uptime = System::uptime() as f64;
        let load = System::load_average();
        drop(g);

        let mut out = Vec::with_capacity(15);
        let mut push = |metric: &str, value: f64| {
            out.push(Sample {
                ts,
                source: SOURCE.into(),
                metric: metric.into(),
                value,
            });
        };
        push("cpu", cpu);
        push("mem_used", mem_used);
        push("mem_total", mem_total);
        push("swap_used", swap_used);
        push("swap_total", swap_total);
        push("disk_used", disk_used);
        push("disk_total", disk_total);
        push("disk_read", read as f64 / secs);
        push("disk_write", written as f64 / secs);
        push("net_rx", rx as f64 / secs);
        push("net_tx", tx as f64 / secs);
        push("uptime", uptime);
        push("load1", load.one);
        push("load5", load.five);
        push("load15", load.fifteen);
        out
    }
}

/// Root mount usage. Prefers the `/` disk; falls back to the first listed.
fn root_disk(disks: &Disks) -> (f64, f64) {
    let root = Path::new("/");
    let disk = disks
        .list()
        .iter()
        .find(|d| d.mount_point() == root)
        .or_else(|| disks.list().first());
    match disk {
        Some(d) => {
            let total = d.total_space();
            let used = total.saturating_sub(d.available_space());
            (used as f64, total as f64)
        }
        None => (0.0, 0.0),
    }
}

/// Percentage used, guarding division by zero (no total reported → 0).
pub fn pct(used: f64, total: f64) -> f64 {
    if total > 0.0 { used / total * 100.0 } else { 0.0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pct_guards_zero_total() {
        assert_eq!(pct(50.0, 100.0), 50.0);
        assert_eq!(pct(0.0, 0.0), 0.0); // no division by zero
        assert_eq!(pct(85.0, 100.0), 85.0);
    }
}
