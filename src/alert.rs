use crate::collector::CheckResult;
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::mpsc;

const SEND_TIMEOUT: Duration = Duration::from_secs(10);

// Confirm down only after this many consecutive fails; flap = this many confirmed
// transitions inside the window, after which individual pings are suppressed.
const FAIL_THRESHOLD: u32 = 3;
const FLAP_COUNT: usize = 5;
const FLAP_WINDOW_S: i64 = 600;

#[derive(Default)]
struct AlertState {
    down: bool,
    fails: u32,
    transitions: Vec<i64>,
    flapping: bool,
}

enum Alert {
    Down,
    Recovery,
    Flapping,
    Stabilized(bool),
}

/// Fold one probe result into the per-check state, returning a message to send (if
/// any). Alerts fire only on a *confirmed* up/down transition — staying down is
/// silent (no re-spam); rapid toggling collapses to one flapping summary.
fn step(st: &mut AlertState, up: bool, now: i64) -> Option<Alert> {
    let now_up = if up {
        st.fails = 0;
        if st.down {
            st.down = false;
            true
        } else {
            return stabilize_if_quiet(st, now);
        }
    } else {
        st.fails += 1;
        if !st.down && st.fails >= FAIL_THRESHOLD {
            st.down = true;
            false
        } else {
            return stabilize_if_quiet(st, now);
        }
    };

    st.transitions.push(now);
    st.transitions.retain(|t| now - t <= FLAP_WINDOW_S);

    if st.flapping {
        return None;
    }
    if st.transitions.len() >= FLAP_COUNT {
        st.flapping = true;
        return Some(Alert::Flapping);
    }
    Some(if now_up { Alert::Recovery } else { Alert::Down })
}

/// Once flapping and no transition for a full window, declare it stable.
fn stabilize_if_quiet(st: &mut AlertState, now: i64) -> Option<Alert> {
    if st.flapping && st.transitions.last().is_some_and(|t| now - t > FLAP_WINDOW_S) {
        st.flapping = false;
        st.transitions.clear();
        return Some(Alert::Stabilized(!st.down));
    }
    None
}

fn render(target: &str, a: &Alert) -> String {
    match a {
        Alert::Down => format!("🔴 {target} is DOWN"),
        Alert::Recovery => format!("🟢 {target} recovered"),
        Alert::Flapping => format!("🟡 {target} is flapping"),
        Alert::Stabilized(up) => {
            let (icon, word) = if *up { ("🟢", "up") } else { ("🔴", "down") };
            format!("{icon} {target} stabilized ({word})")
        }
    }
}

/// Where alerts go. Telegram is the default; Discord optional; neither configured
/// logs instead so the binary runs without secrets in dev.
struct Config {
    telegram: Option<(String, String)>,
    discord: Option<String>,
}

impl Config {
    fn from_env() -> Self {
        let telegram = match (
            std::env::var("YAGURA_TELEGRAM_TOKEN"),
            std::env::var("YAGURA_TELEGRAM_CHAT"),
        ) {
            (Ok(t), Ok(c)) if !t.is_empty() && !c.is_empty() => Some((t, c)),
            _ => None,
        };
        let discord = std::env::var("YAGURA_DISCORD_WEBHOOK")
            .ok()
            .filter(|s| !s.is_empty());
        Self { telegram, discord }
    }

    async fn send(&self, client: &reqwest::Client, text: &str) {
        if self.telegram.is_none() && self.discord.is_none() {
            tracing::info!("alert (no channel configured): {text}");
            return;
        }
        if let Some((token, chat)) = &self.telegram {
            let url = format!("https://api.telegram.org/bot{token}/sendMessage");
            let body = serde_json::json!({ "chat_id": chat, "text": text });
            post("telegram", client.post(&url).json(&body)).await;
        }
        if let Some(webhook) = &self.discord {
            let body = serde_json::json!({ "content": text });
            post("discord", client.post(webhook).json(&body)).await;
        }
    }
}

/// Send one alert request. Errors are logged with the URL stripped so the bot
/// token / webhook never reaches the logs; a non-2xx response is a failure too.
async fn post(channel: &str, req: reqwest::RequestBuilder) {
    match req.timeout(SEND_TIMEOUT).send().await {
        Ok(resp) if resp.status().is_success() => {}
        Ok(resp) => tracing::warn!("{channel} send returned {}", resp.status()),
        Err(e) => tracing::warn!("{channel} send failed: {}", e.without_url()),
    }
}

/// Spawn the alerter task and return the channel probe results are fed into.
pub fn spawn(client: reqwest::Client) -> mpsc::Sender<CheckResult> {
    let cfg = Config::from_env();
    let (tx, mut rx) = mpsc::channel::<CheckResult>(256);
    tokio::spawn(async move {
        let mut states: HashMap<i64, AlertState> = HashMap::new();
        while let Some(r) = rx.recv().await {
            let st = states.entry(r.check_id).or_default();
            if let Some(alert) = step(st, r.up, r.ts) {
                cfg.send(&client, &render(&r.target, &alert)).await;
            }
        }
    });
    tx
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name(a: &Alert) -> &'static str {
        match a {
            Alert::Down => "down",
            Alert::Recovery => "recovery",
            Alert::Flapping => "flap",
            Alert::Stabilized(_) => "stable",
        }
    }

    #[test]
    fn confirms_down_after_threshold_then_stays_quiet() {
        let mut st = AlertState::default();
        for i in 0..FAIL_THRESHOLD - 1 {
            assert!(step(&mut st, false, i as i64).is_none());
        }
        assert_eq!(name(&step(&mut st, false, 10).unwrap()), "down");
        // Still down: no re-spam.
        assert!(step(&mut st, false, 11).is_none());
        assert!(step(&mut st, false, 12).is_none());
    }

    #[test]
    fn recovers_once() {
        let mut st = AlertState::default();
        for i in 0..FAIL_THRESHOLD {
            step(&mut st, false, i as i64);
        }
        assert_eq!(name(&step(&mut st, true, 100).unwrap()), "recovery");
        assert!(step(&mut st, true, 101).is_none());
    }

    #[test]
    fn rapid_toggling_collapses_to_one_flap() {
        let mut st = AlertState::default();
        let mut alerts = Vec::new();
        let mut t = 0i64;
        for _ in 0..FLAP_COUNT + 2 {
            for _ in 0..FAIL_THRESHOLD {
                if let Some(a) = step(&mut st, false, t) {
                    alerts.push(name(&a));
                }
                t += 1;
            }
            if let Some(a) = step(&mut st, true, t) {
                alerts.push(name(&a));
            }
            t += 1;
        }
        assert_eq!(alerts.iter().filter(|x| **x == "flap").count(), 1);
        // Once flapping, down/recovery pings stop — flap is the last thing said.
        assert_eq!(alerts.last(), Some(&"flap"));
    }

    #[test]
    fn stabilizes_after_quiet_window() {
        let mut st = AlertState {
            down: false,
            fails: 0,
            transitions: vec![5],
            flapping: true,
        };
        let a = step(&mut st, true, 5 + FLAP_WINDOW_S + 1);
        assert_eq!(a.map(|x| name(&x)), Some("stable"));
        assert!(!st.flapping);
    }
}
