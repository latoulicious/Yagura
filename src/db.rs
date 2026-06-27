use crate::collector::{CheckResult, Sample, now_ts};
use anyhow::Result;
use rusqlite::Connection;
use serde::Serialize;
use tokio::sync::{mpsc, oneshot};

const RETENTION_SECS: i64 = 48 * 3600;
const TRIM_EVERY: u64 = 1000;
// Sparklines show a live rolling window, not the full 48h — last few minutes of
// host samples, seeded on load then advanced over the SSE stream.
const HOST_WINDOW_SECS: i64 = 600;

// `samples` + `check_results` are the high-volume tables; `checks`/`events` are
// config/log. Indexes mirror the read patterns (latest-per-key, per-id history).
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS samples (ts INTEGER, source TEXT, metric TEXT, value REAL);
CREATE INDEX IF NOT EXISTS idx_samples_src_metric_ts ON samples(source, metric, ts);
CREATE TABLE IF NOT EXISTS checks (id INTEGER PRIMARY KEY, kind TEXT, target TEXT, interval_s INTEGER, enabled INTEGER);
CREATE TABLE IF NOT EXISTS check_results (ts INTEGER, check_id INTEGER, up INTEGER, latency_ms INTEGER);
CREATE INDEX IF NOT EXISTS idx_check_results_id_ts ON check_results(check_id, ts);
CREATE TABLE IF NOT EXISTS events (ts INTEGER, kind TEXT, payload TEXT);
";

/// A probe definition awaiting its row id from the writer.
pub struct NewCheck {
    pub kind: String,
    pub target: String,
    pub interval_s: i64,
    pub enabled: bool,
}

/// One enabled check, as the prober schedules it.
pub struct Check {
    pub id: i64,
    pub kind: String,
    pub target: String,
    pub interval_s: i64,
}

/// A check joined with its latest result + last-down time, for the API list.
#[derive(Serialize)]
pub struct CheckRow {
    pub id: i64,
    pub kind: String,
    pub target: String,
    pub interval_s: i64,
    pub enabled: bool,
    pub up: Option<bool>,
    pub latency_ms: Option<i64>,
    pub since: Option<i64>,
    pub last_down: Option<i64>,
}

/// One historical probe result, for the sparkline.
#[derive(Serialize)]
pub struct ResultRow {
    pub ts: i64,
    pub up: bool,
    pub latency_ms: Option<i64>,
}

/// One downsampled host point — a metric's average over a 30-min bucket.
pub struct HostPoint {
    pub metric: String,
    pub ts: i64,
    pub value: f64,
}

/// Messages to the single writer task. Telemetry is fire-and-forget; CRUD carries
/// a oneshot so the API gets the new id / rows-affected back from the one writer.
pub enum DbMsg {
    Sample(Sample),
    Result(CheckResult),
    AddCheck(NewCheck, oneshot::Sender<rusqlite::Result<i64>>),
    DelCheck(i64, oneshot::Sender<rusqlite::Result<usize>>),
}

fn tune(conn: &Connection) -> Result<()> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(())
}

/// Open the WAL read connection (separate from the writer). Opened read-only so a
/// missing path fails fast instead of creating an empty DB; `query_only` is a belt.
pub fn open_read(path: &str) -> Result<Connection> {
    use rusqlite::OpenFlags;
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.pragma_update(None, "query_only", true)?;
    Ok(conn)
}

/// Drop telemetry older than the 48h window from both high-volume tables.
fn trim(conn: &Connection) {
    let cutoff = now_ts() - RETENTION_SECS;
    let _ = conn.execute("DELETE FROM samples WHERE ts < ?1", [cutoff]);
    let _ = conn.execute("DELETE FROM check_results WHERE ts < ?1", [cutoff]);
}

