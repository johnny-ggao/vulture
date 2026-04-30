import { describe, expect, test } from "bun:test";
import {
  authLabel,
  insertAgentByCreatedAt,
  isGatewayRestarting,
  isMissingAttachmentRoute,
  isMissingMcpRoute,
  isMissingMemoriesRoute,
  isMissingSkillsRoute,
  isMissingToolsRoute,
  parseTime,
} from "./appHelpers";
import type { Agent } from "../api/agents";
import type { AuthStatusView } from "../commandCenterTypes";

function fakeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    name: "Robin",
    description: "",
    instructions: "",
    model: "gpt-5.5",
    reasoning: "low",
    tools: [],
    toolPreset: "developer",
    toolInclude: [],
    toolExclude: [],
    skills: null,
    coreFiles: [],
    workspace: { path: "/tmp/ws", existsLocally: true },
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    updatedAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    ...overrides,
  } as Agent;
}

describe("parseTime", () => {
  test("parses ISO strings to milliseconds", () => {
    expect(parseTime("2026-01-01T00:00:00Z")).toBe(
      Date.UTC(2026, 0, 1, 0, 0, 0),
    );
  });

  test("returns null for unparseable input", () => {
    expect(parseTime("not-a-date")).toBeNull();
  });
});

describe("insertAgentByCreatedAt", () => {
  test("inserts at the position matching its createdAt sort order", () => {
    const a1 = fakeAgent({ id: "a", createdAt: "2026-01-01T00:00:00Z" });
    const a2 = fakeAgent({ id: "b", createdAt: "2026-02-01T00:00:00Z" });
    const a3 = fakeAgent({ id: "c", createdAt: "2026-03-01T00:00:00Z" });
    // Existing list is descending by createdAt (newest first)
    const list = [a3, a1];
    const inserted = insertAgentByCreatedAt(list, a2);
    expect(inserted.map((a) => a.id)).toEqual(["c", "b", "a"]);
  });

  test("appends when the new agent's createdAt is older than every existing entry", () => {
    const a1 = fakeAgent({ id: "a", createdAt: "2026-03-01T00:00:00Z" });
    const a2 = fakeAgent({ id: "b", createdAt: "2026-01-01T00:00:00Z" });
    const inserted = insertAgentByCreatedAt([a1], a2);
    expect(inserted.map((a) => a.id)).toEqual(["a", "b"]);
  });

  test("de-duplicates if the new agent already exists in the list", () => {
    const a1 = fakeAgent({ id: "a", createdAt: "2026-01-01T00:00:00Z" });
    const inserted = insertAgentByCreatedAt([a1], a1);
    expect(inserted).toHaveLength(1);
  });

  test("appends when createdAt fails to parse", () => {
    const a1 = fakeAgent({ id: "a", createdAt: "2026-01-01T00:00:00Z" });
    const bad = fakeAgent({ id: "b", createdAt: "garbage" });
    const inserted = insertAgentByCreatedAt([a1], bad);
    expect(inserted.map((a) => a.id)).toEqual(["a", "b"]);
  });
});

describe("authLabel", () => {
  test("loading when status is null", () => {
    expect(authLabel(null)).toBe("loading");
  });

  test("Codex(<email-prefix>) when active=codex with email", () => {
    const status: AuthStatusView = {
      active: "codex",
      codex: { state: "signed_in", email: "robin@example.com" },
      apiKey: { state: "not_set" },
    };
    expect(authLabel(status)).toBe("Codex(robin)");
  });

  test("'API key' label when active=api_key", () => {
    const status: AuthStatusView = {
      active: "api_key",
      codex: { state: "not_signed_in" },
      apiKey: { state: "set" },
    };
    expect(authLabel(status)).toBe("API key");
  });

  test("expired warning takes priority over the 未认证 fallback", () => {
    const status: AuthStatusView = {
      active: "none",
      codex: { state: "expired" },
      apiKey: { state: "not_set" },
    };
    expect(authLabel(status)).toBe("Codex 已过期⚠");
  });

  test("falls back to 未认证 when nothing matches", () => {
    const status: AuthStatusView = {
      active: "none",
      codex: { state: "not_signed_in" },
      apiKey: { state: "not_set" },
    };
    expect(authLabel(status)).toBe("未认证");
  });
});

describe("missing-route classifiers", () => {
  test("isMissingAttachmentRoute matches the exact attachments 404 signature", () => {
    expect(
      isMissingAttachmentRoute(
        new Error("POST /v1/attachments -> HTTP 404 Not Found"),
      ),
    ).toBe(true);
    expect(
      isMissingAttachmentRoute(new Error("POST /v1/foo -> HTTP 404")),
    ).toBe(false);
    expect(isMissingAttachmentRoute("string error")).toBe(false);
    expect(isMissingAttachmentRoute(null)).toBe(false);
  });

  test("isMissingSkillsRoute requires both /v1/skills and HTTP 404", () => {
    expect(
      isMissingSkillsRoute(new Error("GET /v1/skills?agentId=x HTTP 404")),
    ).toBe(true);
    expect(
      isMissingSkillsRoute(new Error("GET /v1/skills HTTP 500")),
    ).toBe(false);
    expect(isMissingSkillsRoute(new Error("HTTP 404 only"))).toBe(false);
  });

  test("isMissingToolsRoute matches GET /v1/tools/catalog 404s", () => {
    expect(
      isMissingToolsRoute(
        new Error("GET /v1/tools/catalog -> HTTP 404 Not Found"),
      ),
    ).toBe(true);
    expect(
      isMissingToolsRoute(new Error("POST /v1/tools/catalog HTTP 404")),
    ).toBe(false);
  });

  test("isMissingMemoriesRoute matches any /memories 404", () => {
    expect(
      isMissingMemoriesRoute(
        new Error("GET /v1/agents/x/memories HTTP 404"),
      ),
    ).toBe(true);
    expect(
      isMissingMemoriesRoute(new Error("/memories HTTP 500")),
    ).toBe(false);
  });

  test("isMissingMcpRoute matches /v1/mcp/servers 404s", () => {
    expect(
      isMissingMcpRoute(new Error("GET /v1/mcp/servers HTTP 404")),
    ).toBe(true);
    expect(isMissingMcpRoute(new Error("/v1/mcp HTTP 404"))).toBe(false);
  });

  test("isGatewayRestarting matches 503 OR fetch failure", () => {
    expect(isGatewayRestarting(new Error("HTTP 503 Service Unavailable"))).toBe(
      true,
    );
    expect(isGatewayRestarting(new Error("Failed to fetch"))).toBe(true);
    expect(isGatewayRestarting(new Error("HTTP 500"))).toBe(false);
    expect(isGatewayRestarting("plain string")).toBe(false);
  });
});
