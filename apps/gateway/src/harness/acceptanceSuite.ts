import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import {
  writeHarnessFailureReport,
  writeHarnessJUnitReport,
  writeHarnessManifest,
  type HarnessResultReport,
} from "@vulture/harness-core";
import {
  runAcceptanceScenario,
  type AcceptanceRunResult,
  type AcceptanceScenario,
} from "./acceptanceRunner";
import type { ScriptedLlmController } from "../runtime/scriptedLlm";

export const defaultAcceptanceScenarios: AcceptanceScenario[] = [
  {
    id: "conversation-happy-path",
    name: "Conversation happy path",
    description: "Creates a conversation, sends one message, waits for the run, and verifies user plus assistant messages.",
    tags: ["fast", "chat"],
    steps: [
      { action: "createConversation", as: "conversation", agentId: "local-work-agent" },
      { action: "sendMessage", conversation: "conversation", input: "ping", asRun: "run", asMessage: "userMessage" },
      { action: "waitForRun", run: "run", status: "succeeded" },
      { action: "listMessages", conversation: "conversation", as: "messages" },
      { action: "assertMessages", messages: "messages", roles: ["user", "assistant"], contains: ["ping"] },
    ],
  },
  {
    id: "recovery-interrupted-tool",
    name: "Recovery interrupted tool",
    description: "Seeds a running non-idempotent tool call, restarts the gateway, and verifies the run is recoverable instead of auto-replayed.",
    tags: ["fast", "recovery", "tools"],
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
  },
  {
    id: "attachment-message-link",
    name: "Attachment message link",
    description: "Uploads a text attachment, sends it with a message, and verifies the persisted user message keeps the attachment metadata.",
    tags: ["fast", "attachments"],
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
  },
  {
    id: "run-event-terminal-replay",
    name: "Run event terminal replay",
    description: "Reads the run SSE stream after completion, then reconnects from the latest seq and verifies the terminal event is replayed.",
    tags: ["fast", "sse", "reconnect"],
    steps: [
      { action: "createConversation", as: "conversation", agentId: "local-work-agent" },
      { action: "sendMessage", conversation: "conversation", input: "ping", asRun: "run" },
      { action: "waitForRun", run: "run", status: "succeeded" },
      { action: "readRunEvents", run: "run", as: "events" },
      { action: "assertRunEvents", events: "events", types: ["run.started", "run.completed"] },
      { action: "readRunEvents", run: "run", as: "terminalReplay", lastSeqFrom: "events" },
      { action: "assertRunEvents", events: "terminalReplay", types: ["run.completed"] },
    ],
  },
  {
    id: "recovery-list-recoverable-runs",
    name: "Recovery list recoverable runs",
    description: "Seeds an interrupted tool run, restarts the gateway, and verifies the conversation recoverable-run query returns it.",
    tags: ["fast", "recovery", "restore"],
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
  },
  {
    id: "restore-list-active-runs",
    name: "Restore list active runs",
    description: "Seeds a running run and verifies the conversation active-run query returns it for restore effects.",
    tags: ["fast", "recovery", "restore"],
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
  },
  {
    id: "run-cancel-active",
    name: "Run cancel active",
    description: "Seeds a running run, cancels it, and verifies cancellation status and event stream output.",
    tags: ["fast", "runs"],
    steps: [
      { action: "createConversation", as: "conversation", agentId: "local-work-agent" },
      {
        action: "seedRunningRun",
        conversation: "conversation",
        asRun: "run",
        runId: "r-acceptance-cancel",
      },
      { action: "cancelRun", run: "run" },
      { action: "waitForRun", run: "run", status: "cancelled" },
      { action: "readRunEvents", run: "run", as: "events" },
      { action: "assertRunEvents", events: "events", types: ["run.cancelled"] },
    ],
  },
  {
    id: "run-create-idempotency",
    name: "Run create idempotency",
    description: "Sends the same create-run request twice with one idempotency key and verifies the cached run is reused.",
    tags: ["fast", "idempotency", "runs"],
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
  },
  {
    id: "attachment-content-fetch",
    name: "Attachment content fetch",
    description: "Uploads a text attachment and verifies the content endpoint returns the uploaded bytes.",
    tags: ["fast", "attachments"],
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
  },
  {
    id: "mcp-config-management",
    name: "MCP config management",
    description: "Creates a disabled MCP server config, verifies it is listed, and verifies tools stay empty without launching external processes.",
    tags: ["fast", "mcp"],
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
  },
  {
    id: "subagent-spawn-yield-history",
    name: "Subagent spawn yield history",
    description: "Seeds a parent run and durable child subagent session, then verifies list/history survive restart.",
    tags: ["fast", "subagents", "recovery"],
    steps: [
      { action: "createConversation", as: "conversation", agentId: "local-work-agent" },
      {
        action: "seedRunningRun",
        conversation: "conversation",
        asRun: "parentRun",
        runId: "r-acceptance-subagent-parent",
      },
      {
        action: "seedSubagentSession",
        parentConversation: "conversation",
        parentRun: "parentRun",
        as: "subagent",
        agentId: "local-work-agent",
        label: "Read child docs",
        messages: [
          { role: "user", content: "child task" },
          { role: "assistant", content: "child result" },
        ],
      },
      {
        action: "listSubagentSessions",
        parentConversation: "conversation",
        parentRun: "parentRun",
        as: "subagents",
      },
      {
        action: "assertSubagentSessions",
        sessions: "subagents",
        containsSession: "subagent",
        parentConversation: "conversation",
        parentRun: "parentRun",
        statuses: ["active"],
      },
      { action: "listSubagentMessages", session: "subagent", as: "subagentMessages" },
      {
        action: "assertMessages",
        messages: "subagentMessages",
        roles: ["user", "assistant"],
        contains: ["child result"],
      },
      { action: "restartGateway" },
      {
        action: "listSubagentSessions",
        parentConversation: "conversation",
        parentRun: "parentRun",
        as: "subagentsAfterRestart",
      },
      {
        action: "assertSubagentSessions",
        sessions: "subagentsAfterRestart",
        containsSession: "subagent",
        parentConversation: "conversation",
        parentRun: "parentRun",
        statuses: ["active"],
      },
    ],
  },
  {
    id: "agent-configured-subagent-product-workflow",
    name: "Agent configured subagent product workflow",
    description: "Configures a lead agent with tools, a skill, and a child agent, then verifies the approved subagent workflow is visible end to end.",
    tags: ["product", "subagents", "skills", "tools", "fast"],
    steps: [
      {
        action: "writeSkill",
        as: "skill",
        name: "harness-review",
        description: "Reviews harness readiness.",
        body: "Check runtime, tool contracts, and product acceptance before summarizing.",
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
        title: "Audit harness product path",
        task: "Inspect runtime coverage and confirm the parent can recover completed child results.",
        userInput: "Audit harness engineering and summarize the next risks.",
        childResult: "Runtime, tool contract, and product acceptance lanes are covered.",
        finalText:
          "子智能体完成审计：Audit harness product path - Runtime, tool contract, and product acceptance lanes are covered.",
      },
      { action: "readRunEvents", run: "run", as: "events" },
      {
        action: "assertRunEvents",
        events: "events",
        types: ["tool.ask", "tool.started", "tool.completed", "tool.planned", "run.completed"],
      },
      { action: "listSubagentSessions", parentConversation: "conversation", parentRun: "run", as: "subagents" },
      {
        action: "assertSubagentSessions",
        sessions: "subagents",
        containsSession: "subagent",
        parentConversation: "conversation",
        parentRun: "run",
        statuses: ["completed"],
        titles: ["Audit harness product path"],
        tasks: ["Inspect runtime coverage and confirm the parent can recover completed child results."],
        resultSummaries: ["Runtime, tool contract, and product acceptance lanes are covered."],
      },
      { action: "listSubagentMessages", session: "subagent", as: "subagentMessages" },
      {
        action: "assertMessages",
        messages: "subagentMessages",
        roles: ["user", "assistant"],
        contains: ["Runtime, tool contract"],
      },
      { action: "listMessages", conversation: "conversation", as: "messages" },
      {
        action: "assertMessages",
        messages: "messages",
        roles: ["user", "assistant"],
        contains: [
          "子智能体完成审计",
          "Audit harness product path",
          "Runtime, tool contract, and product acceptance lanes are covered.",
        ],
      },
    ],
  },
  {
    id: "mcp-real-handshake",
    name: "MCP real stdio handshake",
    description:
      "Spawns the bundled echo MCP fixture as a real child process, completes the stdio handshake through the gateway, and verifies the live tool list contains the fixture's 'echo' tool. Catches regressions in MCP framing, capability negotiation, and tool registration that the stub-only mcp-config-management scenario cannot see.",
    tags: ["mcp", "integration"],
    steps: [
      {
        action: "createMcpServer",
        as: "echoServer",
        id: "acceptance-mcp-echo",
        name: "Acceptance MCP Echo",
        command: "bun",
        args: ["src/harness/fixtures/echoMcpServer.ts"],
        trust: "trusted",
        enabled: true,
      },
      { action: "listMcpTools", server: "echoServer", as: "tools" },
      // listMcpTools succeeding proves the gateway connected to a real MCP
      // child and completed initialize/tools-list handshake — a stub or
      // disconnected server would return an empty list. The names check
      // locks the fixture's contract.
      { action: "assertMcpTools", tools: "tools", names: ["echo"] },
      { action: "listMcpServers", as: "servers" },
      // Use containsServer rather than runtimeStatuses array-equality:
      // earlier scenarios in the suite leave their own server entries
      // behind, so an exact-array assertion is brittle.
      {
        action: "assertMcpServers",
        servers: "servers",
        containsServer: "echoServer",
      },
      // Tear down so the child stdio process disconnects before the harness
      // process tries to exit. Without this, the orphan MCP child keeps the
      // parent alive and harness:ci hangs after the suite returns.
      { action: "deleteMcpServer", server: "echoServer" },
    ],
  },
  {
    id: "approval-route-boundaries",
    name: "Approval HTTP route boundary cases",
    description:
      "Exercises POST /v1/runs/:rid/approvals at the acceptance layer. Until the harness can script LLM tool calls inside acceptance, full allow→execute / deny→refuse is covered only by runs.test.ts unit tests; this scenario locks the HTTP wiring (404 when no pending callId, 400 on invalid decision) so a routing regression surfaces here without needing real LLM traffic.",
    tags: ["fast", "approvals", "tools"],
    steps: [
      { action: "createConversation", as: "conversation" },
      {
        action: "seedRunningRun",
        conversation: "conversation",
        asRun: "run",
        runId: "r-acceptance-approval",
      },
      {
        action: "postApproval",
        run: "run",
        callId: "no-such-call",
        decision: "allow",
        expectStatus: 404,
      },
      {
        action: "postApproval",
        run: "run",
        callId: "no-such-call",
        decision: "deny",
        expectStatus: 404,
      },
      {
        action: "postApproval",
        run: "run",
        callId: "any",
        decision: "maybe",
        expectStatus: 400,
      },
    ],
  },
  {
    id: "scripted-llm-text-yield",
    name: "Scripted LLM produces deterministic assistant text",
    description:
      "Demonstrates the per-scenario llmScript injection path: the gateway routes the run through the shared ScriptedLlmController (instead of the stub fallback), and the assistant message contains exactly the scripted final text. This is the foundation for richer scripted scenarios (tool calls, approval flow, multi-turn) without needing a real LLM.",
    tags: ["fast", "scripted-llm", "chat"],
    llmScript: {
      yields: [
        { kind: "text.delta", text: "scripted hello " },
        { kind: "usage", usage: { inputTokens: 5, outputTokens: 7 } },
        { kind: "final", text: "scripted hello — acceptance LLM script reached the gateway" },
      ],
    },
    steps: [
      { action: "createConversation", as: "conv", agentId: "local-work-agent" },
      {
        action: "sendMessage",
        conversation: "conv",
        input: "ping the scripted LLM",
        asRun: "run",
        asMessage: "user",
      },
      { action: "waitForRun", run: "run", status: "succeeded" },
      { action: "listMessages", conversation: "conv", as: "messages" },
      {
        action: "assertMessages",
        messages: "messages",
        roles: ["user", "assistant"],
        contains: ["scripted hello — acceptance LLM script reached the gateway"],
      },
    ],
  },
  {
    id: "scripted-llm-tool-call",
    name: "Scripted LLM drives a real tool through the runtime",
    description:
      "Scripted LLM yields a tool.call → the DSL expands to tool.plan + await.tool → the runtime invokes the gateway's real toolCallable for memory_search → the script continues to a final assistant message. This proves the tool DSL extension end-to-end and unblocks the next iteration (approval flow scenarios) by removing the last LLM-side blocker.",
    tags: ["fast", "scripted-llm", "tools"],
    llmScript: {
      yields: [
        {
          kind: "tool.call",
          callId: "c-mem-search",
          tool: "memory_search",
          input: { query: "scripted-llm-acceptance-no-match" },
        },
        {
          kind: "final",
          text: "scripted llm: memory_search tool call completed",
        },
      ],
    },
    steps: [
      { action: "createConversation", as: "conv", agentId: "local-work-agent" },
      {
        action: "sendMessage",
        conversation: "conv",
        input: "use the memory tool",
        asRun: "run",
        asMessage: "user",
      },
      { action: "waitForRun", run: "run", status: "succeeded" },
      { action: "listMessages", conversation: "conv", as: "messages" },
      {
        action: "assertMessages",
        messages: "messages",
        roles: ["user", "assistant"],
        contains: ["scripted llm: memory_search tool call completed"],
      },
    ],
  },
  {
    id: "parallel-runs-smoke",
    name: "Parallel runs across distinct conversations",
    description:
      "Fires three runs concurrently across three conversations, verifies each reaches succeeded independently, and asserts the gateway returns three distinct run IDs (no cross-conversation contamination).",
    tags: ["concurrency", "smoke"],
    steps: [
      { action: "createConversation", as: "conv-a" },
      { action: "createConversation", as: "conv-b" },
      { action: "createConversation", as: "conv-c" },
      {
        action: "parallelRuns",
        runs: [
          { conversation: "conv-a", input: "hello A", asRun: "run-a" },
          { conversation: "conv-b", input: "hello B", asRun: "run-b" },
          { conversation: "conv-c", input: "hello C", asRun: "run-c" },
        ],
      },
      { action: "waitForRun", run: "run-a", status: "succeeded" },
      { action: "waitForRun", run: "run-b", status: "succeeded" },
      { action: "waitForRun", run: "run-c", status: "succeeded" },
      { action: "assertDistinctRuns", runs: ["run-a", "run-b", "run-c"] },
      { action: "listMessages", conversation: "conv-a", as: "messages-a" },
      { action: "assertMessages", messages: "messages-a", roles: ["user", "assistant"], contains: ["hello A"] },
      { action: "listMessages", conversation: "conv-b", as: "messages-b" },
      { action: "assertMessages", messages: "messages-b", roles: ["user", "assistant"], contains: ["hello B"] },
      { action: "listMessages", conversation: "conv-c", as: "messages-c" },
      { action: "assertMessages", messages: "messages-c", roles: ["user", "assistant"], contains: ["hello C"] },
    ],
  },
];

