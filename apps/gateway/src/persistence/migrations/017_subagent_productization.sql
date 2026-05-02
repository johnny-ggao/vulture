ALTER TABLE subagent_sessions ADD COLUMN title TEXT;
ALTER TABLE subagent_sessions ADD COLUMN task TEXT;
ALTER TABLE subagent_sessions ADD COLUMN result_summary TEXT;
ALTER TABLE subagent_sessions ADD COLUMN result_message_id TEXT;
ALTER TABLE subagent_sessions ADD COLUMN completed_at TEXT;
ALTER TABLE subagent_sessions ADD COLUMN last_error TEXT;

INSERT OR IGNORE INTO schema_version(version) VALUES (17);
