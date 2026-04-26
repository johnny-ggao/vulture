use chrono::Utc;
use rusqlite::{params, Connection, Result};
use serde_json::Value;

#[derive(Debug)]
pub struct AuditStore {
    conn: Connection,
}

impl AuditStore {
    pub fn open(path: &std::path::Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS audit_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                event_type TEXT NOT NULL,
                payload TEXT NOT NULL
            )",
            [],
        )?;

        Ok(Self { conn })
    }

    pub fn append(&self, event_type: &str, payload: &Value) -> Result<()> {
        self.conn.execute(
            "INSERT INTO audit_events (created_at, event_type, payload) VALUES (?1, ?2, ?3)",
            params![Utc::now().to_rfc3339(), event_type, payload.to_string()],
        )?;

        Ok(())
    }
}
