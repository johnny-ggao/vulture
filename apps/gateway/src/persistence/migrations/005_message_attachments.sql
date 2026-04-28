CREATE TABLE IF NOT EXISTS blobs (
  id            TEXT PRIMARY KEY,
  sha256        TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  storage_path  TEXT NOT NULL,
  original_name TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blobs_sha256 ON blobs(sha256);

CREATE TABLE IF NOT EXISTS message_attachments (
  id           TEXT PRIMARY KEY,
  message_id   TEXT,
  blob_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY(blob_id) REFERENCES blobs(id)
);
CREATE INDEX IF NOT EXISTS idx_message_attachments_message ON message_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_message_attachments_blob ON message_attachments(blob_id);

INSERT OR IGNORE INTO schema_version(version) VALUES (5);
