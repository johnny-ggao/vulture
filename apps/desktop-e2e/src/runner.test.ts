import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runDesktopScenario,
  type DesktopDriver,
  type DesktopDriverContext,
  type RunDesktopScenarioOptions,
} from "./runner";
import type { DesktopScenario, DesktopScenarioStep } from "./scenarios";

describe("desktop scenario runner", () => {
  test("returns passed results, records step order, shuts down driver, and writes a per-scenario summary", async () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-desktop-runner-"));
    try {
      const driver = new FakeDriver();

      const result = await runDesktopScenario({
        artifactRoot: root,
        driver,
        runId: "fixed-run",
        scenario: {
          id: "happy-path",
          name: "Happy path",
          tags: ["desktop"],
          timeoutMs: 10_000,
          steps: [
            { action: "launchApp" },
            { action: "waitForChatReady" },
            { action: "sendMessage", text: "hello" },
            { action: "expectMessage", text: "hello" },
            { action: "openNavigation", label: "Settings" },
            { action: "captureScreenshot", name: "final" },
          ],
        },
        now: sequenceNow([10, 5]),
      });

      expect(result.status).toBe("passed");
      expect(result.durationMs).toBe(0);
      expect(result.steps).toEqual([
        { name: "launchApp", status: "passed" },
        { name: "waitForChatReady", status: "passed" },
        { name: "sendMessage", status: "passed" },
        { name: "expectMessage", status: "passed" },
        { name: "openNavigation", status: "passed" },
        { name: "captureScreenshot", status: "passed" },
      ]);
      expect(driver.calls).toEqual([
        "launchApp",
        "waitForChatReady",
        "sendMessage",
        "expectMessage",
        "openNavigation",
        "captureScreenshot",
        "shutdown",
      ]);
      expect(driver.shutdownCalls).toBe(1);

      const summaryPath = join(result.artifactPath, "summary.json");
      expect(existsSync(summaryPath)).toBe(true);

      const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
      expect(summary).toMatchObject({
        total: 1,
        passed: 1,
        failed: 0,
      });
      expect(summary.results).toHaveLength(1);
      expect(summary.results[0]).toMatchObject({
        id: "happy-path",
        status: "passed",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("marks the scenario failed, stops later steps, preserves the original step failure, and still shuts down", async () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-desktop-runner-"));
    try {
      const driver = new FakeDriver({
        failures: {
          sendMessage: new Error("message rejected"),
          shutdown: new Error("shutdown also failed"),
        },
      });

      const result = await runDesktopScenario({
        artifactRoot: root,
        driver,
        runId: "fixed-run",
        scenario: {
          id: "step-failure",
          name: "Step failure",
          tags: ["desktop"],
          timeoutMs: 10_000,
          steps: [
            { action: "launchApp" },
            { action: "waitForChatReady" },
            { action: "sendMessage", text: "boom" },
            { action: "expectMessage", text: "boom" },
            { action: "captureScreenshot", name: "should-not-run" },
          ],
        },
      });

      expect(result.status).toBe("failed");
      expect(result.steps).toEqual([
        { name: "launchApp", status: "passed" },
        { name: "waitForChatReady", status: "passed" },
        { name: "sendMessage", status: "failed", error: "message rejected" },
        { name: "shutdown", status: "failed", error: "shutdown also failed" },
      ]);
      expect(driver.calls).toEqual(["launchApp", "waitForChatReady", "sendMessage", "shutdown"]);
      expect(driver.shutdownCalls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("passes artifact directories to captureScreenshot so the driver can write screenshots and logs deterministically", async () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-desktop-runner-"));
    try {
      const driver = new FakeDriver();

      const result = await runDesktopScenario({
        artifactRoot: root,
        driver,
        runId: "fixed-run",
        scenario: {
          id: "artifact-aware",
          name: "Artifact aware",
          tags: ["desktop"],
          timeoutMs: 10_000,
          steps: [{ action: "launchApp" }, { action: "captureScreenshot", name: "ready" }],
        },
      });

      expect(result.status).toBe("passed");
      expect(driver.captureContexts).toHaveLength(1);

      const context = driver.captureContexts[0];
      expect(context.artifacts.scenarioDir).toBe(result.artifactPath);
      expect(context.artifacts.screenshotsDir).toBe(join(result.artifactPath, "screenshots"));
      expect(context.artifacts.logsDir).toBe(join(result.artifactPath, "logs"));
      expect(existsSync(context.artifacts.screenshotsDir)).toBe(true);
      expect(existsSync(context.artifacts.logsDir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("converts a shutdown failure after successful steps into a failed scenario", async () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-desktop-runner-"));
    try {
      const driver = new FakeDriver({
        failures: {
          shutdown: new Error("session cleanup failed"),
        },
      });

      const result = await runDesktopScenario({
        artifactRoot: root,
        driver,
        runId: "fixed-run",
        scenario: {
          id: "shutdown-failure",
          name: "Shutdown failure",
          tags: ["desktop"],
          timeoutMs: 10_000,
          steps: [{ action: "launchApp" }],
        },
      });

      expect(result.status).toBe("failed");
      expect(result.steps).toEqual([
        { name: "launchApp", status: "passed" },
        { name: "shutdown", status: "failed", error: "session cleanup failed" },
      ]);
      expect(driver.calls).toEqual(["launchApp", "shutdown"]);
      expect(driver.shutdownCalls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

interface FakeDriverOptions {
  failures?: Partial<Record<FakeAction, Error>>;
}

type FakeAction = DesktopScenarioStep["action"] | "shutdown";

class FakeDriver implements DesktopDriver {
  readonly calls: string[] = [];
  readonly captureContexts: DesktopDriverContext[] = [];
  shutdownCalls = 0;

  #failures: Map<FakeAction, Error>;

  constructor(options: FakeDriverOptions = {}) {
    this.#failures = new Map(Object.entries(options.failures ?? {}) as [FakeAction, Error][]);
  }

  async launchApp(context: DesktopDriverContext): Promise<void> {
    this.record("launchApp", context);
  }

  async waitForChatReady(context: DesktopDriverContext): Promise<void> {
    this.record("waitForChatReady", context);
  }

  async sendMessage(
    _step: Extract<DesktopScenarioStep, { action: "sendMessage" }>,
    context: DesktopDriverContext,
  ): Promise<void> {
    this.record("sendMessage", context);
  }

  async expectMessage(
    _step: Extract<DesktopScenarioStep, { action: "expectMessage" }>,
    context: DesktopDriverContext,
  ): Promise<void> {
    this.record("expectMessage", context);
  }

  async openNavigation(
    _step: Extract<DesktopScenarioStep, { action: "openNavigation" }>,
    context: DesktopDriverContext,
  ): Promise<void> {
    this.record("openNavigation", context);
  }

  async captureScreenshot(
    _step: Extract<DesktopScenarioStep, { action: "captureScreenshot" }>,
    context: DesktopDriverContext,
  ): Promise<void> {
    this.captureContexts.push(context);
    this.record("captureScreenshot", context);
  }

  async shutdown(context: DesktopDriverContext): Promise<void> {
    this.shutdownCalls += 1;
    this.record("shutdown", context);
  }

  private record(action: FakeAction, _context: DesktopDriverContext): void {
    this.calls.push(action);
    const failure = this.#failures.get(action);
    if (failure) {
      throw failure;
    }
  }
}

function sequenceNow(values: number[]): RunDesktopScenarioOptions["now"] {
  let index = 0;
  return () => {
    const value = values[index];
    index += 1;
    return value ?? values[values.length - 1] ?? 0;
  };
}
