import type { Agent } from "../../api/agents";

/**
 * Shared "Local Agent" fixture used by AgentsPage / AgentEditModal /
 * editAgentTabs / HistoryDrawer tests. Centralised so a future change to
 * the Agent shape (e.g. a required field added) breaks the tests in one
 * place rather than three. Values are typed against the canonical Agent
 * interface — no `as` casts elsewhere.
 */
export const localAgentFixture: Agent = {
  id: "agent-1",
  name: "Local Agent",
  description: "test agent",
  model: "gpt-5.4",
  reasoning: "medium",
  tools: ["read", "shell.exec"],
  toolPreset: "developer",
  toolInclude: ["read"],
  toolExclude: [],
  workspace: {
    id: "agent-1",
    name: "Local Agent",
    path: "/tmp/workspace",
    createdAt: "2026-04-30T00:00:00.000Z",
    updatedAt: "2026-04-30T00:00:00.000Z",
  },
  instructions: "behave",
  createdAt: "2026-04-30T00:00:00.000Z",
  updatedAt: "2026-04-30T00:00:00.000Z",
};