/// Spawn the single writer task (owns the only write connection) and return the
/// mpsc sender all writes funnel through. Trims past the 48h window periodically.
pub fn spawn_writer(path: &str) -> Result<mpsc::Sender<DbMsg>> {
    let conn = Connection::open(path)?;
    tune(&conn)?;
    conn.execute_batch(SCHEMA)?;
    let (tx, mut rx) = mpsc::channel::<DbMsg>(1024);
    std::thread::spawn(move || {
        let mut n: u64 = 0;
        while let Some(msg) = rx.blocking_recv() {
            match msg {
                DbMsg::Sample(s) => {
                    if let Err(e) = conn.execute(
                        "INSERT INTO samples (ts, source, metric, value) VALUES (?1, ?2, ?3, ?4)",
                        rusqlite::params![s.ts, s.source, s.metric, s.value],
                    ) {
                        tracing::warn!("sample insert failed: {e}");
                    }
                    n += 1;
                    if n.is_multiple_of(TRIM_EVERY) {
                        trim(&conn);
                    }
                }
                DbMsg::Result(r) => {
                    if let Err(e) = conn.execute(
                        "INSERT INTO check_results (ts, check_id, up, latency_ms) VALUES (?1, ?2, ?3, ?4)",
                        rusqlite::params![r.ts, r.check_id, r.up as i64, r.latency_ms],
                    ) {
                        tracing::warn!("check_result insert failed: {e}");
                    }
                    n += 1;
                    if n.is_multiple_of(TRIM_EVERY) {
                        trim(&conn);
                    }
                }
                DbMsg::AddCheck(c, reply) => {
                    let res = conn
                        .execute(
                            "INSERT INTO checks (kind, target, interval_s, enabled) VALUES (?1, ?2, ?3, ?4)",
                            rusqlite::params![c.kind, c.target, c.interval_s, c.enabled as i64],
                        )
                        .map(|_| conn.last_insert_rowid());
                    let _ = reply.send(res);
                }
                DbMsg::DelCheck(id, reply) => {
                    let res = conn.execute("DELETE FROM checks WHERE id = ?1", [id]);
                    let _ = reply.send(res);
                }
            }
        }
    });
    Ok(tx)
}

/// Insert a check and return its new id (round-trips through the single writer).
pub async fn add_check(tx: &mpsc::Sender<DbMsg>, c: NewCheck) -> Result<i64> {
    let (reply, rx) = oneshot::channel();
    tx.send(DbMsg::AddCheck(c, reply))
        .await
        .map_err(|_| anyhow::anyhow!("writer gone"))?;
    Ok(rx.await.map_err(|_| anyhow::anyhow!("writer dropped reply"))??)
}

/// Delete a check, returning rows affected (0 = not found).
pub async fn del_check(tx: &mpsc::Sender<DbMsg>, id: i64) -> Result<usize> {
    let (reply, rx) = oneshot::channel();
    tx.send(DbMsg::DelCheck(id, reply))
        .await
        .map_err(|_| anyhow::anyhow!("writer gone"))?;
    Ok(rx.await.map_err(|_| anyhow::anyhow!("writer dropped reply"))??)
}

