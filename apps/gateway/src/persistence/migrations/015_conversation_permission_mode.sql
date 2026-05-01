ALTER TABLE conversations ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'full_access';

INSERT OR IGNORE INTO schema_version(version) VALUES (15);
