-- Applied by migrate.ts because SQLite does not support restart-safe
-- ALTER TABLE ADD COLUMN IF NOT EXISTS for this migration shape.
-- Keep the schema_version marker here for human-readable migration history.
INSERT OR IGNORE INTO schema_version(version) VALUES (17);
