import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  selectHarnessScenarios,
  writeHarnessFailureReport,
  writeHarnessJUnitReport,
  writeHarnessManifest,
  type HarnessResultReport,
} from "@vulture/harness-core";
import {
  runConversation,
  type LlmCallable,
  type LlmCheckpoint,
  type LlmRecoveryInput,
  type ToolCallable,
} from "@vulture/agent-runtime";
import type { RunEvent } from "@vulture/protocol/src/v1/run";

export interface RuntimeHarnessScenario {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  recovery?: LlmRecoveryInput;
  expectedStatus: "succeeded" | "failed";
  expectedFinalText?: string;
  expectedErrorIncludes?: string;
  llm: (ctx: RuntimeHarnessScenarioContext) => LlmCallable;
  tool?: ToolCallable;
}

export interface RuntimeHarnessScenarioContext {
  scenarioId: string;
}

export interface RuntimeHarnessOptions {
  artifactDir: string;
  scenarios?: readonly RuntimeHarnessScenario[];
  workspacePath?: string;
}

export interface RuntimeHarnessResult {
  scenarioId: string;
  scenarioName: string;
  status: "passed" | "failed";
  events: RunEvent[];
  checkpoints: LlmCheckpoint[];
  toolCalls: Array<Parameters<ToolCallable>[0]>;
  error?: string;
}

export interface RuntimeHarnessSummary {
  total: number;
  passed: number;
  failed: number;
  status: "passed" | "failed";
  scenarios: Array<{
    id: string;
    name: string;
    status: RuntimeHarnessResult["status"];
  }>;
}

export const defaultRuntimeHarnessScenarios: RuntimeHarnessScenario[] = [
  {
    id: "text-stream-usage",
    name: "Text stream usage",
    description: "Streams deltas, records usage, and completes with final text.",
    tags: ["runtime", "fast"],
    expectedStatus: "succeeded",
    expectedFinalText: "hello runtime",
    llm: () => async function* () {
      yield { kind: "text.delta", text: "hello " };
      yield {
        kind: "usage",
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      };
      yield { kind: "final", text: "hello runtime" };
    },
  },
  {
    id: "tool-success-checkpoint",
    name: "Tool success checkpoint",
    description: "Plans a tool, executes it, captures a checkpoint, and completes.",
    tags: ["runtime", "tools", "checkpoint"],
    expectedStatus: "succeeded",
    expectedFinalText: "read ok",
    llm: () => async function* (input) {
      const toolInput = { path: "package.json", maxBytes: null };
      input.onCheckpoint?.({
        sdkState: "sdk-before-read",
        activeTool: {
          callId: "c-read",
          tool: "read",
          input: toolInput,
          idempotent: true,
        },
      });
      yield { kind: "tool.plan", callId: "c-read", tool: "read", input: toolInput };
      const result = yield { kind: "await.tool", callId: "c-read" };
      if ((result as { ok?: boolean }).ok !== true) {
        throw new Error("tool-success-checkpoint expected ok tool result");
      }
      yield { kind: "final", text: "read ok" };
    },
    tool: async () => ({ ok: true }),
  },
  {
    id: "tool-failure",
    name: "Tool failure",
    description: "Records a failed tool call and validates the failed runtime result.",
    tags: ["runtime", "tools", "failure"],
    expectedStatus: "failed",
    expectedErrorIncludes: "tool exploded",
    llm: () => async function* () {
      yield {
        kind: "tool.plan",
        callId: "c-fail",
        tool: "read",
        input: { path: "missing.txt", maxBytes: null },
      };
      yield { kind: "await.tool", callId: "c-fail" };
      yield { kind: "final", text: "unreachable" };
    },
    tool: async () => {
      throw new Error("tool exploded");
    },
  },
  {
    id: "recovery-input",
    name: "Recovery input",
    description: "Verifies recovery metadata reaches the LLM callable.",
    tags: ["runtime", "recovery"],
    recovery: { sdkState: "sdk-recovery-state", retryToolCallId: "c-retry" },
    expectedStatus: "succeeded",
    expectedFinalText: "recovered from c-retry",
    llm: () => async function* (input) {
      if (input.recovery?.sdkState !== "sdk-recovery-state") {
        throw new Error("missing sdk recovery state");
      }
      yield {
        kind: "final",
        text: `recovered from ${input.recovery.retryToolCallId}`,
      };
    },
  },
  {
    id: "subagent-suggestion-confirmation",
    name: "Subagent suggestion confirmation",
    description: "Models the parent agent autonomously suggesting a subagent and proceeding after sessions_spawn approval.",
    tags: ["runtime", "subagents", "approval", "product"],
    expectedStatus: "succeeded",
    expectedFinalText: "subagent summary integrated",
    llm: () => async function* () {
      const toolInput = {
        agentId: "researcher",
        label: "Researcher",
        title: "Audit prompt and harness readiness",
        message: "Inspect prompt injection order and harness coverage, then return concise findings.",
      };
      yield { kind: "tool.plan", callId: "c-subagent-spawn", tool: "sessions_spawn", input: toolInput };
      const result = yield { kind: "await.tool", callId: "c-subagent-spawn" };
      if ((result as { sessionId?: string }).sessionId !== "subagent-1") {
        throw new Error("subagent-suggestion-confirmation expected spawned session");
      }
      yield { kind: "final", text: "subagent summary integrated" };
    },
    tool: async (call) => {
      if (call.tool !== "sessions_spawn") throw new Error(`unexpected tool ${call.tool}`);
      return { sessionId: "subagent-1", conversationId: "c-subagent", runId: "r-subagent" };
    },
  },
];

