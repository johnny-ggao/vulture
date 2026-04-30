CREATE TABLE IF NOT EXISTS subagent_sessions (
  id                     TEXT PRIMARY KEY,
  parent_conversation_id TEXT NOT NULL,
  parent_run_id          TEXT NOT NULL,
  agent_id               TEXT NOT NULL,
  conversation_id        TEXT NOT NULL,
  label                  TEXT NOT NULL,
  status                 TEXT NOT NULL,
  message_count          INTEGER NOT NULL,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  FOREIGN KEY(parent_conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  FOREIGN KEY(parent_run_id) REFERENCES runs(id) ON DELETE CASCADE,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subagent_sessions_parent_conversation
  ON subagent_sessions(parent_conversation_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_subagent_sessions_parent_run
  ON subagent_sessions(parent_run_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_subagent_sessions_conversation
  ON subagent_sessions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_subagent_sessions_status
  ON subagent_sessions(status, updated_at);

INSERT OR IGNORE INTO schema_version(version) VALUES (13);
