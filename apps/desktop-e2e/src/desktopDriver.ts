import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { startProcess, type ManagedProcess, type ProcessExitResult, type StartProcessOptions } from "./processes";
import type { DesktopDriver, DesktopDriverContext } from "./runner";
import { WebDriverClient } from "./webdriver";

const POLL_INTERVAL_MS = 250;
const DEFAULT_CLEANUP_TIMEOUT_MS = 2_000;
const CHAT_TEXTAREA_SELECTOR = 'textarea[placeholder*="输入问题"]';
const CHAT_TEXTAREA_XPATH = `//textarea[contains(@placeholder, "输入问题") or contains(@aria-label, "输入问题")]`;
const SEND_BUTTON_XPATH = `//button[@aria-label="发送" or normalize-space(.)="发送"]`;

interface WebDriverLike {
  createSession(alwaysMatch?: Record<string, unknown>): Promise<string>;
  findElement(using: string, value: string): Promise<string>;
  click(elementId: string): Promise<void>;
  type(elementId: string, text: string): Promise<void>;
  screenshot(): Promise<Buffer>;
  pageSource(): Promise<string>;
  deleteSession(): Promise<void>;
}

export interface RealDesktopDriverOptions {
  repoRoot: string;
  webdriverUrl: string;
}

export interface RealDesktopDriverDependencies {
  startProcess?: (options: StartProcessOptions) => ManagedProcess;
  createWebDriver?: (baseUrl: string) => WebDriverLike;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  cleanupTimeoutMs?: number;
}

interface ProcessExitState {
  process: ManagedProcess;
  settled: boolean;
  result: ProcessExitResult | null;
  observedExit: Promise<ProcessExitResult>;
}

export class RealDesktopDriver implements DesktopDriver {
  readonly #startProcess;
  readonly #webdriver;
  readonly #now;
  readonly #sleep;
  readonly #cleanupTimeoutMs;
  readonly #options;
  #app: ManagedProcess | null = null;
  #appExitState: ProcessExitState | null = null;
  #driver: ManagedProcess | null = null;
  #driverExitState: ProcessExitState | null = null;
  #shutdownPromise: Promise<void> | null = null;

  constructor(options: RealDesktopDriverOptions, dependencies: RealDesktopDriverDependencies = {}) {
    this.#options = options;
    this.#startProcess = dependencies.startProcess ?? startProcess;
    this.#webdriver = (dependencies.createWebDriver ?? ((baseUrl) => new WebDriverClient(baseUrl)))(options.webdriverUrl);
    this.#now = dependencies.now ?? Date.now;
    this.#sleep = dependencies.sleep ?? sleepWithAbort;
    this.#cleanupTimeoutMs = dependencies.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS;
  }

