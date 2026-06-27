use crate::collector::{Sample, now_ts};
use anyhow::Result;
use rusqlite::Connection;
use tokio::sync::mpsc;

const RETENTION_SECS: i64 = 48 * 3600;
const TRIM_EVERY: u64 = 1000;

// `samples` is written today; checks/check_results/events are created up front
// so the schema stays stable as those features land — cheap DDL, no logic yet.
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS samples (ts INTEGER, source TEXT, metric TEXT, value REAL);
CREATE INDEX IF NOT EXISTS idx_samples_src_metric_ts ON samples(source, metric, ts);
CREATE TABLE IF NOT EXISTS checks (id INTEGER PRIMARY KEY, kind TEXT, target TEXT, interval_s INTEGER, enabled INTEGER);
CREATE TABLE IF NOT EXISTS check_results (ts INTEGER, check_id INTEGER, up INTEGER, latency_ms INTEGER);
CREATE TABLE IF NOT EXISTS events (ts INTEGER, kind TEXT, payload TEXT);
";

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

/// Spawn the single writer task (owns the only write connection) and return the
/// mpsc sender collectors push Samples to. Trims past the 48h window periodically.
pub fn spawn_writer(path: &str) -> Result<mpsc::Sender<Sample>> {
    let conn = Connection::open(path)?;
    tune(&conn)?;
    conn.execute_batch(SCHEMA)?;
    let (tx, mut rx) = mpsc::channel::<Sample>(1024);
    std::thread::spawn(move || {
        let mut n: u64 = 0;
        while let Some(s) = rx.blocking_recv() {
            if let Err(e) = conn.execute(
                "INSERT INTO samples (ts, source, metric, value) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![s.ts, s.source, s.metric, s.value],
            ) {
                tracing::warn!("sample insert failed: {e}");
            }
            n += 1;
            if n.is_multiple_of(TRIM_EVERY) {
                let _ = conn.execute(
                    "DELETE FROM samples WHERE ts < ?1",
                    [now_ts() - RETENTION_SECS],
                );
            }
        }
    });
    Ok(tx)
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
