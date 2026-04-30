import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import {
  runAcceptanceScenario,
  type AcceptanceRunResult,
  type AcceptanceScenario,
} from "./acceptanceRunner";

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
  for (const scenario of options.scenarios ?? defaultAcceptanceScenarios) {
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
  return artifact;
}

export function writeAcceptanceFailureReport(
  artifactDir: string,
  results: readonly AcceptanceRunResult[],
): string | null {
  const failed = results.filter((result) => result.status === "failed");
  if (failed.length === 0) return null;
  const path = join(artifactDir, "failure-report.md");
  const lines = [
    "# Acceptance Failure Report",
    "",
    `Failed: ${failed.length}/${results.length}`,
    "",
  ];
  for (const result of failed) {
    const failedStep = result.steps.find((step) => step.status === "failed");
    lines.push(`## ${result.scenarioId}`);
    lines.push("");
    lines.push(`Name: ${result.scenarioName}`);
    lines.push(`Artifacts: ${result.artifactPath}`);
    if (failedStep) {
      lines.push(`Failed step: ${failedStep.index + 1}. ${failedStep.action}`);
      lines.push(`Error: ${failedStep.error ?? "unknown"}`);
    }
    lines.push("");
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

export function writeAcceptanceJUnitReport(
  artifactDir: string,
  results: readonly AcceptanceRunResult[],
): string {
  const path = join(artifactDir, "junit.xml");
  const failures = results.filter((result) => result.status === "failed").length;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="vulture.acceptance" tests="${results.length}" failures="${failures}">`,
  ];
  for (const result of results) {
    lines.push(`  <testcase classname="vulture.acceptance" name="${escapeXml(result.scenarioName)}">`);
    const failedStep = result.steps.find((step) => step.status === "failed");
    if (failedStep) {
      const message = `${failedStep.action}: ${failedStep.error ?? "unknown"}`;
      lines.push(`    <failure message="${escapeXml(message)}">${escapeXml(message)}</failure>`);
    }
    lines.push(`    <system-out>${escapeXml(result.artifactPath)}</system-out>`);
    lines.push("  </testcase>");
  }
  lines.push("</testsuite>");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
