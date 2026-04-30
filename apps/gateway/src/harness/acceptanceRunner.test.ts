import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../server";
import { runAcceptanceScenario, type AcceptanceScenario } from "./acceptanceRunner";

const TOKEN = "x".repeat(43);

function makeHarness() {
  const root = mkdtempSync(join(tmpdir(), "vulture-acceptance-"));
  const profileDir = join(root, "profile");
  const workspaceDir = join(root, "workspace");
  const artifactDir = join(root, "artifacts");
  const makeApp = () => buildServer({
    port: 4099,
    token: TOKEN,
    shellCallbackUrl: "http://127.0.0.1:4199",
    shellPid: process.pid,
    profileDir,
    privateWorkspaceHomeDir: workspaceDir,
  });
  return {
    app: makeApp(),
    artifactDir,
    profileDir,
    restartApp: makeApp,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("acceptance harness runner", () => {
  test("runs a conversation scenario and writes replayable artifacts", async () => {
    const { app, artifactDir, cleanup } = makeHarness();
    const scenario: AcceptanceScenario = {
      id: "conversation-happy-path",
      name: "Conversation happy path",
      steps: [
        { action: "createConversation", as: "conversation", agentId: "local-work-agent" },
        { action: "sendMessage", conversation: "conversation", input: "ping", asRun: "run" },
        { action: "waitForRun", run: "run", status: "succeeded" },
        { action: "listMessages", conversation: "conversation", as: "messages" },
        { action: "assertMessages", messages: "messages", roles: ["user", "assistant"] },
      ],
    };

    const result = await runAcceptanceScenario({
      app,
      token: TOKEN,
      scenario,
      artifactDir,
      pollIntervalMs: 5,
      timeoutMs: 2_000,
    });

    expect(result.status).toBe("passed");
    expect(result.steps.map((step) => step.status)).toEqual(["passed", "passed", "passed", "passed", "passed"]);
    expect(existsSync(join(result.artifactPath, "summary.json"))).toBe(true);
    expect(existsSync(join(result.artifactPath, "transcript.md"))).toBe(true);

    const summary = JSON.parse(readFileSync(join(result.artifactPath, "summary.json"), "utf8")) as {
      scenarioId: string;
      status: string;
      resources: { runs: Record<string, { id: string; status: string }> };
    };
    expect(summary.scenarioId).toBe(scenario.id);
    expect(summary.status).toBe("passed");
    expect(summary.resources.runs.run.status).toBe("succeeded");

    const transcript = readFileSync(join(result.artifactPath, "transcript.md"), "utf8");
    expect(transcript).toContain("# Conversation happy path");
    expect(transcript).toContain("ping");
    expect(transcript).toContain("assistant");
    cleanup();
  });

  test("marks a scenario failed and still writes artifacts", async () => {
    const { app, artifactDir, cleanup } = makeHarness();
    const scenario: AcceptanceScenario = {
      id: "message-role-failure",
      name: "Message role failure",
      steps: [
        { action: "createConversation", as: "conversation", agentId: "local-work-agent" },
        { action: "sendMessage", conversation: "conversation", input: "ping", asRun: "run" },
        { action: "waitForRun", run: "run", status: "succeeded" },
        { action: "listMessages", conversation: "conversation", as: "messages" },
        { action: "assertMessages", messages: "messages", roles: ["assistant"] },
      ],
    };

    const result = await runAcceptanceScenario({
      app,
      token: TOKEN,
      scenario,
      artifactDir,
      pollIntervalMs: 5,
      timeoutMs: 2_000,
    });

    expect(result.status).toBe("failed");
    expect(result.steps.at(-1)?.status).toBe("failed");
    expect(result.steps.at(-1)?.error).toContain("Expected message roles");
    expect(existsSync(join(result.artifactPath, "summary.json"))).toBe(true);
    expect(existsSync(join(result.artifactPath, "transcript.md"))).toBe(true);
    cleanup();
  });

  test("can restart the gateway and verify interrupted non-idempotent tool runs are recoverable", async () => {
    const { app, artifactDir, profileDir, restartApp, cleanup } = makeHarness();
    const scenario: AcceptanceScenario = {
      id: "recovery-interrupted-tool",
      name: "Recovery interrupted tool",
      steps: [
        { action: "createConversation", as: "conversation", agentId: "local-work-agent" },
        {
          action: "seedInterruptedToolRun",
          conversation: "conversation",
          asRun: "run",
          runId: "r-acceptance-tool",
          tool: "shell.exec",
          callId: "tc-acceptance",
        },
        { action: "restartGateway" },
        { action: "waitForRun", run: "run", status: "recoverable" },
      ],
    };

    const result = await runAcceptanceScenario({
      app,
      token: TOKEN,
      scenario,
      artifactDir,
      profileDir,
      restartApp,
      pollIntervalMs: 5,
      timeoutMs: 2_000,
    });

    expect(result.status).toBe("passed");
    expect(result.resources.runs.run.status).toBe("recoverable");
    const transcript = readFileSync(join(result.artifactPath, "transcript.md"), "utf8");
    expect(transcript).toContain("Recovery interrupted tool");
    cleanup();
  });

  test("uploads a text attachment and verifies it is linked to the user message", async () => {
    const { app, artifactDir, cleanup } = makeHarness();
    const scenario: AcceptanceScenario = {
      id: "attachment-message-link",
      name: "Attachment message link",
      steps: [
        { action: "createConversation", as: "conversation", agentId: "local-work-agent" },
        {
          action: "uploadTextAttachment",
          as: "attachment",
          fileName: "notes.txt",
          content: "hello from attachment",
          mimeType: "text/plain",
        },
        {
          action: "sendMessage",
          conversation: "conversation",
          input: "read this attachment",
          attachmentIds: ["attachment"],
          asRun: "run",
          asMessage: "userMessage",
        },
        { action: "waitForRun", run: "run", status: "succeeded" },
        { action: "assertMessageAttachment", message: "userMessage", displayName: "notes.txt", mimeType: "text/plain" },
      ],
    };

    const result = await runAcceptanceScenario({
      app,
      token: TOKEN,
      scenario,
      artifactDir,
      pollIntervalMs: 5,
      timeoutMs: 2_000,
    });

    expect(result.status).toBe("passed");
    expect(result.resources.attachments.attachment.displayName).toBe("notes.txt");
    expect(result.resources.attachments.attachment.mimeType).toStartWith("text/plain");
    expect(result.resources.messages.userMessage.attachments?.map((item) => item.displayName)).toEqual(["notes.txt"]);
    cleanup();
  });

  test("reads run events and verifies terminal event is replayed on caught-up reconnect", async () => {
    const { app, artifactDir, cleanup } = makeHarness();
    const scenario: AcceptanceScenario = {
      id: "run-event-terminal-replay",
      name: "Run event terminal replay",
      steps: [
        { action: "createConversation", as: "conversation", agentId: "local-work-agent" },
        { action: "sendMessage", conversation: "conversation", input: "ping", asRun: "run" },
        { action: "waitForRun", run: "run", status: "succeeded" },
        { action: "readRunEvents", run: "run", as: "events" },
        { action: "assertRunEvents", events: "events", types: ["run.started", "run.completed"] },
        { action: "readRunEvents", run: "run", as: "terminalReplay", lastSeqFrom: "events" },
        { action: "assertRunEvents", events: "terminalReplay", types: ["run.completed"] },
      ],
    };

    const result = await runAcceptanceScenario({
      app,
      token: TOKEN,
      scenario,
      artifactDir,
      pollIntervalMs: 5,
      timeoutMs: 2_000,
    });

    expect(result.status).toBe("passed");
    expect(result.resources.runEvents.events.map((event) => event.type)).toContain("run.completed");
    expect(result.resources.runEvents.terminalReplay.map((event) => event.type)).toEqual(["run.completed"]);
    cleanup();
  });

  test("lists recoverable runs after gateway restart", async () => {
    const { app, artifactDir, profileDir, restartApp, cleanup } = makeHarness();
    const scenario: AcceptanceScenario = {
      id: "recovery-list-recoverable-runs",
      name: "Recovery list recoverable runs",
      steps: [
        { action: "createConversation", as: "conversation", agentId: "local-work-agent" },
        {
          action: "seedInterruptedToolRun",
          conversation: "conversation",
          asRun: "run",
          runId: "r-acceptance-list-tool",
          tool: "shell.exec",
          callId: "tc-acceptance-list",
        },
        { action: "restartGateway" },
        { action: "waitForRun", run: "run", status: "recoverable" },
        { action: "listConversationRuns", conversation: "conversation", status: "recoverable", as: "recoverableRuns" },
        { action: "assertRuns", runs: "recoverableRuns", statuses: ["recoverable"], containsRun: "run" },
      ],
    };

    const result = await runAcceptanceScenario({
      app,
      token: TOKEN,
      scenario,
      artifactDir,
      profileDir,
      restartApp,
      pollIntervalMs: 5,
      timeoutMs: 2_000,
    });

    expect(result.status).toBe("passed");
    expect(result.resources.runLists.recoverableRuns.map((run) => run.id)).toEqual(["r-acceptance-list-tool"]);
    cleanup();
  });

  test("lists active runs for restore queries", async () => {
    const { app, artifactDir, profileDir, cleanup } = makeHarness();
    const scenario: AcceptanceScenario = {
      id: "restore-list-active-runs",
      name: "Restore list active runs",
      steps: [
        { action: "createConversation", as: "conversation", agentId: "local-work-agent" },
        {
          action: "seedRunningRun",
          conversation: "conversation",
          asRun: "run",
          runId: "r-acceptance-active",
        },
        { action: "listConversationRuns", conversation: "conversation", status: "active", as: "activeRuns" },
        { action: "assertRuns", runs: "activeRuns", statuses: ["running"], containsRun: "run" },
      ],
    };

    const result = await runAcceptanceScenario({
      app,
      token: TOKEN,
      scenario,
      artifactDir,
      profileDir,
      pollIntervalMs: 5,
      timeoutMs: 2_000,
    });

    expect(result.status).toBe("passed");
    expect(result.resources.runLists.activeRuns.map((run) => run.id)).toEqual(["r-acceptance-active"]);
    cleanup();
  });

  test("cancels a seeded active run and records the cancellation event", async () => {
    const { app, artifactDir, profileDir, cleanup } = makeHarness();
    const scenario: AcceptanceScenario = {
      id: "run-cancel-active",
      name: "Run cancel active",
      steps: [
        { action: "createConversation", as: "conversation", agentId: "local-work-agent" },
        { action: "seedRunningRun", conversation: "conversation", asRun: "run", runId: "r-acceptance-cancel" },
        { action: "cancelRun", run: "run" },
        { action: "waitForRun", run: "run", status: "cancelled" },
        { action: "readRunEvents", run: "run", as: "events" },
        { action: "assertRunEvents", events: "events", types: ["run.cancelled"] },
      ],
    };

    const result = await runAcceptanceScenario({
      app,
      token: TOKEN,
      scenario,
      artifactDir,
      profileDir,
      pollIntervalMs: 5,
      timeoutMs: 2_000,
    });

    expect(result.status).toBe("passed");
    expect(result.resources.runs.run.status).toBe("cancelled");
    expect(result.resources.runEvents.events.map((event) => event.type)).toContain("run.cancelled");
    cleanup();
  });

  test("reuses the same run for duplicate create-run idempotency keys", async () => {
    const { app, artifactDir, cleanup } = makeHarness();
    const scenario: AcceptanceScenario = {
      id: "run-create-idempotency",
      name: "Run create idempotency",
      steps: [
        { action: "createConversation", as: "conversation", agentId: "local-work-agent" },
        {
          action: "sendMessage",
          conversation: "conversation",
          input: "idempotent ping",
          asRun: "firstRun",
          idempotencyKey: "acceptance-idempotent-run",
        },
        {
          action: "sendMessage",
          conversation: "conversation",
          input: "idempotent ping",
          asRun: "secondRun",
          idempotencyKey: "acceptance-idempotent-run",
          sameRunAs: "firstRun",
        },
        { action: "waitForRun", run: "firstRun", status: "succeeded" },
      ],
    };

    const result = await runAcceptanceScenario({
      app,
      token: TOKEN,
      scenario,
      artifactDir,
      pollIntervalMs: 5,
      timeoutMs: 2_000,
    });

    expect(result.status).toBe("passed");
    expect(result.resources.runs.secondRun.id).toBe(result.resources.runs.firstRun.id);
    cleanup();
  });

  test("reads uploaded attachment content", async () => {
    const { app, artifactDir, cleanup } = makeHarness();
    const scenario: AcceptanceScenario = {
      id: "attachment-content-fetch",
      name: "Attachment content fetch",
      steps: [
        {
          action: "uploadTextAttachment",
          as: "attachment",
          fileName: "content.txt",
          content: "content endpoint ok",
          mimeType: "text/plain",
        },
        { action: "readAttachmentContent", attachment: "attachment", as: "content" },
        { action: "assertAttachmentContent", content: "content", equals: "content endpoint ok" },
      ],
    };

    const result = await runAcceptanceScenario({
      app,
      token: TOKEN,
      scenario,
      artifactDir,
      pollIntervalMs: 5,
      timeoutMs: 2_000,
    });

    expect(result.status).toBe("passed");
    expect(result.resources.attachmentContents.content).toBe("content endpoint ok");
    cleanup();
  });

  test("creates and verifies MCP server configuration without starting external tools", async () => {
    const { app, artifactDir, cleanup } = makeHarness();
    const scenario: AcceptanceScenario = {
      id: "mcp-config-management",
      name: "MCP config management",
      steps: [
        {
          action: "createMcpServer",
          as: "server",
          id: "acceptance-mcp",
          name: "Acceptance MCP",
          command: "bun",
          trust: "disabled",
          enabled: true,
          enabledTools: ["echo"],
          disabledTools: ["write_file"],
        },
        { action: "listMcpServers", as: "servers" },
        {
          action: "assertMcpServers",
          servers: "servers",
          containsServer: "server",
          runtimeStatuses: ["disconnected"],
        },
        { action: "listMcpTools", server: "server", as: "tools" },
        { action: "assertMcpTools", tools: "tools", names: [] },
      ],
    };

    const result = await runAcceptanceScenario({
      app,
      token: TOKEN,
      scenario,
      artifactDir,
      pollIntervalMs: 5,
      timeoutMs: 2_000,
    });

    expect(result.status).toBe("passed");
    expect(result.resources.mcpServers.server.id).toBe("acceptance-mcp");
    expect(result.resources.mcpServerLists.servers.map((server) => server.id)).toContain("acceptance-mcp");
    expect(result.resources.mcpToolLists.tools).toEqual([]);
    cleanup();
  });

  test("runs a configured subagent product workflow fixture", async () => {
    const { app, artifactDir, profileDir, cleanup } = makeHarness();
    const scenario: AcceptanceScenario = {
      id: "agent-configured-subagent-product-workflow",
      name: "Agent configured subagent product workflow",
      steps: [
        {
          action: "writeSkill",
          as: "skill",
          name: "harness-review",
          description: "Reviews harness readiness.",
          body: "Check runtime, tool contracts, and product acceptance.",
        },
        {
          action: "createAgent",
          as: "researcher",
          id: "researcher",
          name: "Researcher",
          description: "Finds focused facts.",
          tools: ["read", "web_search", "sessions_yield"],
          skills: [],
          handoffAgentIds: [],
          instructions: "Return concise research findings.",
        },
        {
          action: "createAgent",
          as: "lead",
          id: "lead-agent",
          name: "Lead Agent",
          description: "Coordinates product work.",
          tools: ["read", "sessions_spawn", "sessions_yield", "sessions_history", "update_plan"],
          skills: ["harness-review"],
          handoffAgentIds: ["researcher"],
          instructions: "Suggest subagents only when useful and summarize their results.",
        },
        { action: "createConversation", as: "conversation", agentId: "lead-agent" },
        {
          action: "seedApprovedSubagentWorkflow",
          conversation: "conversation",
          asRun: "run",
          asSubagent: "subagent",
          childAgentId: "researcher",
          label: "Harness review",
          userInput: "Audit harness engineering and summarize the next risks.",
          childResult: "Runtime, tool contract, and product acceptance lanes are covered.",
          finalText: "子智能体完成审计：runtime、tool contract、product acceptance 已覆盖。",
        },
        { action: "readRunEvents", run: "run", as: "events" },
        { action: "assertRunEvents", events: "events", types: ["tool.ask", "tool.started", "tool.completed", "run.completed"] },
        { action: "listSubagentSessions", parentConversation: "conversation", parentRun: "run", as: "subagents" },
        { action: "assertSubagentSessions", sessions: "subagents", containsSession: "subagent", parentConversation: "conversation", parentRun: "run", statuses: ["active"] },
        { action: "listSubagentMessages", session: "subagent", as: "subagentMessages" },
        { action: "assertMessages", messages: "subagentMessages", roles: ["user", "assistant"], contains: ["Runtime, tool contract"] },
        { action: "listMessages", conversation: "conversation", as: "messages" },
        { action: "assertMessages", messages: "messages", roles: ["user", "assistant"], contains: ["子智能体完成审计"] },
      ],
    };

    const result = await runAcceptanceScenario({
      app,
      token: TOKEN,
      scenario,
      artifactDir,
      profileDir,
      pollIntervalMs: 5,
      timeoutMs: 2_000,
    });

    expect(result.status).toBe("passed");
    expect(result.resources.agents.lead.handoffAgentIds).toEqual(["researcher"]);
    expect(result.resources.skills.skill.name).toBe("harness-review");
    expect(result.resources.runEvents.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["tool.ask", "tool.started", "tool.completed", "run.completed"]),
    );
    cleanup();
  });
});
