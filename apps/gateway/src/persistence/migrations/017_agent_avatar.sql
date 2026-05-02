ALTER TABLE agents ADD COLUMN avatar TEXT;
INSERT OR IGNORE INTO schema_version(version) VALUES (17);
