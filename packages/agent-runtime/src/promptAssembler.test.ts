import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleAgentInstructions, assembleCodexPrompt } from "./promptAssembler";

function fakePack(dir: string) {
  const p = join(dir, "local-work");
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "SOUL.md"), "# Soul section");
  writeFileSync(join(p, "IDENTITY.md"), "# Identity section");
  writeFileSync(join(p, "AGENTS.md"), "# Default agents");
  writeFileSync(join(p, "TOOLS.md"), "# Tools section");
  writeFileSync(join(p, "USER.md"), "# User section\n禁止回复待命话术");
  return p;
}

const agent = {
  id: "local-work-agent",
  name: "Local Work Agent",
  description: "general",
  model: "gpt-5.4",
  reasoning: "medium",
  tools: ["shell.exec"],
  handoffs: [],
  instructions: "Be concise.",
};

const workspace = { id: "vulture", name: "Vulture", path: "/tmp/vulture" };

describe("promptAssembler", () => {
  test("includes all sections + agent identity + workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-pack-"));
    const packDir = fakePack(dir);
    const text = assembleAgentInstructions({ packDir, agent, workspace });
    expect(text).toContain("# Soul section");
    expect(text).toContain("# Identity section");
    expect(text).toContain("禁止回复待命话术");
    expect(text).toContain("Local Work Agent");
    expect(text).toContain("/tmp/vulture");
    expect(text).toContain("Be concise.");
    rmSync(dir, { recursive: true });
  });

  test("assembleCodexPrompt appends user task", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-pack-"));
    const packDir = fakePack(dir);
    const text = assembleCodexPrompt({
      packDir,
      agent,
      workspace,
      userInput: "Summarize the repo",
    });
    expect(text).toContain("User task:\nSummarize the repo");
    rmSync(dir, { recursive: true });
  });

  test("includes configured handoff agents with sessions_spawn guidance", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-pack-"));
    const packDir = fakePack(dir);
    const text = assembleAgentInstructions({
      packDir,
      agent: {
        ...agent,
        handoffs: [
          {
            id: "researcher",
            name: "Researcher",
            description: "Finds external and local facts",
          },
        ],
      },
      workspace,
    });
    expect(text).toContain("### Available Handoffs");
    expect(text).toContain("researcher");
    expect(text).toContain("sessions_spawn");
    expect(text).toContain("Decide autonomously whether a subagent is useful");
    expect(text).toContain("The user does not need to manually request or name a subagent");
    expect(text).toContain("the approval card is the user confirmation");
    rmSync(dir, { recursive: true });
  });
});
