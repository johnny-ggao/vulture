import {
  createDesktopArtifactRun,
  writeDesktopScenarioSummary,
  type DesktopArtifactRun,
  type DesktopScenarioResult,
  type DesktopStepResult,
} from "./artifacts";
import type { DesktopScenario, DesktopScenarioStep } from "./scenarios";

export interface DesktopDriverContext {
  scenario: DesktopScenario;
  artifacts: DesktopArtifactRun;
  signal: AbortSignal;
  deadlineMs: number;
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
  const startedAt = now();
  const deadlineMs = startedAt + Math.max(0, options.scenario.timeoutMs);
  const artifacts = createDesktopArtifactRun(options.artifactRoot, options.scenario.id, options.runId);
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => {
    timeoutController.abort(new Error(`Scenario timed out after ${options.scenario.timeoutMs}ms`));
  }, Math.max(0, options.scenario.timeoutMs));
  const context: DesktopDriverContext = {
    scenario: options.scenario,
    artifacts,
    signal: timeoutController.signal,
    deadlineMs,
  };

  const steps: DesktopStepResult[] = [];
  let status: DesktopScenarioResult["status"] = "passed";

  try {
    for (const [index, step] of options.scenario.steps.entries()) {
      const stepName = formatStepName(step, index);
      try {
        await executeStepWithDeadline(options.driver, step, stepName, context, timeoutController, now);
        steps.push({
          name: stepName,
          status: "passed",
        });
      } catch (error) {
        status = "failed";
        steps.push({
          name: stepName,
          status: "failed",
          error: toErrorMessage(error),
        });
        break;
      }
    }
  } finally {
    clearTimeout(timeoutHandle);
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

  writeDesktopScenarioSummary(artifacts.scenarioDir, result);

  return result;
}

async function executeStepWithDeadline(
  driver: DesktopDriver,
  step: DesktopScenarioStep,
  stepName: string,
  context: DesktopDriverContext,
  timeoutController: AbortController,
  now: () => number,
): Promise<void> {
  const remainingMs = Math.max(0, context.deadlineMs - now());
  if (remainingMs === 0) {
    const error = new Error(`${stepName} timed out after ${context.scenario.timeoutMs}ms`);
    if (!context.signal.aborted) {
      timeoutController.abort(error);
    }
    throw error;
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      executeStep(driver, step, context),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          const error = new Error(`${stepName} timed out after ${context.scenario.timeoutMs}ms`);
          if (!context.signal.aborted) {
            timeoutController.abort(error);
          }
          reject(error);
        }, remainingMs);
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
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

function formatStepName(step: DesktopScenarioStep, index: number): string {
  const prefix = `${index + 1}. ${step.action}`;

  switch (step.action) {
    case "sendMessage":
    case "expectMessage":
      return `${prefix}(${JSON.stringify(step.text)})`;
    case "openNavigation":
      return `${prefix}(${JSON.stringify(step.label)})`;
    case "captureScreenshot":
      return `${prefix}(${JSON.stringify(step.name)})`;
    case "launchApp":
    case "waitForChatReady":
      return prefix;
    default:
      step satisfies never;
      return prefix;
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
