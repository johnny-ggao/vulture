import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultAcceptanceScenarios,
  filterAcceptanceScenariosByTags,
  selectAcceptanceScenarios,
  summarizeAcceptanceResults,
  writeAcceptanceFailureReport,
  writeAcceptanceJUnitReport,
  writeAcceptanceSuiteArtifacts,
} from "./acceptanceSuite";

describe("acceptance suite", () => {
  test("ships a default conversation acceptance scenario", () => {
    expect(defaultAcceptanceScenarios.map((scenario) => scenario.id)).toContain("conversation-happy-path");
    const scenario = defaultAcceptanceScenarios.find((item) => item.id === "conversation-happy-path");
    expect(scenario?.tags).toEqual(expect.arrayContaining(["fast", "chat"]));
    expect(scenario?.steps.map((step) => step.action)).toEqual([
      "createConversation",
      "sendMessage",
      "waitForRun",
      "listMessages",
      "assertMessages",
    ]);
  });

  test("ships a default interrupted tool recovery scenario", () => {
    expect(defaultAcceptanceScenarios.map((scenario) => scenario.id)).toContain("recovery-interrupted-tool");
    const scenario = defaultAcceptanceScenarios.find((item) => item.id === "recovery-interrupted-tool");
    expect(scenario?.steps.map((step) => step.action)).toEqual([
      "createConversation",
      "seedInterruptedToolRun",
      "restartGateway",
      "waitForRun",
    ]);
  });

  test("ships a default attachment message scenario", () => {
    expect(defaultAcceptanceScenarios.map((scenario) => scenario.id)).toContain("attachment-message-link");
    const scenario = defaultAcceptanceScenarios.find((item) => item.id === "attachment-message-link");
    expect(scenario?.steps.map((step) => step.action)).toEqual([
      "createConversation",
      "uploadTextAttachment",
      "sendMessage",
      "waitForRun",
      "assertMessageAttachment",
    ]);
  });

  test("ships a default run event terminal replay scenario", () => {
    expect(defaultAcceptanceScenarios.map((scenario) => scenario.id)).toContain("run-event-terminal-replay");
    const scenario = defaultAcceptanceScenarios.find((item) => item.id === "run-event-terminal-replay");
    expect(scenario?.steps.map((step) => step.action)).toEqual([
      "createConversation",
      "sendMessage",
      "waitForRun",
      "readRunEvents",
      "assertRunEvents",
      "readRunEvents",
      "assertRunEvents",
    ]);
  });

  test("ships a default recoverable run list scenario", () => {
    expect(defaultAcceptanceScenarios.map((scenario) => scenario.id)).toContain("recovery-list-recoverable-runs");
    const scenario = defaultAcceptanceScenarios.find((item) => item.id === "recovery-list-recoverable-runs");
    expect(scenario?.steps.map((step) => step.action)).toEqual([
      "createConversation",
      "seedInterruptedToolRun",
      "restartGateway",
      "waitForRun",
      "listConversationRuns",
      "assertRuns",
    ]);
  });

  test("ships a default active run list scenario", () => {
    expect(defaultAcceptanceScenarios.map((scenario) => scenario.id)).toContain("restore-list-active-runs");
    const scenario = defaultAcceptanceScenarios.find((item) => item.id === "restore-list-active-runs");
    expect(scenario?.steps.map((step) => step.action)).toEqual([
      "createConversation",
      "seedRunningRun",
      "listConversationRuns",
      "assertRuns",
    ]);
  });

  test("ships default cancellation, idempotency, and attachment content scenarios", () => {
    expect(defaultAcceptanceScenarios.map((scenario) => scenario.id)).toEqual(
      expect.arrayContaining([
        "run-cancel-active",
        "run-create-idempotency",
        "attachment-content-fetch",
        "mcp-config-management",
      ]),
    );
  });

  test("ships a default MCP config management scenario", () => {
    const scenario = defaultAcceptanceScenarios.find((item) => item.id === "mcp-config-management");
    expect(scenario?.tags).toEqual(expect.arrayContaining(["fast", "mcp"]));
    expect(scenario?.steps.map((step) => step.action)).toEqual([
      "createMcpServer",
      "listMcpServers",
      "assertMcpServers",
      "listMcpTools",
      "assertMcpTools",
    ]);
  });

  test("ships a default subagent orchestration scenario", () => {
    expect(defaultAcceptanceScenarios.map((scenario) => scenario.id)).toContain(
      "subagent-spawn-yield-history",
    );
    const scenario = defaultAcceptanceScenarios.find((item) => item.id === "subagent-spawn-yield-history");
    expect(scenario?.tags).toEqual(expect.arrayContaining(["fast", "subagents"]));
    expect(scenario?.steps.map((step) => step.action)).toEqual([
      "createConversation",
      "seedRunningRun",
      "seedSubagentSession",
      "listSubagentSessions",
      "assertSubagentSessions",
      "listSubagentMessages",
      "assertMessages",
      "restartGateway",
      "listSubagentSessions",
      "assertSubagentSessions",
    ]);
  });

  test("summarizes multiple scenario results for CLI output", () => {
    const summary = summarizeAcceptanceResults([
      {
        scenarioId: "a",
        scenarioName: "A",
        status: "passed",
        artifactPath: "/tmp/a",
        steps: [],
        resources: emptyResources(),
      },
      {
        scenarioId: "b",
        scenarioName: "B",
        status: "failed",
        artifactPath: "/tmp/b",
        steps: [],
        resources: emptyResources(),
      },
    ]);

    expect(summary).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      status: "failed",
    });
  });

  test("selects scenarios by id and rejects unknown ids", () => {
    const selected = selectAcceptanceScenarios(["conversation-happy-path", "run-cancel-active"]);
    expect(selected.map((scenario) => scenario.id)).toEqual(["conversation-happy-path", "run-cancel-active"]);
    expect(() => selectAcceptanceScenarios(["missing"])).toThrow("Unknown acceptance scenario missing");
  });

  test("filters scenarios by tag using OR semantics", () => {
    expect(filterAcceptanceScenariosByTags([], defaultAcceptanceScenarios)).toHaveLength(defaultAcceptanceScenarios.length);
    expect(filterAcceptanceScenariosByTags(["mcp"], defaultAcceptanceScenarios).map((scenario) => scenario.id)).toEqual([
      "mcp-config-management",
    ]);
    expect(filterAcceptanceScenariosByTags(["recovery"], defaultAcceptanceScenarios).map((scenario) => scenario.id)).toEqual([
      "recovery-interrupted-tool",
      "recovery-list-recoverable-runs",
      "restore-list-active-runs",
      "subagent-spawn-yield-history",
    ]);
    expect(filterAcceptanceScenariosByTags(["missing"], defaultAcceptanceScenarios)).toEqual([]);
  });

  test("writes suite-level summary artifact", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-acceptance-suite-"));
    try {
      const artifact = writeAcceptanceSuiteArtifacts(dir, [
        {
          scenarioId: "a",
          scenarioName: "A",
          status: "passed",
          artifactPath: "/tmp/a",
          steps: [],
          resources: emptyResources(),
        },
      ]);
      expect(artifact.status).toBe("passed");
      expect(existsSync(join(dir, "summary.json"))).toBe(true);
      const summary = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as {
        total: number;
        scenarios: Array<{ id: string }>;
      };
      expect(summary.total).toBe(1);
      expect(summary.scenarios[0].id).toBe("a");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writes a failure report only when scenarios fail", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-acceptance-failure-"));
    try {
      const passedPath = writeAcceptanceFailureReport(dir, [
        {
          scenarioId: "ok",
          scenarioName: "OK",
          status: "passed",
          artifactPath: "/tmp/ok",
          steps: [],
          resources: emptyResources(),
        },
      ]);
      expect(passedPath).toBeNull();
      expect(existsSync(join(dir, "failure-report.md"))).toBe(false);

      const failedPath = writeAcceptanceFailureReport(dir, [
        {
          scenarioId: "bad",
          scenarioName: "Bad",
          status: "failed",
          artifactPath: "/tmp/bad",
          steps: [
            {
              index: 0,
              action: "assertMessages",
              status: "failed",
              startedAt: "2026-04-30T00:00:00.000Z",
              endedAt: "2026-04-30T00:00:00.001Z",
              error: "missing assistant",
            },
          ],
          resources: emptyResources(),
        },
      ]);
      expect(failedPath).toBe(join(dir, "failure-report.md"));
      const report = readFileSync(join(dir, "failure-report.md"), "utf8");
      expect(report).toContain("# Acceptance Failure Report");
      expect(report).toContain("bad");
      expect(report).toContain("missing assistant");
      expect(report).toContain("/tmp/bad");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writes a JUnit report for CI test surfaces", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-acceptance-junit-"));
    try {
      const path = writeAcceptanceJUnitReport(dir, [
        {
          scenarioId: "ok",
          scenarioName: "OK",
          status: "passed",
          artifactPath: "/tmp/ok",
          steps: [],
          resources: emptyResources(),
        },
        {
          scenarioId: "bad<&>",
          scenarioName: "Bad <case>",
          status: "failed",
          artifactPath: "/tmp/bad",
          steps: [
            {
              index: 0,
              action: "assertMessages",
              status: "failed",
              startedAt: "2026-04-30T00:00:00.000Z",
              endedAt: "2026-04-30T00:00:00.001Z",
              error: "missing <assistant>",
            },
          ],
          resources: emptyResources(),
        },
      ]);
      expect(path).toBe(join(dir, "junit.xml"));
      const xml = readFileSync(path, "utf8");
      expect(xml).toContain('<testsuite name="vulture.acceptance" tests="2" failures="1"');
      expect(xml).toContain('<testcase classname="vulture.acceptance" name="OK">');
      expect(xml).toContain('name="Bad &lt;case&gt;"');
      expect(xml).toContain('missing &lt;assistant&gt;');
      expect(xml).toContain('/tmp/bad');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function emptyResources() {
  return {
    conversations: {},
    runs: {},
    messages: {},
    messageLists: {},
    attachments: {},
    runEvents: {},
    runLists: {},
    attachmentContents: {},
    mcpServers: {},
    mcpServerLists: {},
    mcpToolLists: {},
    subagentSessions: {},
    subagentSessionLists: {},
  };
}
