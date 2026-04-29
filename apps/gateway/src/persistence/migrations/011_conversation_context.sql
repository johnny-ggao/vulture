CREATE TABLE IF NOT EXISTS conversation_contexts (
  conversation_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  summarized_through_message_id TEXT,
  input_item_count INTEGER NOT NULL DEFAULT 0,
  input_char_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversation_session_items (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id TEXT,
  role TEXT NOT NULL,
  item_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversation_session_items_conversation_order
  ON conversation_session_items(conversation_id, created_at, id);

INSERT OR IGNORE INTO schema_version(version) VALUES (11);
