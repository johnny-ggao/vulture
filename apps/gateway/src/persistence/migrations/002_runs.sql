CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  title         TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  run_id          TEXT,
  created_at      TEXT NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS runs (
  id                       TEXT PRIMARY KEY,
  conversation_id          TEXT NOT NULL,
  agent_id                 TEXT NOT NULL,
  status                   TEXT NOT NULL,
  triggered_by_message_id  TEXT NOT NULL,
  result_message_id        TEXT,
  started_at               TEXT NOT NULL,
  ended_at                 TEXT,
  error_json               TEXT,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_conv ON runs(conversation_id);

CREATE TABLE IF NOT EXISTS run_events (
  run_id      TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  type        TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY(run_id, seq),
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO schema_version(version) VALUES (2);
