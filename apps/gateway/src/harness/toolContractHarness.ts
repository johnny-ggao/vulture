import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RunContext } from "@openai/agents";
import type { ToolCallable } from "@vulture/agent-runtime";
import {
  selectHarnessScenarios,
  writeHarnessFailureReport,
  writeHarnessJUnitReport,
  writeHarnessManifest,
  type HarnessResultReport,
} from "@vulture/harness-core";
import { createCoreToolRegistry } from "../tools/coreTools";
import { toSdkTool, type GatewayToolRunContext } from "../tools/sdkAdapter";
import type { GatewayToolCategory, GatewayToolRisk, GatewayToolSpec } from "../tools/types";

export interface ToolContractFixture {
  toolId: string;
  id: string;
  name: string;
  tags: string[];
  expectedCategory: GatewayToolCategory;
  expectedRisk: GatewayToolRisk;
  expectedIdempotent: boolean;
  expectedApproval: boolean;
  validInput: (ctx: ToolContractFixtureContext) => unknown;
  invalidInput: unknown;
}

export interface ToolContractFixtureContext {
  workspacePath: string;
}

export interface ToolContractHarnessOptions {
  artifactDir: string;
  fixtures?: readonly ToolContractFixture[];
  workspacePath?: string;
}

export interface ToolContractCheckResult {
  name: string;
  status: "passed" | "failed";
  error?: string;
}

export interface ToolContractResult {
  toolId: string;
  status: "passed" | "failed";
  checks: ToolContractCheckResult[];
}

export interface ToolContractSummary {
  total: number;
  passed: number;
  failed: number;
  status: "passed" | "failed";
  tools: Array<{ id: string; status: ToolContractResult["status"] }>;
}

type HarnessSdkTool = {
  invoke: (
    context: RunContext<GatewayToolRunContext>,
    input: string,
    details?: { toolCall?: { callId?: string } },
  ) => Promise<unknown>;
};

export const defaultToolContractFixtures: ToolContractFixture[] = [
  fixture("read", "fs", "safe", true, false, () => ({
    path: "README.md",
    maxBytes: null,
  }), { path: 42, maxBytes: null }),
  fixture("write", "fs", "approval", false, false, () => ({
    path: "note.txt",
    content: "hello",
  }), { path: "note.txt" }),
  fixture("edit", "fs", "approval", false, false, () => ({
    path: "note.txt",
    oldText: "hello",
    newText: "hi",
    replaceAll: null,
  }), { path: "note.txt", oldText: "hello" }),
  fixture("apply_patch", "fs", "approval", false, false, ({ workspacePath }) => ({
    cwd: workspacePath,
    patch: "--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-old\n+new\n",
  }), { cwd: 10, patch: "" }),
  fixture("shell.exec", "runtime", "approval", false, false, ({ workspacePath }) => ({
    cwd: workspacePath,
    argv: ["printf", "ok"],
    timeoutMs: null,
  }), { cwd: "relative", argv: "printf ok", timeoutMs: null }),
  fixture("process", "runtime", "approval", false, false, () => ({
    action: "list",
    processId: null,
    cwd: null,
    argv: null,
  }), { action: "launch", processId: null, cwd: null, argv: null }),
  fixture("web_search", "web", "safe", true, false, () => ({
    query: "OpenAI Agents SDK",
    limit: null,
  }), { query: 1, limit: null }),
  fixture("web_fetch", "web", "safe", true, false, () => ({
    url: "https://example.com",
    maxBytes: null,
  }), { url: 1, maxBytes: null }),
  fixture("web_extract", "web", "safe", true, false, () => ({
    url: "https://example.com",
    maxBytes: null,
    maxLinks: null,
  }), { url: 1, maxBytes: null, maxLinks: null }),
  fixture("sessions_list", "sessions", "safe", true, false, () => ({
    parentConversationId: null,
    parentRunId: null,
    agentId: null,
    limit: null,
  }), { limit: "many" }),
  fixture("sessions_history", "sessions", "safe", true, false, () => ({
    sessionId: "sub-1",
    conversationId: null,
    limit: null,
  }), { sessionId: 1, conversationId: null, limit: null }),
  fixture("sessions_send", "sessions", "approval", false, true, () => ({
    sessionId: "sub-1",
    conversationId: null,
    message: "hello",
  }), { sessionId: "sub-1", conversationId: null }),
  fixture("sessions_spawn", "sessions", "approval", false, true, () => ({
    agentId: null,
    title: null,
    label: null,
    message: null,
  }), { agentId: 1, title: null, message: null }),
  fixture("sessions_yield", "sessions", "safe", true, false, () => ({
    parentConversationId: null,
    parentRunId: null,
    limit: null,
    message: null,
  }), { message: 1 }),
  fixture("update_plan", "agents", "safe", true, false, () => ({
    items: [{ step: "Implement harness", status: "in_progress" }],
  }), { items: [{ step: "Implement harness", status: "started" }] }),
  fixture("memory_search", "memory", "safe", true, false, () => ({
    query: "codename",
    limit: null,
  }), { query: null, limit: null }),
  fixture("memory_get", "memory", "safe", true, false, () => ({
    id: null,
    path: "MEMORY.md",
  }), { id: 1, path: null }),
  fixture("memory_append", "memory", "approval", false, true, () => ({
    path: "MEMORY.md",
    content: "Remember this.",
  }), { path: "MEMORY.md" }),
  fixture("browser.snapshot", "browser", "approval", true, true, () => ({}), null),
  fixture("browser.click", "browser", "approval", false, true, () => ({
    selector: "button",
  }), { selector: 1 }),
  fixture("browser.input", "browser", "approval", false, true, () => ({
    selector: "input[name=q]",
    text: "hello",
    submit: null,
  }), { selector: "input", submit: "no" }),
  fixture("browser.scroll", "browser", "approval", false, true, () => ({
    selector: null,
    deltaY: 800,
  }), { selector: 1, deltaY: "down" }),
  fixture("browser.extract", "browser", "approval", true, true, () => ({
    maxTextChars: null,
    maxLinks: null,
  }), { maxTextChars: "many", maxLinks: null }),
  fixture("browser.navigate", "browser", "approval", false, true, () => ({
    url: "https://example.com",
  }), { url: "not a url" }),
  fixture("browser.wait", "browser", "approval", true, true, () => ({
    selector: "main",
    timeoutMs: 5000,
  }), { selector: 1, timeoutMs: "soon" }),
  fixture("browser.screenshot", "browser", "approval", true, true, () => ({
    fullPage: false,
  }), { fullPage: "no" }),
];