/// Latest value per (source, metric) — SQLite bare-column + MAX(ts) idiom.
pub fn latest_samples(conn: &Connection) -> Result<Vec<Sample>> {
    let mut stmt =
        conn.prepare("SELECT source, metric, value, MAX(ts) FROM samples GROUP BY source, metric")?;
    let rows = stmt.query_map([], |r| {
        Ok(Sample {
            source: r.get(0)?,
            metric: r.get(1)?,
            value: r.get(2)?,
            ts: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Enabled checks for the prober to schedule.
pub fn enabled_checks(conn: &Connection) -> Result<Vec<Check>> {
    let mut stmt =
        conn.prepare("SELECT id, kind, target, interval_s FROM checks WHERE enabled = 1")?;
    let rows = stmt.query_map([], |r| {
        Ok(Check {
            id: r.get(0)?,
            kind: r.get(1)?,
            target: r.get(2)?,
            interval_s: r.get(3)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// All checks merged with their latest result + last-down time.
pub fn list_checks(conn: &Connection) -> Result<Vec<CheckRow>> {
    let mut latest = std::collections::HashMap::new();
    let mut stmt = conn
        .prepare("SELECT check_id, up, latency_ms, MAX(ts) FROM check_results GROUP BY check_id")?;
    let mut rows = stmt.query([])?;
    while let Some(r) = rows.next()? {
        let id: i64 = r.get(0)?;
        let up: i64 = r.get(1)?;
        latest.insert(id, (up != 0, r.get::<_, Option<i64>>(2)?, r.get::<_, i64>(3)?));
    }

    let mut last_down = std::collections::HashMap::new();
    let mut stmt =
        conn.prepare("SELECT check_id, MAX(ts) FROM check_results WHERE up = 0 GROUP BY check_id")?;
    let mut rows = stmt.query([])?;
    while let Some(r) = rows.next()? {
        last_down.insert(r.get::<_, i64>(0)?, r.get::<_, i64>(1)?);
    }

    let mut stmt =
        conn.prepare("SELECT id, kind, target, interval_s, enabled FROM checks ORDER BY id")?;
    let rows = stmt.query_map([], |r| {
        let id: i64 = r.get(0)?;
        let (up, latency_ms, since) = match latest.get(&id) {
            Some(&(u, lat, ts)) => (Some(u), lat, Some(ts)),
            None => (None, None, None),
        };
        Ok(CheckRow {
            id,
            kind: r.get(1)?,
            target: r.get(2)?,
            interval_s: r.get(3)?,
            enabled: r.get::<_, i64>(4)? != 0,
            up,
            latency_ms,
            since,
            last_down: last_down.get(&id).copied(),
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Most recent `limit` results for one check, oldest-first for the sparkline.
pub fn history(conn: &Connection, check_id: i64, limit: i64) -> Result<Vec<ResultRow>> {
    let mut stmt = conn.prepare(
        "SELECT ts, up, latency_ms FROM check_results WHERE check_id = ?1 ORDER BY ts DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![check_id, limit], |r| {
        Ok(ResultRow {
            ts: r.get(0)?,
            up: r.get::<_, i64>(1)? != 0,
            latency_ms: r.get(2)?,
        })
    })?;
    let mut v = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    v.reverse();
    Ok(v)
}

/// Recent host samples (last `HOST_WINDOW_SECS`), oldest-first, all metrics — the
/// rolling-sparkline seed. Bounded by the time floor + indexed by
/// `idx_samples_src_metric_ts`, so it's a small scan run once per page load.
pub fn host_history(conn: &Connection) -> Result<Vec<HostPoint>> {
    let cutoff = now_ts() - HOST_WINDOW_SECS;
    let mut stmt = conn.prepare(
        "SELECT metric, ts, value FROM samples \
         WHERE source = 'host' AND ts >= ?1 ORDER BY ts",
    )?;
    let rows = stmt.query_map([cutoff], |r| {
        Ok(HostPoint {
            metric: r.get(0)?,
            ts: r.get(1)?,
            value: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn
    }

    fn add_result(conn: &Connection, check_id: i64, ts: i64, up: i64, lat: Option<i64>) {
        conn.execute(
            "INSERT INTO check_results (ts, check_id, up, latency_ms) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![ts, check_id, up, lat],
        )
        .unwrap();
    }

    #[test]
    fn list_checks_merges_latest_result_and_last_down() {
        let conn = mem();
        conn.execute(
            "INSERT INTO checks (id, kind, target, interval_s, enabled) VALUES (1,'http','https://a',30,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO checks (id, kind, target, interval_s, enabled) VALUES (2,'tcp','b:443',30,1)",
            [],
        )
        .unwrap();
        // Check 1: down at ts=100, recovered (latest) at ts=200.
        add_result(&conn, 1, 100, 0, None);
        add_result(&conn, 1, 200, 1, Some(12));

        let rows = list_checks(&conn).unwrap();
        let c1 = rows.iter().find(|r| r.id == 1).unwrap();
        assert_eq!(c1.up, Some(true)); // latest result wins
        assert_eq!(c1.latency_ms, Some(12));
        assert_eq!(c1.since, Some(200));
        assert_eq!(c1.last_down, Some(100));

        let c2 = rows.iter().find(|r| r.id == 2).unwrap();
        assert_eq!(c2.up, None); // no results yet
        assert_eq!(c2.since, None);
        assert_eq!(c2.last_down, None);
    }

    fn insert_host(conn: &Connection, ts: i64, metric: &str, value: f64) {
        conn.execute(
            "INSERT INTO samples (ts, source, metric, value) VALUES (?1, 'host', ?2, ?3)",
            rusqlite::params![ts, metric, value],
        )
        .unwrap();
    }

    #[test]
    fn host_history_recent_oldest_first_per_metric() {
        let conn = mem();
        let base = now_ts() - 100; // inside the rolling window
        for i in 0..4 {
            insert_host(&conn, base + i * 5, "cpu", (i * 10) as f64);
        }
        insert_host(&conn, base, "mem_used", 1.0);
        insert_host(&conn, now_ts() - 100_000, "cpu", 999.0); // older than the window

        let cpu: Vec<_> = host_history(&conn)
            .unwrap()
            .into_iter()
            .filter(|p| p.metric == "cpu")
            .collect();
        assert_eq!(cpu.len(), 4); // stale sample excluded by the time floor
        assert_eq!(cpu.first().unwrap().ts, base); // oldest-first
        assert!((cpu.last().unwrap().value - 30.0).abs() < 1e-9);
    }

    #[test]
    fn history_returns_most_recent_oldest_first() {
        let conn = mem();
        for ts in [10, 20, 30] {
            add_result(&conn, 1, ts, 1, Some(5));
        }
        let h = history(&conn, 1, 2).unwrap();
        assert_eq!(h.len(), 2); // limit honored
        assert_eq!(h[0].ts, 20); // oldest-first within the limited window
        assert_eq!(h[1].ts, 30);
    }
}
