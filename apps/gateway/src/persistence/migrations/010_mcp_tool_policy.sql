ALTER TABLE mcp_servers ADD COLUMN enabled_tools_json TEXT;
ALTER TABLE mcp_servers ADD COLUMN disabled_tools_json TEXT NOT NULL DEFAULT '[]';

INSERT OR IGNORE INTO schema_version(version) VALUES (10);
