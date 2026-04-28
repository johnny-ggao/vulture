ALTER TABLE agents ADD COLUMN skills TEXT;

INSERT OR IGNORE INTO schema_version(version) VALUES (6);
