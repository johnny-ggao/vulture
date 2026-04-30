import {
  createDesktopArtifactRun,
  writeDesktopSummary,
  type DesktopArtifactRun,
  type DesktopScenarioResult,
  type DesktopStepResult,
} from "./artifacts";
import type { DesktopScenario, DesktopScenarioStep } from "./scenarios";

export interface DesktopDriverContext {
  scenario: DesktopScenario;
  artifacts: DesktopArtifactRun;
}

export interface DesktopDriver {
  launchApp(context: DesktopDriverContext): Promise<void>;
  waitForChatReady(context: DesktopDriverContext): Promise<void>;
  sendMessage(step: Extract<DesktopScenarioStep, { action: "sendMessage" }>, context: DesktopDriverContext): Promise<void>;
  expectMessage(
    step: Extract<DesktopScenarioStep, { action: "expectMessage" }>,
    context: DesktopDriverContext,
  ): Promise<void>;
  openNavigation(
    step: Extract<DesktopScenarioStep, { action: "openNavigation" }>,
    context: DesktopDriverContext,
  ): Promise<void>;
  captureScreenshot(
    step: Extract<DesktopScenarioStep, { action: "captureScreenshot" }>,
    context: DesktopDriverContext,
  ): Promise<void>;
  shutdown(context: DesktopDriverContext): Promise<void>;
}

export interface RunDesktopScenarioOptions {
  artifactRoot: string;
  driver: DesktopDriver;
  now?: () => number;
  runId?: string;
  scenario: DesktopScenario;
}

export async function runDesktopScenario(options: RunDesktopScenarioOptions): Promise<DesktopScenarioResult> {
  const now = options.now ?? Date.now;
  const artifacts = createDesktopArtifactRun(options.artifactRoot, options.scenario.id, options.runId);
  const context: DesktopDriverContext = {
    scenario: options.scenario,
    artifacts,
  };

  const startedAt = now();
  const steps: DesktopStepResult[] = [];
  let status: DesktopScenarioResult["status"] = "passed";

  try {
    for (const step of options.scenario.steps) {
      try {
        await executeStep(options.driver, step, context);
        steps.push({
          name: step.action,
          status: "passed",
        });
      } catch (error) {
        status = "failed";
        steps.push({
          name: step.action,
          status: "failed",
          error: toErrorMessage(error),
        });
        break;
      }
    }
  } finally {
    try {
      await options.driver.shutdown(context);
    } catch (error) {
      steps.push({
        name: "shutdown",
        status: "failed",
        error: toErrorMessage(error),
      });
      status = "failed";
    }
  }

  const result: DesktopScenarioResult = {
    id: options.scenario.id,
    name: options.scenario.name,
    status,
    durationMs: Math.max(0, now() - startedAt),
    artifactPath: artifacts.scenarioDir,
    steps,
  };

  writeDesktopSummary(artifacts.scenarioDir, [result]);

  return result;
}

async function executeStep(driver: DesktopDriver, step: DesktopScenarioStep, context: DesktopDriverContext): Promise<void> {
  switch (step.action) {
    case "launchApp":
      await driver.launchApp(context);
      return;
    case "waitForChatReady":
      await driver.waitForChatReady(context);
      return;
    case "sendMessage":
      await driver.sendMessage(step, context);
      return;
    case "expectMessage":
      await driver.expectMessage(step, context);
      return;
    case "openNavigation":
      await driver.openNavigation(step, context);
      return;
    case "captureScreenshot":
      await driver.captureScreenshot(step, context);
      return;
    default:
      step satisfies never;
      throw new Error("Unknown desktop scenario step");
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
