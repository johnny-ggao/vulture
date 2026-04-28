CREATE TABLE IF NOT EXISTS memory_files (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  path TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  UNIQUE(agent_id, path),
  FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_chunks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  path TEXT NOT NULL,
  heading TEXT,
  content TEXT NOT NULL,
  keywords_json TEXT NOT NULL,
  embedding_json TEXT,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY(file_id) REFERENCES memory_files(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_files_agent ON memory_files(agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_agent_path ON memory_chunks(agent_id, path);

CREATE TABLE IF NOT EXISTS memory_suggestions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  run_id TEXT,
  conversation_id TEXT,
  content TEXT NOT NULL,
  reason TEXT NOT NULL,
  target_path TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_suggestions_agent_status
  ON memory_suggestions(agent_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_legacy_migrations (
  agent_id TEXT PRIMARY KEY,
  migrated_at TEXT NOT NULL,
  FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO schema_version(version) VALUES (8);
