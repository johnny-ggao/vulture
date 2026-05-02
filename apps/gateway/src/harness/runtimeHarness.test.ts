import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultRuntimeHarnessScenarios,
  filterRuntimeHarnessScenarios,
  runRuntimeHarness,
  summarizeRuntimeHarnessResults,
} from "./runtimeHarness";

describe("agent runtime harness", () => {
  test("runs scripted runtime scenarios and writes deterministic artifacts", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "vulture-runtime-harness-"));
    try {
      const scenarios = filterRuntimeHarnessScenarios(defaultRuntimeHarnessScenarios, {
        scenarios: ["tool-success-checkpoint"],
      });

      const results = await runRuntimeHarness({
        artifactDir,
        scenarios,
        workspacePath: artifactDir,
      });

      expect(summarizeRuntimeHarnessResults(results)).toMatchObject({
        total: 1,
        passed: 1,
        failed: 0,
        status: "passed",
      });
      expect(results[0]?.events.map((event) => event.type)).toEqual([
        "run.started",
        "tool.planned",
        "tool.started",
        "tool.completed",
        "run.completed",
      ]);
      expect(results[0]?.checkpoints).toContainEqual({
        sdkState: "sdk-before-read",
        activeTool: {
          callId: "c-read",
          tool: "read",
          input: { path: "package.json", maxBytes: null },
          idempotent: true,
        },
      });
      expect(results[0]?.toolCalls).toEqual([
        {
          callId: "c-read",
          tool: "read",
          input: { path: "package.json", maxBytes: null },
          runId: "runtime-tool-success-checkpoint",
          workspacePath: artifactDir,
        },
      ]);

      const summary = JSON.parse(readFileSync(join(artifactDir, "summary.json"), "utf8"));
      expect(summary.scenarios).toEqual([
        {
          id: "tool-success-checkpoint",
          name: "Tool success checkpoint",
          status: "passed",
        },
      ]);
      const eventsJsonl = readFileSync(join(artifactDir, "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(eventsJsonl.map((line) => line.event.type)).toContain("tool.completed");
      expect(existsSync(join(artifactDir, "failure-report.md"))).toBe(false);
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  test("captures harness expectation failures and writes a failure report", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "vulture-runtime-harness-"));
    try {
      const scenario = defaultRuntimeHarnessScenarios.find(
        (item) => item.id === "tool-failure",
      );
      expect(scenario).toBeDefined();

      const results = await runRuntimeHarness({
        artifactDir,
        scenarios: [{ ...scenario!, expectedStatus: "succeeded" }],
        workspacePath: artifactDir,
      });

      expect(summarizeRuntimeHarnessResults(results)).toMatchObject({
        total: 1,
        passed: 0,
        failed: 1,
        status: "failed",
      });
      expect(results[0]?.events.map((event) => event.type)).toContain("tool.failed");
      expect(readFileSync(join(artifactDir, "failure-report.md"), "utf8")).toContain(
        "Expected status succeeded, got failed",
      );
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  test("passes recovery input into scripted LLM scenarios", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "vulture-runtime-harness-"));
    try {
      const scenarios = filterRuntimeHarnessScenarios(defaultRuntimeHarnessScenarios, {
        scenarios: ["recovery-input"],
      });

      const results = await runRuntimeHarness({
        artifactDir,
        scenarios,
        workspacePath: artifactDir,
      });

      expect(results[0]?.status).toBe("passed");
      expect(results[0]?.events.at(-1)).toMatchObject({
        type: "run.completed",
        finalText: "recovered from c-retry",
      });
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  test("runs the subagent result recovery scenario", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "vulture-runtime-harness-"));
    try {
      const scenarios = filterRuntimeHarnessScenarios(defaultRuntimeHarnessScenarios, {
        scenarios: ["subagent-result-recovery"],
      });

      const results = await runRuntimeHarness({
        artifactDir,
        scenarios,
        workspacePath: artifactDir,
      });

      expect(results[0]?.status).toBe("passed");
      expect(results[0]?.events.map((event) => event.type)).toEqual([
        "run.started",
        "tool.planned",
        "tool.started",
        "tool.completed",
        "tool.planned",
        "tool.started",
        "tool.completed",
        "run.completed",
      ]);
      expect(results[0]?.toolCalls).toEqual([
        expect.objectContaining({
          tool: "sessions_spawn",
          input: expect.objectContaining({
            agentId: "researcher",
            label: "Researcher",
            title: "Audit prompt and harness readiness",
          }),
        }),
        expect.objectContaining({
          tool: "sessions_yield",
          input: expect.objectContaining({
            parentRunId: "runtime-subagent-result-recovery",
          }),
        }),
      ]);
      expect(results[0]?.events.at(-1)).toMatchObject({
        type: "run.completed",
        finalText:
          "Subagent result integrated: Audit prompt and harness readiness - Inspect prompt injection order and harness coverage, then return concise findings. -> Runtime, tool contract, and product acceptance lanes are covered.",
      });
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  test("filters scenarios by tags and ids", () => {
    expect(
      filterRuntimeHarnessScenarios(defaultRuntimeHarnessScenarios, {
        tags: ["runtime"],
        scenarios: [],
      }).map((scenario) => scenario.id),
    ).toContain("text-stream-usage");
    expect(
      filterRuntimeHarnessScenarios(defaultRuntimeHarnessScenarios, {
        tags: ["subagents"],
        scenarios: [],
      }).map((scenario) => scenario.id),
    ).toContain("subagent-result-recovery");

    expect(
      filterRuntimeHarnessScenarios(defaultRuntimeHarnessScenarios, {
        tags: ["runtime"],
        scenarios: ["tool-success-checkpoint"],
      }).map((scenario) => scenario.id),
    ).toEqual(["tool-success-checkpoint"]);

    expect(() =>
      filterRuntimeHarnessScenarios(defaultRuntimeHarnessScenarios, {
        scenarios: ["missing"],
      }),
    ).toThrow("Unknown runtime harness scenario: missing");
  });
});
