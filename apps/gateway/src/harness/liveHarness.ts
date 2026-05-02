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
  type ToolCallable,
} from "@vulture/agent-runtime";
import { makeOpenAILlm } from "../runtime/openaiLlm";

export interface LiveHarnessScenario {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  model: string;
  systemPrompt: string;
  userInput: string;
  expectFinalText: (text: string) => string | undefined;
  idleTimeoutMs?: number;
}

export const defaultLiveHarnessScenarios: LiveHarnessScenario[] = [
  {
    id: "hello-text",
    name: "Real LLM produces nonempty short text",
    description: "Sanity-check that a live OpenAI call reaches a model and returns nonempty text under 200 chars.",
    tags: ["live", "smoke"],
    model: "gpt-4.1-mini",
    systemPrompt: "You are a brief assistant. Reply with one short sentence.",
    userInput: "Reply with one short sentence saying hello in English.",
    expectFinalText: (text) => {
      const trimmed = text.trim();
      if (!trimmed) return "assistant produced empty text";
      if (trimmed.length > 200) return `assistant text too long: ${trimmed.length} chars`;
      if (!/[a-zA-Z]/.test(trimmed)) return "assistant text has no Latin letters";
      return undefined;
    },
    idleTimeoutMs: 30_000,
  },
];

export interface LiveHarnessOptions {
  artifactDir: string;
  apiKey: string;
  scenarios?: readonly LiveHarnessScenario[];
  workspacePath?: string;
}

export interface LiveHarnessResult {
  scenarioId: string;
  scenarioName: string;
  status: "passed" | "failed";
  finalText: string;
  model: string;
  error?: string;
}

export interface LiveHarnessSummary {
  total: number;
  passed: number;
  failed: number;
  status: "passed" | "failed";
  scenarios: Array<{ id: string; name: string; status: LiveHarnessResult["status"] }>;
}

export async function runLiveHarness(options: LiveHarnessOptions): Promise<LiveHarnessResult[]> {
  const artifactDir = resolve(options.artifactDir);
  mkdirSync(artifactDir, { recursive: true });
  const workspacePath = resolve(options.workspacePath ?? artifactDir);
  const results: LiveHarnessResult[] = [];

  for (const scenario of options.scenarios ?? defaultLiveHarnessScenarios) {
    results.push(await runLiveHarnessScenario(scenario, options.apiKey, workspacePath));
  }

  writeLiveHarnessArtifacts(artifactDir, results);
  return results;
}

export function filterLiveHarnessScenarios(
  scenarios: readonly LiveHarnessScenario[],
  filters: { scenarios?: readonly string[]; tags?: readonly string[] },
): LiveHarnessScenario[] {
  return selectHarnessScenarios(scenarios, {
    ids: filters.scenarios,
    tags: filters.tags,
  }, {
    label: "live harness scenario",
    unknownMessage: (id) => `Unknown live harness scenario: ${id}`,
  });
}

export function summarizeLiveHarnessResults(
  results: readonly LiveHarnessResult[],
): LiveHarnessSummary {
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

async function runLiveHarnessScenario(
  scenario: LiveHarnessScenario,
  apiKey: string,
  workspacePath: string,
): Promise<LiveHarnessResult> {
  const tools: ToolCallable = async () => ({ ok: true });
  try {
    const result = await runConversation({
      runId: `live-${scenario.id}`,
      agentId: "live-harness-agent",
      model: scenario.model,
      systemPrompt: scenario.systemPrompt,
      userInput: scenario.userInput,
      workspacePath,
      llm: makeOpenAILlm({
        apiKey,
        toolNames: [],
        toolCallable: tools,
      }),
      tools,
      idleTimeoutMs: scenario.idleTimeoutMs ?? 30_000,
      onEvent: () => {},
    });
    const finalText = result.finalText ?? "";
    if (result.status !== "succeeded") {
      return {
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        status: "failed",
        finalText,
        model: scenario.model,
        error: `expected succeeded, got ${result.status}: ${result.error?.message ?? ""}`,
      };
    }
    const validationError = scenario.expectFinalText(finalText);
    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      status: validationError ? "failed" : "passed",
      finalText,
      model: scenario.model,
      error: validationError,
    };
  } catch (cause) {
    return {
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      status: "failed",
      finalText: "",
      model: scenario.model,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

function writeLiveHarnessArtifacts(
  artifactDir: string,
  results: readonly LiveHarnessResult[],
): void {
  const reportResults = results.map((result): HarnessResultReport => ({
    id: result.scenarioId,
    name: result.scenarioName,
    status: result.status,
    error: result.error,
  }));
  writeFileSync(
    join(artifactDir, "summary.json"),
    `${JSON.stringify(summarizeLiveHarnessResults(results), null, 2)}\n`,
  );
  writeFileSync(
    join(artifactDir, "transcripts.jsonl"),
    results
      .map((result) =>
        JSON.stringify({
          scenarioId: result.scenarioId,
          model: result.model,
          status: result.status,
          finalText: result.finalText,
          error: result.error,
        }),
      )
      .join("\n")
      .concat(results.length > 0 ? "\n" : ""),
  );
  writeHarnessManifest(artifactDir, "live", reportResults);
  writeHarnessJUnitReport(artifactDir, "live", reportResults);
  writeHarnessFailureReport(artifactDir, {
    title: "Live LLM Harness Failures",
    results: reportResults,
  });
}
