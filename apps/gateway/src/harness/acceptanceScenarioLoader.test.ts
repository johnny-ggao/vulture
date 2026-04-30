import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadAcceptanceScenarioFile,
  loadAcceptanceScenarioFiles,
  validateAcceptanceScenario,
} from "./acceptanceScenarioLoader";

describe("acceptance scenario loader", () => {
  test("loads a JSON scenario file", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-scenario-loader-"));
    try {
      const path = join(dir, "scenario.json");
      writeFileSync(
        path,
        JSON.stringify({
          id: "json-conversation",
          name: "JSON conversation",
          tags: ["json", "chat"],
          steps: [
            { action: "createConversation", as: "conversation", agentId: "local-work-agent" },
            { action: "sendMessage", conversation: "conversation", input: "ping", asRun: "run" },
            { action: "waitForRun", run: "run", status: "succeeded" },
          ],
        }),
      );

      const scenario = loadAcceptanceScenarioFile(path);
      expect(scenario.id).toBe("json-conversation");
      expect(scenario.tags).toEqual(["json", "chat"]);
      expect(scenario.steps.map((step) => step.action)).toEqual([
        "createConversation",
        "sendMessage",
        "waitForRun",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("loads multiple scenario files in order", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-scenario-loader-"));
    try {
      const first = join(dir, "first.json");
      const second = join(dir, "second.json");
      writeFileSync(first, JSON.stringify({ id: "first", name: "First", steps: [] }));
      writeFileSync(second, JSON.stringify({ id: "second", name: "Second", steps: [] }));

      expect(loadAcceptanceScenarioFiles([first, second]).map((scenario) => scenario.id)).toEqual([
        "first",
        "second",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects malformed scenario files", () => {
    expect(() =>
      validateAcceptanceScenario({
        id: "bad",
        name: "Bad",
        steps: [{ action: "missingAction" }],
      }),
    ).toThrow("Unsupported acceptance step action");
    expect(() =>
      validateAcceptanceScenario({
        id: "bad",
        name: "Bad",
        tags: ["ok", 1],
        steps: [],
      }),
    ).toThrow("Acceptance scenario tags must be strings");
  });
});
