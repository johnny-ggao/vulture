ALTER TABLE conversations ADD COLUMN working_directory TEXT;

INSERT OR IGNORE INTO schema_version(version) VALUES (19);
