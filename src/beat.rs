use serde::Serialize;

/// An expected heartbeat — a job (backup, deploy) that must check in within
/// `deadline_s`, else it's flagged missing.
#[derive(Clone, Serialize)]
pub struct BeatSpec {
    pub name: String,
    pub deadline_s: i64,
}

/// Parse the expected-beat registry from `YAGURA_BEATS`, e.g.
/// `hozon-backup=86400,deploy=3600`. Unset/empty = no deadman checks; ingest still
/// records whatever is posted, so beats added to the registry later have history.
pub fn registry() -> Vec<BeatSpec> {
    std::env::var("YAGURA_BEATS")
        .unwrap_or_default()
        .split(',')
        .filter_map(|p| {
            let (name, secs) = p.trim().split_once('=')?;
            let name = name.trim();
            let deadline_s: i64 = secs.trim().parse().ok()?;
            // Drop garbage: empty names and non-positive deadlines (=3600, beat=0).
            (!name.is_empty() && deadline_s > 0).then(|| BeatSpec {
                name: name.to_string(),
                deadline_s,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::registry;

    #[test]
    fn registry_parses_pairs_skips_garbage() {
        // SAFETY: single-threaded test; no other thread reads the env here.
        unsafe {
            std::env::set_var("YAGURA_BEATS", "hozon-backup=86400, deploy=3600 , bad, =5, z=0, n=-1")
        }
        let r = registry();
        assert_eq!(r.len(), 2); // bad (no =), empty name, deadline 0/-1 all dropped
        assert_eq!(r[0].name, "hozon-backup");
        assert_eq!(r[0].deadline_s, 86400);
        assert_eq!(r[1].name, "deploy");
        unsafe { std::env::remove_var("YAGURA_BEATS") }
    }
}
