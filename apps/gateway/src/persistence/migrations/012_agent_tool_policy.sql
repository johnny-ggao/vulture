ALTER TABLE agents ADD COLUMN tool_preset TEXT NOT NULL DEFAULT 'none';
ALTER TABLE agents ADD COLUMN tool_include_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agents ADD COLUMN tool_exclude_json TEXT NOT NULL DEFAULT '[]';

INSERT OR IGNORE INTO schema_version(version) VALUES (12);
