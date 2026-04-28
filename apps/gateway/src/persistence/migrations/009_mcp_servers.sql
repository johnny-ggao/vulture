CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  transport TEXT NOT NULL,
  command TEXT NOT NULL,
  args_json TEXT NOT NULL,
  cwd TEXT,
  env_json TEXT NOT NULL,
  trust TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcp_servers_profile
  ON mcp_servers(profile_id, updated_at DESC);

INSERT OR IGNORE INTO schema_version(version) VALUES (9);
