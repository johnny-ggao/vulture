import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "bun:test";
import type { Agent } from "../api/agents";
import type { ApiClient } from "../api/client";
import type { ToolCatalogGroup } from "../api/tools";
import { useGatewayBootstrap } from "./useGatewayBootstrap";

const agent: Agent = {
  id: "agent-a",
  name: "Agent A",
  description: "",
  model: "gpt-5.5",
  reasoning: "medium",
  tools: ["read"],
  toolPreset: "minimal",
  toolInclude: [],
  toolExclude: [],
  handoffAgentIds: [],
  workspace: {
    id: "workspace-a",
    name: "Workspace A",
    path: "/tmp/workspace-a",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  instructions: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const catalog: ToolCatalogGroup[] = [
  {
    id: "workspace",
    label: "Workspace",
    items: [
      {
        id: "read",
        label: "Read",
        description: "Read files",
        source: "core",
        category: "workspace",
        risk: "safe",
        idempotent: true,
        sdkName: "read",
      },
    ],
  },
];

function clientReturning(values: Record<string, unknown>): ApiClient {
  return {
    base: "http://127.0.0.1:4099",
    token: "token",
    get: async (path) => values[path] as never,
    post: async () => undefined as never,
    postForm: async () => undefined as never,
    put: async () => undefined as never,
    patch: async () => undefined as never,
    delete: async () => undefined,
  };
}

function Probe(props: { client: ApiClient; onRefetch: () => void }) {
  const bootstrap = useGatewayBootstrap({
    apiClient: props.client,
    refetchConversations: props.onRefetch,
  });
  return (
    <div>
      <span data-testid="profile">{bootstrap.profile?.id ?? ""}</span>
      <span data-testid="agents">{bootstrap.agents.map((item) => item.id).join(",")}</span>
      <span data-testid="selected">{bootstrap.selectedAgentId}</span>
      <span data-testid="tool-groups">{bootstrap.toolCatalog.map((group) => group.id).join(",")}</span>
    </div>
  );
}

describe("useGatewayBootstrap", () => {
  test("loads profile, agents, and tool catalog when the API client becomes available", async () => {
    let refetchCount = 0;
    render(
      <Probe
        client={clientReturning({
          "/v1/profile": { id: "profile-a", name: "Profile A", activeAgentId: "agent-a" },
          "/v1/agents": { items: [agent] },
          "/v1/tools/catalog": { groups: catalog },
        })}
        onRefetch={() => {
          refetchCount += 1;
        }}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("profile").textContent).toBe("profile-a"));
    expect(screen.getByTestId("agents").textContent).toBe("agent-a");
    expect(screen.getByTestId("selected").textContent).toBe("agent-a");
    expect(screen.getByTestId("tool-groups").textContent).toBe("workspace");
    expect(refetchCount).toBe(1);
  });
});