export async function runToolContractHarness(
  options: ToolContractHarnessOptions,
): Promise<ToolContractResult[]> {
  const artifactDir = resolve(options.artifactDir);
  mkdirSync(artifactDir, { recursive: true });
  const workspacePath = resolve(options.workspacePath ?? artifactDir);
  const registry = createCoreToolRegistry();
  const results: ToolContractResult[] = [];

  for (const fixture of options.fixtures ?? defaultToolContractFixtures) {
    const spec = registry.get(fixture.toolId);
    if (!spec) {
      results.push({
        toolId: fixture.toolId,
        status: "failed",
        checks: [{ name: "metadata", status: "failed", error: "missing tool spec" }],
      });
      continue;
    }
    results.push(await runToolContract(spec, fixture, workspacePath));
  }

  writeToolContractArtifacts(artifactDir, results);
  return results;
}

export function filterToolContractFixtures(
  fixtures: readonly ToolContractFixture[],
  filters: { tools?: readonly string[]; categories?: readonly GatewayToolCategory[] },
): ToolContractFixture[] {
  return selectHarnessScenarios(fixtures, {
    ids: filters.tools,
    tags: filters.categories,
  }, {
    label: "tool contract fixture",
    unknownMessage: (id) => `Unknown tool contract fixture: ${id}`,
  });
}

export function summarizeToolContractResults(
  results: readonly ToolContractResult[],
): ToolContractSummary {
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.length - passed;
  return {
    total: results.length,
    passed,
    failed,
    status: failed === 0 ? "passed" : "failed",
    tools: results.map((result) => ({ id: result.toolId, status: result.status })),
  };
}

async function runToolContract(
  spec: GatewayToolSpec,
  fixture: ToolContractFixture,
  workspacePath: string,
): Promise<ToolContractResult> {
  const validInput = fixture.validInput({ workspacePath });
  const checks: ToolContractCheckResult[] = [];

  await check(checks, "metadata", () => assertSpecMetadata(spec));
  await check(checks, "schema.valid", () => {
    const parsed = spec.parameters.safeParse(validInput);
    if (!parsed.success) throw new Error(parsed.error.message);
  });
  await check(checks, "schema.invalid", () => {
    const parsed = spec.parameters.safeParse(fixture.invalidInput);
    if (parsed.success) throw new Error("invalid input unexpectedly passed schema");
  });
  await check(checks, "fixture.metadata", () => assertFixtureMetadata(spec, fixture));
  await check(checks, "approval", async () => {
    const decision = await spec.needsApproval(
      {
        runId: "tool-contract-run",
        workspacePath,
        toolCallable: async () => ({ ok: true }),
        sdkApprovedToolCalls: new Map(),
      },
      validInput,
    );
    if (decision.needsApproval !== fixture.expectedApproval) {
      throw new Error(
        `expected approval ${fixture.expectedApproval}, got ${decision.needsApproval}`,
      );
    }
  });
  await check(checks, "sdk.invoke", async () => assertSdkInvoke(spec, validInput, workspacePath));

  return {
    toolId: spec.id,
    status: checks.every((item) => item.status === "passed") ? "passed" : "failed",
    checks,
  };
}