  async launchApp(context: DesktopDriverContext): Promise<void> {
    this.#throwIfAborted(context);

    const rootDir = join(context.artifacts.scenarioDir, "root");
    const workspaceDir = join(context.artifacts.scenarioDir, "workspace");
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });

    this.#driver = this.#startProcess({
      name: "tauri-driver",
      argv: ["tauri-driver", "--port", String(resolveWebDriverPort(this.#options.webdriverUrl))],
      cwd: this.#options.repoRoot,
      logsDir: context.artifacts.logsDir,
    });
    this.#driverExitState = trackProcessExit(this.#driver);

    this.#app = this.#startProcess({
      name: "cargo-tauri-dev",
      argv: ["cargo", "tauri", "dev"],
      cwd: join(this.#options.repoRoot, "apps", "desktop-shell"),
      logsDir: context.artifacts.logsDir,
      env: {
        VULTURE_DESKTOP_ROOT: rootDir,
        VULTURE_DESKTOP_DEFAULT_WORKSPACE: workspaceDir,
        VULTURE_MEMORY_SUGGESTIONS: "0",
      },
    });
    this.#appExitState = trackProcessExit(this.#app);

    await this.#retry(context, () => this.#createSessionWhileWatchingProcesses());
  }

  async waitForChatReady(context: DesktopDriverContext): Promise<void> {
    await this.#retry(context, () => findChatTextarea(this.#webdriver));
  }

  async sendMessage(
    step: Extract<DesktopDriverContext["scenario"]["steps"][number], { action: "sendMessage" }>,
    context: DesktopDriverContext,
  ): Promise<void> {
    this.#throwIfAborted(context);

    const textarea = await findChatTextarea(this.#webdriver);
    await this.#webdriver.type(textarea, step.text);

    const sendButton = await this.#webdriver.findElement("xpath", SEND_BUTTON_XPATH);
    await this.#webdriver.click(sendButton);
  }

  async expectMessage(
    step: Extract<DesktopDriverContext["scenario"]["steps"][number], { action: "expectMessage" }>,
    context: DesktopDriverContext,
  ): Promise<void> {
    await this.#retry(context, async () => {
      const source = await this.#webdriver.pageSource();
      if (!source.includes(step.text)) {
        throw new Error(`Expected page source to contain ${JSON.stringify(step.text)}`);
      }
    });
  }

  async openNavigation(
    step: Extract<DesktopDriverContext["scenario"]["steps"][number], { action: "openNavigation" }>,
    context: DesktopDriverContext,
  ): Promise<void> {
    this.#throwIfAborted(context);

    const target = await this.#webdriver.findElement("xpath", navigationButtonXPath(step.label));
    await this.#webdriver.click(target);
  }

  async captureScreenshot(
    step: Extract<DesktopDriverContext["scenario"]["steps"][number], { action: "captureScreenshot" }>,
    context: DesktopDriverContext,
  ): Promise<void> {
    this.#throwIfAborted(context);

    mkdirSync(context.artifacts.screenshotsDir, { recursive: true });

    const screenshot = await this.#webdriver.screenshot();
    writeFileSync(join(context.artifacts.screenshotsDir, `${safePathPart(step.name)}.png`), screenshot);

    const dom = await this.#webdriver.pageSource();
    writeFileSync(join(context.artifacts.scenarioDir, "dom.html"), dom);
  }

  async shutdown(_context: DesktopDriverContext): Promise<void> {
    if (this.#shutdownPromise) {
      return await this.#shutdownPromise;
    }

    this.#shutdownPromise = (async () => {
      const errors: Error[] = [];

      try {
        await withTimeout(
          this.#webdriver.deleteSession(),
          this.#cleanupTimeoutMs,
          "deleting WebDriver session",
        );
      } catch (error) {
        errors.push(toError(error));
      }

      const app = this.#app;
      this.#app = null;
      this.#appExitState = null;
      if (app) {
        try {
          await this.#stopProcessWithinTimeout(app);
        } catch (error) {
          errors.push(toError(error));
        }
      }

      const driver = this.#driver;
      this.#driver = null;
      this.#driverExitState = null;
      if (driver) {
        try {
          await this.#stopProcessWithinTimeout(driver);
        } catch (error) {
          errors.push(toError(error));
        }
      }

      if (errors.length > 0) {
        throw errors[0];
      }
    })();

    return await this.#shutdownPromise;
  }

  async #retry<T>(context: DesktopDriverContext, operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    while (true) {
      this.#throwIfAborted(context);

      try {
        return await operation();
      } catch (error) {
        if (isNonRetryableError(error)) {
          throw error;
        }
        lastError = error;
      }

      const remainingMs = context.deadlineMs - this.#now();
      if (remainingMs <= 0) {
        this.#throwIfAborted(context);
        throw toError(lastError);
      }

      await this.#sleep(Math.min(POLL_INTERVAL_MS, remainingMs), context.signal);
    }
  }

  async #createSessionWhileWatchingProcesses(): Promise<string> {
    const watched = [this.#driverExitState, this.#appExitState].filter((state): state is ProcessExitState => state !== null);
    await Promise.resolve();
    const exited = watched.find((state) => state.settled && state.result) ?? null;
    if (exited?.result) {
      throw createProcessExitError(exited.process, exited.result.exitCode);
    }

    const sessionAttempt = await Promise.race([
      this.#webdriver.createSession({ browserName: "wry" }).then(
        (sessionId) => ({ kind: "session" as const, sessionId }),
        (error) => ({ kind: "error" as const, error }),
      ),
      ...watched.map((state) =>
        state.observedExit.then((result) => ({
          kind: "process-exit" as const,
          process: state.process,
          result,
        })),
      ),
    ]);

    switch (sessionAttempt.kind) {
      case "session":
        return sessionAttempt.sessionId;
      case "error":
        throw sessionAttempt.error;
      case "process-exit":
        throw createProcessExitError(sessionAttempt.process, sessionAttempt.result.exitCode);
      default:
        sessionAttempt satisfies never;
        throw new Error("Unknown session readiness result");
    }
  }

  async #stopProcessWithinTimeout(process: ManagedProcess): Promise<void> {
    try {
      await withTimeout(
        process.stop("SIGTERM"),
        this.#cleanupTimeoutMs,
        `stopping ${process.name} with SIGTERM`,
      );
      return;
    } catch (error) {
      if (!isTimeoutError(error)) {
        throw error;
      }
    }

    await withTimeout(
      process.stop("SIGKILL"),
      this.#cleanupTimeoutMs,
      `stopping ${process.name} with SIGKILL`,
    );
  }

  #throwIfAborted(context: DesktopDriverContext): void {
    if (!context.signal.aborted && this.#now() < context.deadlineMs) {
      return;
    }

    if (context.signal.aborted) {
      throw toError(context.signal.reason);
    }

    throw new Error(`${context.scenario.id} exceeded its deadline`);
  }
}