export interface AcceptanceSuiteOptions {
  app: Hono;
  token: string;
  artifactDir: string;
  scenarios?: AcceptanceScenario[];
  pollIntervalMs?: number;
  timeoutMs?: number;
  profileDir?: string;
  restartApp?: () => Hono;
  /**
   * Per-scenario LLM script controller. When provided, the suite installs
   * each scenario's `llmScript` (or null) before running it and resets the
   * controller after the suite completes. Scenarios without an llmScript
   * keep the controller's default fallback.
   */
  scriptedLlm?: ScriptedLlmController;
}

export interface AcceptanceSuiteSummary {
  total: number;
  passed: number;
  failed: number;
  status: "passed" | "failed";
}

export interface AcceptanceSuiteArtifact extends AcceptanceSuiteSummary {
  scenarios: Array<{
    id: string;
    name: string;
    status: AcceptanceRunResult["status"];
    artifactPath: string;
  }>;
}

export async function runAcceptanceSuite(options: AcceptanceSuiteOptions): Promise<AcceptanceRunResult[]> {
  const results: AcceptanceRunResult[] = [];
  try {
    for (const scenario of options.scenarios ?? defaultAcceptanceScenarios) {
      options.scriptedLlm?.setStep(scenario.llmScript ?? null);
      results.push(
        await runAcceptanceScenario({
          app: options.app,
          token: options.token,
          artifactDir: options.artifactDir,
          scenario,
          pollIntervalMs: options.pollIntervalMs,
          timeoutMs: options.timeoutMs,
          profileDir: options.profileDir,
          restartApp: options.restartApp,
        }),
      );
    }
  } finally {
    options.scriptedLlm?.reset();
  }
  return results;
}

