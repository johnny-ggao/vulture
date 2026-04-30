ALTER TABLE agents ADD COLUMN handoff_agent_ids_json TEXT NOT NULL DEFAULT '[]';

INSERT OR IGNORE INTO schema_version(version) VALUES (14);