function assertSpecMetadata(spec: GatewayToolSpec): void {
  if (!spec.id || !spec.sdkName || !spec.label || !spec.description) {
    throw new Error("tool spec has incomplete identity metadata");
  }
  if (spec.source !== "core") throw new Error(`expected source core, got ${spec.source}`);
  if (typeof spec.idempotent !== "boolean") throw new Error("idempotent must be boolean");
  if (typeof spec.needsApproval !== "function") throw new Error("needsApproval must be function");
  if (typeof spec.execute !== "function") throw new Error("execute must be function");
}

function assertFixtureMetadata(spec: GatewayToolSpec, fixture: ToolContractFixture): void {
  if (spec.category !== fixture.expectedCategory) {
    throw new Error(`expected category ${fixture.expectedCategory}, got ${spec.category}`);
  }
  if (spec.risk !== fixture.expectedRisk) {
    throw new Error(`expected risk ${fixture.expectedRisk}, got ${spec.risk}`);
  }
  if (spec.idempotent !== fixture.expectedIdempotent) {
    throw new Error(
      `expected idempotent ${fixture.expectedIdempotent}, got ${spec.idempotent}`,
    );
  }
}

async function assertSdkInvoke(
  spec: GatewayToolSpec,
  validInput: unknown,
  workspacePath: string,
): Promise<void> {
  const sdkTool = toSdkTool(spec) as unknown as HarnessSdkTool;
  const calls: Array<Parameters<ToolCallable>[0]> = [];
  await sdkTool.invoke(
    new RunContext({
      runId: "tool-contract-run",
      workspacePath,
      sdkApprovedToolCalls: new Map([["tool-contract-call", "approved-token"]]),
      toolCallable: async (call) => {
        calls.push(call);
        return { ok: true };
      },
    }),
    JSON.stringify(validInput),
    { toolCall: { callId: "tool-contract-call" } },
  );
  const call = calls[0];
  if (!call) throw new Error("SDK tool did not invoke toolCallable");
  if (call.tool !== spec.id) throw new Error(`expected SDK call tool ${spec.id}, got ${call.tool}`);
  if (call.runId !== "tool-contract-run") {
    throw new Error(`expected runId tool-contract-run, got ${call.runId}`);
  }
  if (call.workspacePath !== workspacePath) {
    throw new Error(`expected workspacePath ${workspacePath}, got ${call.workspacePath}`);
  }
  if (call.approvalToken !== "approved-token") {
    throw new Error(`expected approval token approved-token, got ${call.approvalToken}`);
  }
  if (JSON.stringify(call.input) !== JSON.stringify(validInput)) {
    throw new Error("SDK call input did not match fixture input");
  }
}

async function check(
  checks: ToolContractCheckResult[],
  name: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await fn();
    checks.push({ name, status: "passed" });
  } catch (cause) {
    checks.push({
      name,
      status: "failed",
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function writeToolContractArtifacts(
  artifactDir: string,
  results: readonly ToolContractResult[],
): void {
  const reportResults = results.map(toolContractReportResult);
  writeFileSync(
    join(artifactDir, "summary.json"),
    `${JSON.stringify(summarizeToolContractResults(results), null, 2)}\n`,
  );
  writeHarnessManifest(artifactDir, "tool-contract", reportResults);
  writeHarnessJUnitReport(artifactDir, "tool-contract", reportResults);
  writeFileSync(join(artifactDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);

  writeHarnessFailureReport(artifactDir, {
    title: "Tool Contract Harness Failures",
    results: reportResults,
  });
}

function toolContractReportResult(result: ToolContractResult): HarnessResultReport {
  return {
    id: result.toolId,
    name: result.toolId,
    status: result.status,
    steps: result.checks.map((checkResult) => ({
      name: checkResult.name,
      status: checkResult.status,
      error: checkResult.error,
    })),
  };
}

function fixture(
  toolId: string,
  expectedCategory: GatewayToolCategory,
  expectedRisk: GatewayToolRisk,
  expectedIdempotent: boolean,
  expectedApproval: boolean,
  validInput: ToolContractFixture["validInput"],
  invalidInput: unknown,
): ToolContractFixture {
  return {
    toolId,
    id: toolId,
    name: toolId,
    tags: [expectedCategory],
    expectedCategory,
    expectedRisk,
    expectedIdempotent,
    expectedApproval,
    validInput,
    invalidInput,
  };
}