export function summarizeAcceptanceResults(results: readonly AcceptanceRunResult[]): AcceptanceSuiteSummary {
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.length - passed;
  return {
    total: results.length,
    passed,
    failed,
    status: failed === 0 ? "passed" : "failed",
  };
}

export function selectAcceptanceScenarios(
  ids: readonly string[],
  scenarios: readonly AcceptanceScenario[] = defaultAcceptanceScenarios,
): AcceptanceScenario[] {
  if (ids.length === 0) return [...scenarios];
  const selected: AcceptanceScenario[] = [];
  for (const id of ids) {
    const scenario = scenarios.find((item) => item.id === id);
    if (!scenario) {
      const known = scenarios.map((item) => item.id).join(", ");
      throw new Error(`Unknown acceptance scenario ${id}. Known scenarios: ${known}`);
    }
    selected.push(scenario);
  }
  return selected;
}

export function filterAcceptanceScenariosByTags(
  tags: readonly string[],
  scenarios: readonly AcceptanceScenario[] = defaultAcceptanceScenarios,
): AcceptanceScenario[] {
  if (tags.length === 0) return [...scenarios];
  const wanted = new Set(tags);
  return scenarios.filter((scenario) => (scenario.tags ?? []).some((tag) => wanted.has(tag)));
}