function navigationButtonXPath(label: string): string {
  const literal = xpathLiteral(label);
  return `//aside[@aria-label="主导航"]//button[@aria-label=${literal} or normalize-space(.)=${literal} or .//*[normalize-space(.)=${literal}]]`;
}

async function findChatTextarea(webdriver: WebDriverLike): Promise<string> {
  return await findElementWithFallback(webdriver, [
    { using: "css selector", value: CHAT_TEXTAREA_SELECTOR },
    { using: "xpath", value: CHAT_TEXTAREA_XPATH },
  ]);
}

async function findElementWithFallback(
  webdriver: WebDriverLike,
  candidates: ReadonlyArray<{ using: string; value: string }>,
): Promise<string> {
  let lastError: unknown = null;

  for (const candidate of candidates) {
    try {
      return await webdriver.findElement(candidate.using, candidate.value);
    } catch (error) {
      lastError = error;
    }
  }

  throw toError(lastError);
}

function xpathLiteral(value: string): string {
  if (!value.includes('"')) {
    return `"${value}"`;
  }

  if (!value.includes("'")) {
    return `'${value}'`;
  }

  const parts = value.split('"');
  return `concat(${parts.map((part, index) => {
    const literal = `"${part}"`;
    return index === parts.length - 1 ? literal : `${literal}, '"', `;
  }).join("")})`;
}

function resolveWebDriverPort(webdriverUrl: string): number {
  const parsed = new URL(webdriverUrl);
  return parsed.port ? Number(parsed.port) : 4444;
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(error === undefined ? "Unknown error" : String(error));
}

function formatEarlyExitError(process: ManagedProcess, exitCode: number): string {
  return `${process.name} exited before WebDriver session was ready with exit code ${exitCode}. Logs: stdout=${process.stdoutLogPath} stderr=${process.stderrLogPath}`;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function isNonRetryableError(error: unknown): boolean {
  return error instanceof Error && error.name === "ProcessExitError";
}

function createProcessExitError(process: ManagedProcess, exitCode: number): Error {
  const error = new Error(formatEarlyExitError(process, exitCode));
  error.name = "ProcessExitError";
  return error;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          const error = new Error(`Timed out after ${timeoutMs}ms while ${label}`);
          error.name = "TimeoutError";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
  }
}

function trackProcessExit(process: ManagedProcess): ProcessExitState {
  const state: ProcessExitState = {
    process,
    settled: false,
    result: null,
    observedExit: Promise.resolve({ exitCode: 0 }),
  };

  state.observedExit = process.exit.then((result) => {
    state.settled = true;
    state.result = result;
    return result;
  });

  return state;
}

async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw toError(signal.reason);
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(toError(signal.reason));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
