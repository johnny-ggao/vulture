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
        { name: "1. launchApp", status: "passed" },
        { name: "2. waitForChatReady", status: "passed" },
        { name: '3. sendMessage("hello")', status: "passed" },
        { name: '4. expectMessage("hello")', status: "passed" },
        { name: '5. openNavigation("Settings")', status: "passed" },
        { name: '6. captureScreenshot("final")', status: "passed" },
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
      expect(summary).toEqual(result);
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
        { name: "1. launchApp", status: "passed" },
        { name: "2. waitForChatReady", status: "passed" },
        { name: '3. sendMessage("boom")', status: "failed", error: "message rejected" },
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
        { name: "1. launchApp", status: "passed" },
        { name: "shutdown", status: "failed", error: "session cleanup failed" },
      ]);
      expect(driver.calls).toEqual(["launchApp", "shutdown"]);
      expect(driver.shutdownCalls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("times out long-running steps using the scenario deadline and still shuts down deterministically", async () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-desktop-runner-"));
    try {
      const driver = new FakeDriver({
        hangs: ["waitForChatReady"],
      });

      const result = await runDesktopScenario({
        artifactRoot: root,
        driver,
        runId: "fixed-run",
        scenario: {
          id: "timeout-path",
          name: "Timeout path",
          tags: ["desktop"],
          timeoutMs: 20,
          steps: [
            { action: "launchApp" },
            { action: "waitForChatReady" },
            { action: "captureScreenshot", name: "never-runs" },
          ],
        },
      });

      expect(result.status).toBe("failed");
      expect(result.steps).toEqual([
        { name: "1. launchApp", status: "passed" },
        { name: "2. waitForChatReady", status: "failed", error: '2. waitForChatReady timed out after 20ms' },
      ]);
      expect(driver.calls).toEqual(["launchApp", "waitForChatReady", "shutdown"]);
      expect(driver.shutdownCalls).toBe(1);
      expect(driver.shutdownContexts).toHaveLength(1);
      expect(driver.shutdownContexts[0]?.signal.aborted).toBe(true);
      expect(typeof driver.shutdownContexts[0]?.deadlineMs).toBe("number");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("labels repeated actions with stable indexed names", async () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-desktop-runner-"));
    try {
      const driver = new FakeDriver();

      const result = await runDesktopScenario({
        artifactRoot: root,
        driver,
        runId: "fixed-run",
        scenario: {
          id: "repeated-steps",
          name: "Repeated steps",
          tags: ["desktop"],
          timeoutMs: 10_000,
          steps: [
            { action: "launchApp" },
            { action: "openNavigation", label: "设置" },
            { action: "openNavigation", label: "技能" },
            { action: "openNavigation", label: "智能体" },
          ],
        },
      });

      expect(result.steps.map((step) => step.name)).toEqual([
        "1. launchApp",
        '2. openNavigation("设置")',
        '3. openNavigation("技能")',
        '4. openNavigation("智能体")',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

interface FakeDriverOptions {
  failures?: Partial<Record<FakeAction, Error>>;
  hangs?: FakeAction[];
}

type FakeAction = DesktopScenarioStep["action"] | "shutdown";

class FakeDriver implements DesktopDriver {
  readonly calls: string[] = [];
  readonly captureContexts: DesktopDriverContext[] = [];
  readonly shutdownContexts: DesktopDriverContext[] = [];
  shutdownCalls = 0;

  #failures: Map<FakeAction, Error>;
  #hangs: Set<FakeAction>;

  constructor(options: FakeDriverOptions = {}) {
    this.#failures = new Map(Object.entries(options.failures ?? {}) as [FakeAction, Error][]);
    this.#hangs = new Set(options.hangs ?? []);
  }

  async launchApp(context: DesktopDriverContext): Promise<void> {
    await this.record("launchApp", context);
  }

  async waitForChatReady(context: DesktopDriverContext): Promise<void> {
    await this.record("waitForChatReady", context);
  }

  async sendMessage(
    _step: Extract<DesktopScenarioStep, { action: "sendMessage" }>,
    context: DesktopDriverContext,
  ): Promise<void> {
    await this.record("sendMessage", context);
  }

  async expectMessage(
    _step: Extract<DesktopScenarioStep, { action: "expectMessage" }>,
    context: DesktopDriverContext,
  ): Promise<void> {
    await this.record("expectMessage", context);
  }

  async openNavigation(
    _step: Extract<DesktopScenarioStep, { action: "openNavigation" }>,
    context: DesktopDriverContext,
  ): Promise<void> {
    await this.record("openNavigation", context);
  }

  async captureScreenshot(
    _step: Extract<DesktopScenarioStep, { action: "captureScreenshot" }>,
    context: DesktopDriverContext,
  ): Promise<void> {
    this.captureContexts.push(context);
    await this.record("captureScreenshot", context);
  }

  async shutdown(context: DesktopDriverContext): Promise<void> {
    this.shutdownCalls += 1;
    this.shutdownContexts.push(context);
    await this.record("shutdown", context);
  }

  private async record(action: FakeAction, _context: DesktopDriverContext): Promise<void> {
    this.calls.push(action);
    if (this.#hangs.has(action)) {
      await new Promise<void>(() => {});
      return;
    }
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
