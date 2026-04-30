import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { startProcess, type ManagedProcess, type StartProcessOptions } from "./processes";
import type { DesktopDriver, DesktopDriverContext } from "./runner";
import { WebDriverClient } from "./webdriver";

const POLL_INTERVAL_MS = 250;
const CHAT_TEXTAREA_SELECTOR = "textarea";
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
}

export class RealDesktopDriver implements DesktopDriver {
  readonly #startProcess;
  readonly #webdriver;
  readonly #now;
  readonly #sleep;
  readonly #options;
  #app: ManagedProcess | null = null;
  #driver: ManagedProcess | null = null;
  #shutdownPromise: Promise<void> | null = null;

  constructor(options: RealDesktopDriverOptions, dependencies: RealDesktopDriverDependencies = {}) {
    this.#options = options;
    this.#startProcess = dependencies.startProcess ?? startProcess;
    this.#webdriver = (dependencies.createWebDriver ?? ((baseUrl) => new WebDriverClient(baseUrl)))(options.webdriverUrl);
    this.#now = dependencies.now ?? Date.now;
    this.#sleep = dependencies.sleep ?? sleepWithAbort;
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

    await this.#retry(context, () => this.#webdriver.createSession({ browserName: "wry" }));
  }

  async waitForChatReady(context: DesktopDriverContext): Promise<void> {
    await this.#retry(context, () => this.#webdriver.findElement("css selector", CHAT_TEXTAREA_SELECTOR));
  }

  async sendMessage(
    step: Extract<DesktopDriverContext["scenario"]["steps"][number], { action: "sendMessage" }>,
    context: DesktopDriverContext,
  ): Promise<void> {
    this.#throwIfAborted(context);

    const textarea = await this.#webdriver.findElement("css selector", CHAT_TEXTAREA_SELECTOR);
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
        await this.#webdriver.deleteSession();
      } catch (error) {
        errors.push(toError(error));
      }

      const app = this.#app;
      this.#app = null;
      if (app) {
        try {
          await app.stop();
        } catch (error) {
          errors.push(toError(error));
        }
      }

      const driver = this.#driver;
      this.#driver = null;
      if (driver) {
        try {
          await driver.stop();
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
  return `//button[@aria-label=${literal} or normalize-space(.)=${literal} or .//*[normalize-space(.)=${literal}]]`;
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
