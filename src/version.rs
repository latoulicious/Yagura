use serde::Serialize;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub struct VersionTarget {
    pub label: String,
    pub url: String,
}

/// One service's reported version/commit, or `ok=false` if the `/version` poll failed.
#[derive(Clone, Serialize)]
pub struct VersionStatus {
    pub label: String,
    pub version: Option<String>,
    pub commit: Option<String>,
    pub ok: bool,
}

/// Polls each configured service `/version` endpoint. Targets from
/// `YAGURA_VERSION_URLS`, e.g. `kanjo-prod=http://127.0.0.1:8090/version,…`.
pub struct VersionCollector {
    client: reqwest::Client,
    targets: Vec<VersionTarget>,
}

impl VersionCollector {
    pub fn new(client: reqwest::Client) -> Self {
        let targets = std::env::var("YAGURA_VERSION_URLS")
            .unwrap_or_default()
            .split(',')
            .filter_map(|p| {
                let (label, url) = p.trim().split_once('=')?;
                Some(VersionTarget {
                    label: label.trim().to_string(),
                    url: url.trim().to_string(),
                })
            })
            .collect();
        Self { client, targets }
    }

    pub fn is_empty(&self) -> bool {
        self.targets.is_empty()
    }

    /// Poll every target concurrently.
    pub async fn check(&self) -> Vec<VersionStatus> {
        futures_util::future::join_all(self.targets.iter().map(|t| self.poll(t))).await
    }

    async fn poll(&self, t: &VersionTarget) -> VersionStatus {
        let fail = || VersionStatus {
            label: t.label.clone(),
            version: None,
            commit: None,
            ok: false,
        };
        match self.client.get(&t.url).timeout(TIMEOUT).send().await {
            Ok(resp) if resp.status().is_success() => {
                let json = resp.json::<serde_json::Value>().await.unwrap_or_default();
                VersionStatus {
                    label: t.label.clone(),
                    version: pick(&json, &["version", "tag", "build"]),
                    commit: pick(&json, &["commit", "sha", "revision"]),
                    ok: true,
                }
            }
            _ => fail(),
        }
    }
}

/// First present string field among `keys` — Tsugi's `/version` shape is unknown,
/// so accept the common aliases.
fn pick(json: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| json.get(k).and_then(|v| v.as_str()).map(String::from))
}

#[cfg(test)]
mod tests {
    use super::pick;

    #[test]
    fn pick_finds_first_present_alias() {
        let j = serde_json::json!({ "commit": "abc123", "version": "1.2.3" });
        assert_eq!(pick(&j, &["version", "tag"]).as_deref(), Some("1.2.3"));
        assert_eq!(pick(&j, &["sha", "commit"]).as_deref(), Some("abc123"));
        assert_eq!(pick(&j, &["missing"]), None);
    }
}