export async function runRuntimeHarness(
  options: RuntimeHarnessOptions,
): Promise<RuntimeHarnessResult[]> {
  const artifactDir = resolve(options.artifactDir);
  mkdirSync(artifactDir, { recursive: true });
  const workspacePath = resolve(options.workspacePath ?? artifactDir);
  const results: RuntimeHarnessResult[] = [];

  for (const scenario of options.scenarios ?? defaultRuntimeHarnessScenarios) {
    results.push(await runRuntimeHarnessScenario(scenario, workspacePath));
  }

  writeRuntimeHarnessArtifacts(artifactDir, results);
  return results;
}

export function filterRuntimeHarnessScenarios(
  scenarios: readonly RuntimeHarnessScenario[],
  filters: { scenarios?: readonly string[]; tags?: readonly string[] },
): RuntimeHarnessScenario[] {
  return selectHarnessScenarios(scenarios, {
    ids: filters.scenarios,
    tags: filters.tags,
  }, {
    label: "runtime harness scenario",
    unknownMessage: (id) => `Unknown runtime harness scenario: ${id}`,
  });
}

export function summarizeRuntimeHarnessResults(
  results: readonly RuntimeHarnessResult[],
): RuntimeHarnessSummary {
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.length - passed;
  return {
    total: results.length,
    passed,
    failed,
    status: failed === 0 ? "passed" : "failed",
    scenarios: results.map((result) => ({
      id: result.scenarioId,
      name: result.scenarioName,
      status: result.status,
    })),
  };
}

async function runRuntimeHarnessScenario(
  scenario: RuntimeHarnessScenario,
  workspacePath: string,
): Promise<RuntimeHarnessResult> {
  const events: RunEvent[] = [];
  const checkpoints: LlmCheckpoint[] = [];
  const toolCalls: Array<Parameters<ToolCallable>[0]> = [];
  const runId = `runtime-${scenario.id}`;
  const tool = scenario.tool ?? (async () => ({ ok: true }));
  const tools: ToolCallable = async (call) => {
    toolCalls.push(omitUndefined(call));
    return await tool(call);
  };

  const result = await runConversation({
    runId,
    agentId: "runtime-harness-agent",
    model: "stub-runtime-harness",
    systemPrompt: "Runtime harness system prompt",
    userInput: `run ${scenario.id}`,
    workspacePath,
    llm: scenario.llm({ scenarioId: scenario.id }),
    tools,
    recovery: scenario.recovery,
    onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
    onEvent: (event) => events.push(event),
    idleTimeoutMs: 1_000,
  });

  const error = validateScenarioOutcome(scenario, result);
  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    status: error ? "failed" : "passed",
    events,
    checkpoints,
    toolCalls,
    error,
  };
}

function validateScenarioOutcome(
  scenario: RuntimeHarnessScenario,
  result: Awaited<ReturnType<typeof runConversation>>,
): string | undefined {
  if (result.status !== scenario.expectedStatus) {
    return `Expected status ${scenario.expectedStatus}, got ${result.status}`;
  }
  if (
    scenario.expectedFinalText !== undefined &&
    result.finalText !== scenario.expectedFinalText
  ) {
    return `Expected final text ${JSON.stringify(scenario.expectedFinalText)}, got ${JSON.stringify(result.finalText)}`;
  }
  if (
    scenario.expectedErrorIncludes &&
    !result.error?.message.includes(scenario.expectedErrorIncludes)
  ) {
    return `Expected error to include ${JSON.stringify(scenario.expectedErrorIncludes)}, got ${JSON.stringify(result.error?.message ?? "")}`;
  }
  return undefined;
}

function writeRuntimeHarnessArtifacts(
  artifactDir: string,
  results: readonly RuntimeHarnessResult[],
): void {
  const reportResults = results.map(runtimeReportResult);
  writeFileSync(
    join(artifactDir, "summary.json"),
    `${JSON.stringify(summarizeRuntimeHarnessResults(results), null, 2)}\n`,
  );
  writeHarnessManifest(artifactDir, "runtime", reportResults);
  writeHarnessJUnitReport(artifactDir, "runtime", reportResults);
  writeFileSync(
    join(artifactDir, "events.jsonl"),
    results
      .flatMap((result) =>
        result.events.map((event) =>
          JSON.stringify({ scenarioId: result.scenarioId, event }),
        ),
      )
      .join("\n")
      .concat(results.some((result) => result.events.length > 0) ? "\n" : ""),
  );

  writeHarnessFailureReport(artifactDir, {
    title: "Agent Runtime Harness Failures",
    results: reportResults,
  });
}

function runtimeReportResult(result: RuntimeHarnessResult): HarnessResultReport {
  return {
    id: result.scenarioId,
    name: result.scenarioName,
    status: result.status,
    error: result.error,
  };
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}
