/**
 * Pure helpers extracted from App.tsx — no React, no module-level state,
 * just utility functions and constants the shell uses verbatim.
 *
 * Keeping these out of App.tsx makes them independently testable and
 * stops the file from being the single sink for everything.
 */

import type { Agent } from "../api/agents";
import type { AuthStatusView } from "../commandCenterTypes";

export interface ProfileView {
  id: string;
  name: string;
  activeAgentId: string;
}

export interface ProfileListResponse {
  profiles: ProfileView[];
  activeProfileId: string;
}

/**
 * Starter prompts shown as clickable chips on the empty chat state.
 * Kept here (rather than a separate constants file) until copy is finalised.
 */
export const DEFAULT_CHAT_SUGGESTIONS: ReadonlyArray<string> = [
  "帮我审查最近的代码改动",
  "解释这个错误日志",
  "起草一份产品方案",
  "总结这份文档",
];

/** Re-insert a soft-deleted agent at its original position by createdAt. */
export function insertAgentByCreatedAt(items: Agent[], item: Agent): Agent[] {
  // De-duplicate first in case a refetch already raced us.
  const filtered = items.filter((a) => a.id !== item.id);
  const target = parseTime(item.createdAt);
  if (target === null) return [...filtered, item];
  for (let i = 0; i < filtered.length; i += 1) {
    const candidate = parseTime(filtered[i].createdAt);
    if (candidate !== null && candidate <= target) {
      return [...filtered.slice(0, i), item, ...filtered.slice(i)];
    }
  }
  return [...filtered, item];
}

export function parseTime(input: string): number | null {
  const t = new Date(input).getTime();
  return Number.isNaN(t) ? null : t;
}

export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function authLabel(status: AuthStatusView | null): string {
  if (!status) return "loading";
  if (status.active === "codex") {
    const email = status.codex.email ?? "";
    return `Codex(${email.split("@")[0]})`;
  }
  if (status.active === "api_key") return "API key";
  if (status.codex.state === "expired") return "Codex 已过期⚠";
  return "未认证";
}

// --- "missing route" / "gateway restarting" classifiers used to decide
// when to retry through the gateway-restart fallback. Each is an exact
// substring match against the API client's structured error messages. ---

export function isMissingAttachmentRoute(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    cause.message.includes("POST /v1/attachments -> HTTP 404")
  );
}

export function isMissingSkillsRoute(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    cause.message.includes("GET /v1/skills") &&
    cause.message.includes("HTTP 404")
  );
}

export function isMissingToolsRoute(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    cause.message.includes("GET /v1/tools/catalog") &&
    cause.message.includes("HTTP 404")
  );
}

export function isMissingMemoriesRoute(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    cause.message.includes("/memories") &&
    cause.message.includes("HTTP 404")
  );
}

export function isMissingMcpRoute(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    cause.message.includes("/v1/mcp/servers") &&
    cause.message.includes("HTTP 404")
  );
}

export function isGatewayRestarting(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    (cause.message.includes("HTTP 503") ||
      cause.message.includes("Failed to fetch"))
  );
}
