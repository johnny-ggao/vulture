CREATE TABLE IF NOT EXISTS run_recovery_state (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL,
  sdk_state TEXT,
  metadata_json TEXT NOT NULL,
  checkpoint_seq INTEGER NOT NULL,
  active_tool_json TEXT,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_version(version) VALUES (3);
