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
  toolPreset: "none",
  toolInclude: ["shell.exec" as Agent["tools"][number]],
  toolExclude: [],
  skills: ["csv-insights"],
  handoffAgentIds: ["researcher"],
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

  test("SaveAgentRequest accepts optional skills allowlist", () => {
    const req = SaveAgentRequestSchema.parse({
      id: "x",
      name: "X",
      description: "x",
      model: "gpt-5.4",
      reasoning: "low",
      tools: [],
      skills: [],
      instructions: "x",
    });
    expect(req.skills).toEqual([]);
  });

  test("SaveAgentRequest accepts optional handoff agent ids", () => {
    const req = SaveAgentRequestSchema.parse({
      id: "x",
      name: "X",
      description: "x",
      model: "gpt-5.4",
      reasoning: "low",
      tools: [],
      handoffAgentIds: ["researcher"],
      instructions: "x",
    });
    expect(req.handoffAgentIds).toEqual(["researcher"]);
  });

  test("SaveAgentRequest accepts tool preset policy", () => {
    const req = SaveAgentRequestSchema.parse({
      id: "x",
      name: "X",
      description: "x",
      model: "gpt-5.4",
      reasoning: "low",
      toolPreset: "developer",
      toolInclude: [],
      toolExclude: ["browser.click"],
      instructions: "x",
    });
    expect(req.toolPreset).toBe("developer");
    expect(req.toolExclude).toEqual(["browser.click"]);
  });

  test("AGENT_TOOL_NAMES is non-empty", () => {
    expect(AGENT_TOOL_NAMES.length).toBeGreaterThan(0);
  });
});

import { AGENT_TOOL_PRESETS } from "./agent";

describe("foundation tool additions", () => {
  test("AGENT_TOOL_NAMES includes the six new tools", () => {
    expect(AGENT_TOOL_NAMES).toContain("grep");
    expect(AGENT_TOOL_NAMES).toContain("glob");
    expect(AGENT_TOOL_NAMES).toContain("lsp.diagnostics");
    expect(AGENT_TOOL_NAMES).toContain("lsp.definition");
    expect(AGENT_TOOL_NAMES).toContain("lsp.references");
    expect(AGENT_TOOL_NAMES).toContain("lsp.hover");
  });

  test("minimal preset gains grep + glob, no LSP", () => {
    expect(AGENT_TOOL_PRESETS.minimal).toContain("grep");
    expect(AGENT_TOOL_PRESETS.minimal).toContain("glob");
    expect(AGENT_TOOL_PRESETS.minimal).not.toContain("lsp.diagnostics");
  });

  test("standard preset gains grep + glob, no LSP", () => {
    expect(AGENT_TOOL_PRESETS.standard).toContain("grep");
    expect(AGENT_TOOL_PRESETS.standard).toContain("glob");
    expect(AGENT_TOOL_PRESETS.standard).not.toContain("lsp.definition");
  });

  test("developer preset gains all six new tools", () => {
    for (const name of ["grep", "glob", "lsp.diagnostics", "lsp.definition", "lsp.references", "lsp.hover"] as const) {
      expect(AGENT_TOOL_PRESETS.developer).toContain(name);
    }
  });

  test("tl preset gains grep + glob, no LSP", () => {
    expect(AGENT_TOOL_PRESETS.tl).toContain("grep");
    expect(AGENT_TOOL_PRESETS.tl).toContain("glob");
    expect(AGENT_TOOL_PRESETS.tl).not.toContain("lsp.hover");
  });

  test("full preset stays equal to AGENT_TOOL_NAMES", () => {
    expect([...AGENT_TOOL_PRESETS.full]).toEqual([...AGENT_TOOL_NAMES]);
  });
});
