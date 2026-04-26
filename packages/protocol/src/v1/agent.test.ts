import { describe, expect, test } from "bun:test";
import {
  AgentSchema,
  SaveAgentRequestSchema,
  AGENT_TOOL_NAMES,
  type Agent,
} from "./agent";
import type { Workspace } from "./workspace";

const ws: Workspace = {
  id: "vulture" as Workspace["id"],
  name: "Vulture",
  path: "/tmp/vulture",
  createdAt: "2026-04-26T00:00:00.000Z" as Workspace["createdAt"],
  updatedAt: "2026-04-26T00:00:00.000Z" as Workspace["updatedAt"],
};

const sampleAgent: Agent = {
  id: "local-work-agent" as Agent["id"],
  name: "Local Work Agent",
  description: "General assistant",
  model: "gpt-5.4",
  reasoning: "medium",
  tools: ["shell.exec" as Agent["tools"][number]],
  workspace: ws,
  instructions: "Be concise.",
  createdAt: "2026-04-26T00:00:00.000Z" as Agent["createdAt"],
  updatedAt: "2026-04-26T00:00:00.000Z" as Agent["updatedAt"],
};

describe("Agent schema", () => {
  test("parses a valid agent", () => {
    expect(AgentSchema.parse(sampleAgent)).toEqual(sampleAgent);
  });

  test("rejects unknown tool name", () => {
    expect(() =>
      AgentSchema.parse({ ...sampleAgent, tools: ["file.write"] }),
    ).toThrow();
  });

  test("rejects unknown reasoning level", () => {
    expect(() =>
      AgentSchema.parse({ ...sampleAgent, reasoning: "extreme" }),
    ).toThrow();
  });

  test("SaveAgentRequest accepts optional workspace", () => {
    const req = SaveAgentRequestSchema.parse({
      id: "x",
      name: "X",
      description: "x",
      model: "gpt-5.4",
      reasoning: "low",
      tools: [],
      instructions: "x",
    });
    expect(req.workspace).toBeUndefined();
  });

  test("AGENT_TOOL_NAMES is non-empty", () => {
    expect(AGENT_TOOL_NAMES.length).toBeGreaterThan(0);
  });
});
