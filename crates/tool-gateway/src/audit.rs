use chrono::Utc;
use rusqlite::{params, Connection, Result};
use serde_json::Value;

#[derive(Debug)]
pub struct AuditStore {
    conn: Connection,
}

impl AuditStore {
    pub fn open(path: &std::path::Path) -> Result<Self> {
        // Ensure parent directory exists so open() doesn't fail when the
        // caller passes a path whose parent hasn't been created yet.
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(path)?;
        // WAL mode allows concurrent readers + one writer; safe when multiple
        // AuditStore handles are opened against the same file (e.g. AppState
        // and tool_callback each holding their own handle).
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
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

#[cfg(test)]
mod tests {
    use std::{env, fs};

    use rusqlite::Result;
    use serde_json::json;
    use uuid::Uuid;

    use super::*;

    #[test]
    fn append_persists_event_type_and_payload() -> Result<()> {
        let path = env::temp_dir().join(format!("vulture-audit-{}.sqlite", Uuid::new_v4()));
        let store = AuditStore::open(&path)?;
        let payload = json!({ "tool": "file.read", "ok": true });

        store.append("tool.result", &payload)?;
        drop(store);

        let reopened_store = AuditStore::open(&path)?;

        let (event_type, persisted_payload): (String, String) = reopened_store.conn.query_row(
            "SELECT event_type, payload FROM audit_events",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;

        drop(reopened_store);
        let _ = fs::remove_file(path);

        assert_eq!(event_type, "tool.result");
        assert_eq!(persisted_payload, payload.to_string());

        Ok(())
    }
}
