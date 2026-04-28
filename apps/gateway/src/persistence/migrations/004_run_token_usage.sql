ALTER TABLE runs ADD COLUMN input_tokens INTEGER;
ALTER TABLE runs ADD COLUMN output_tokens INTEGER;
ALTER TABLE runs ADD COLUMN total_tokens INTEGER;

INSERT OR IGNORE INTO schema_version(version) VALUES (4);
