PRAGMA foreign_keys=off;

CREATE TABLE conversations_new (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  title           TEXT NOT NULL,
  permission_mode TEXT NOT NULL DEFAULT 'default',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

INSERT INTO conversations_new(id, agent_id, title, permission_mode, created_at, updated_at)
SELECT
  id,
  agent_id,
  title,
  CASE
    WHEN permission_mode = 'full_access' THEN 'full_access'
    WHEN permission_mode = 'read_only' THEN 'read_only'
    ELSE 'default'
  END,
  created_at,
  updated_at
FROM conversations;

DROP TABLE conversations;
ALTER TABLE conversations_new RENAME TO conversations;
CREATE INDEX IF NOT EXISTS idx_conversations_updated_at ON conversations(updated_at);

PRAGMA foreign_keys=on;

INSERT OR IGNORE INTO schema_version(version) VALUES (16);
