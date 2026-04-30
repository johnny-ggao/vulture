import type { McpServer, McpToolSummary } from "../../api/mcpServers";
import type { AuthStatusView } from "../../commandCenterTypes";

export function Row({ label, value }: { label: string; value: string }) {
  // Long values render in mono so file paths, IDs, and tokens stay
  // legible without re-flowing on every character. The threshold is
  // visually-tuned, not semantic — short labels read fine in the inherit
  // sans stack.
  const isLong = value.length > 20;
  return (
    <div className="settings-row">
      <span className="settings-row-label">{label}</span>
      <span className={"settings-row-value" + (isLong ? " mono" : "")}>
        {value}
      </span>
    </div>
  );
}

export function StatusPill({ label }: { label: string }) {
  return <span className="settings-status-pill">{label}</span>;
}

export function Stub({ title, body }: { title: string; body: string }) {
  return (
    <div className="page-card">
      <h3>{title}</h3>
      <div className="placeholder">
        <span>{body}</span>
      </div>
    </div>
  );
}

export function describeActive(s: AuthStatusView | null): string {
  if (!s) return "loading";
  if (s.active === "codex") return `Codex (${s.codex.email ?? "已登录"})`;
  if (s.active === "api_key") return "API Key";
  if (s.codex.state === "expired") return "Codex 已过期，请重新登录";
  return "未认证";
}

export function parseArgs(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function parseEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return out;
}

export function isToolEnabled(
  server: Partial<Pick<McpServer, "enabledTools" | "disabledTools">>,
  name: string,
): boolean {
  const disabledTools = getDisabledTools(server);
  const enabledTools = getEnabledTools(server);
  if (disabledTools.includes(name)) return false;
  if (enabledTools !== null && !enabledTools.includes(name)) return false;
  return true;
}

export function getEnabledTools(
  server: Partial<Pick<McpServer, "enabledTools">>,
): string[] | null {
  return Array.isArray(server.enabledTools) ? server.enabledTools : null;
}

export function getDisabledTools(
  server: Partial<Pick<McpServer, "disabledTools">>,
): string[] {
  return Array.isArray(server.disabledTools) ? server.disabledTools : [];
}

export function isReadOnlyMcpTool(tool: Pick<McpToolSummary, "name" | "description">): boolean {
  const text = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
  if (/(write|delete|remove|move|rename|create|mkdir|rmdir|edit|patch|update|upload|save|set|insert|append|replace)/.test(text)) {
    return false;
  }
  return /(read|list|get|search|find|stat|info|tree|view|fetch|download|head|tail|inspect|describe)/.test(text);
}

export function toggleName(items: string[], name: string, enabled: boolean): string[] {
  return enabled
    ? [...new Set([...items, name])]
    : items.filter((item) => item !== name);
}
