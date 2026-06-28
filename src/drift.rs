use crate::collector::now_ts;
use crate::probe::probe_tcp;
use serde::{Deserialize, Serialize};

const DEFAULT_CONFIG: &str = "/etc/cloudflared/config.yml";

/// One tunnel ingress route checked for a live listener. `up=false` = orphan: the
/// route points somewhere nothing is listening.
#[derive(Clone, Serialize)]
pub struct Route {
    pub hostname: String,
    pub target: String,
    pub up: bool,
    pub ts: i64,
}

#[derive(Deserialize)]
struct CfConfig {
    #[serde(default)]
    ingress: Vec<IngressRule>,
}

#[derive(Deserialize)]
struct IngressRule {
    hostname: Option<String>,
    service: Option<String>,
}

/// Reads cloudflared ingress and TCP-checks each http(s) route target. Path from
/// `YAGURA_CLOUDFLARED_CONFIG` (default `/etc/cloudflared/config.yml`).
pub struct DriftCollector {
    path: String,
}

impl DriftCollector {
    pub fn new() -> Self {
        Self {
            path: std::env::var("YAGURA_CLOUDFLARED_CONFIG")
                .unwrap_or_else(|_| DEFAULT_CONFIG.into()),
        }
    }

    /// (hostname, target) for http(s) routes with a hostname. The catch-all rule and
    /// non-http services (http_status, unix, tcp, …) are skipped.
    fn routes(&self) -> Vec<(String, String)> {
        match std::fs::read_to_string(&self.path) {
            Ok(t) => parse_routes(&t),
            Err(e) => {
                tracing::warn!("cloudflared config unreadable ({}): {e}", self.path);
                Vec::new()
            }
        }
    }

    /// TCP-check every route concurrently. One slow target can't stall the rest.
    pub async fn check(&self) -> Vec<Route> {
        let ts = now_ts();
        let routes = self.routes();
        let ups = futures_util::future::join_all(routes.iter().map(|(_, t)| probe_tcp(t))).await;
        routes
            .into_iter()
            .zip(ups)
            .map(|((hostname, target), (up, _))| Route {
                hostname,
                target,
                up,
                ts,
            })
            .collect()
    }
}

impl Default for DriftCollector {
    fn default() -> Self {
        Self::new()
    }
}

/// Parse cloudflared YAML → (hostname, target) for checkable routes. A parse error
/// yields no routes (logged) rather than killing the sweep.
fn parse_routes(text: &str) -> Vec<(String, String)> {
    let cfg: CfConfig = match serde_yaml::from_str(text) {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("cloudflared config parse failed: {e}");
            return Vec::new();
        }
    };
    cfg.ingress
        .into_iter()
        .filter_map(|r| Some((r.hostname?, target_of(r.service.as_deref()?)?)))
        .collect()
}

/// http(s) service URL → "host:port" for a TCP connect. None for non-http services
/// (`http_status:404`, `hello_world`, `unix:…`, `tcp:…`).
fn target_of(service: &str) -> Option<String> {
    let (scheme, rest) = service.split_once("://")?;
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let host_port = rest.split('/').next().unwrap_or(rest);
    // IPv6 literals are bracketed (`[::1]` / `[::1]:443`); only `]:` is a real port.
    let has_port = if host_port.starts_with('[') {
        host_port.contains("]:")
    } else {
        host_port.contains(':')
    };
    if has_port {
        Some(host_port.to_string())
    } else {
        Some(format!("{host_port}:{}", if scheme == "https" { 443 } else { 80 }))
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_routes, target_of};

    #[test]
    fn parses_http_and_skips_special_services() {
        assert_eq!(target_of("http://localhost:8091").as_deref(), Some("localhost:8091"));
        assert_eq!(target_of("http://127.0.0.1:8082/path").as_deref(), Some("127.0.0.1:8082"));
        assert_eq!(target_of("https://example").as_deref(), Some("example:443"));
        assert_eq!(target_of("http_status:404"), None);
        assert_eq!(target_of("tcp://host:22"), None);
        assert_eq!(target_of("hello_world"), None);
        // IPv6 literals: default port only when no `]:` port is present.
        assert_eq!(target_of("https://[::1]").as_deref(), Some("[::1]:443"));
        assert_eq!(target_of("http://[::1]:8080").as_deref(), Some("[::1]:8080"));
    }

    #[test]
    fn parse_routes_extracts_hostnames_skips_catchall() {
        let yml = "
tunnel: abc
ingress:
  - hostname: watch.sanctuary.my.id
    service: http://localhost:8091
  - hostname: kanjo.sanctuary.my.id
    service: http://127.0.0.1:8090
  - service: http_status:404
";
        let routes = parse_routes(yml);
        assert_eq!(routes.len(), 2); // catch-all dropped
        assert_eq!(routes[0], ("watch.sanctuary.my.id".into(), "localhost:8091".into()));
        assert_eq!(routes[1], ("kanjo.sanctuary.my.id".into(), "127.0.0.1:8090".into()));
    }
}