export function writeAcceptanceSuiteArtifacts(
  artifactDir: string,
  results: readonly AcceptanceRunResult[],
): AcceptanceSuiteArtifact {
  const summary = summarizeAcceptanceResults(results);
  const artifact: AcceptanceSuiteArtifact = {
    ...summary,
    scenarios: results.map((result) => ({
      id: result.scenarioId,
      name: result.scenarioName,
      status: result.status,
      artifactPath: result.artifactPath,
    })),
  };
  writeFileSync(join(artifactDir, "summary.json"), `${JSON.stringify(artifact, null, 2)}\n`);
  writeHarnessManifest(artifactDir, "acceptance", results.map(acceptanceReportResult));
  return artifact;
}

export function writeAcceptanceFailureReport(
  artifactDir: string,
  results: readonly AcceptanceRunResult[],
): string | null {
  return writeHarnessFailureReport(artifactDir, {
    title: "Acceptance Failure Report",
    results: results.map(acceptanceReportResult),
  });
}

export function writeAcceptanceJUnitReport(
  artifactDir: string,
  results: readonly AcceptanceRunResult[],
): string {
  return writeHarnessJUnitReport(artifactDir, "acceptance", results.map(acceptanceReportResult));
}

function acceptanceReportResult(result: AcceptanceRunResult): HarnessResultReport {
  return {
    id: result.scenarioId,
    name: result.scenarioName,
    status: result.status,
    artifactPath: result.artifactPath,
    steps: result.steps.map((step) => ({
      name: `${step.index + 1}. ${step.action}`,
      status: step.status,
      error: step.error,
    })),
  };
}
