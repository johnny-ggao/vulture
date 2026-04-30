import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RealDesktopDriver } from "./desktopDriver";
import type { DesktopDriverContext } from "./runner";
import type { DesktopScenario } from "./scenarios";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("RealDesktopDriver", () => {
  test("launchApp creates isolated directories, starts processes, and creates a WebDriver session", async () => {
    const repoRoot = makeTempDir();
    const scenarioDir = makeTempDir();
    const processCalls: Array<{ name: string; argv: string[]; cwd: string; env?: Record<string, string | undefined> }> = [];
    const webdriver = new FakeWebDriver();

    const driver = new RealDesktopDriver(
      { repoRoot, webdriverUrl: "http://127.0.0.1:4555" },
      {
        startProcess: (options) => {
          processCalls.push({
            name: options.name,
            argv: [...options.argv],
            cwd: options.cwd,
            env: options.env,
          });
          return createManagedProcess(options.name);
        },
        createWebDriver: () => webdriver,
      },
    );

    await driver.launchApp(createContext(scenarioDir));

    expect(existsSync(join(scenarioDir, "root"))).toBe(true);
    expect(existsSync(join(scenarioDir, "workspace"))).toBe(true);
    expect(processCalls).toEqual([
      {
        name: "tauri-driver",
        argv: ["tauri-driver", "--port", "4555"],
        cwd: repoRoot,
        env: undefined,
      },
      {
        name: "cargo-tauri-dev",
        argv: ["cargo", "tauri", "dev"],
        cwd: join(repoRoot, "apps", "desktop-shell"),
        env: {
          VULTURE_DESKTOP_ROOT: join(scenarioDir, "root"),
          VULTURE_DESKTOP_DEFAULT_WORKSPACE: join(scenarioDir, "workspace"),
          VULTURE_MEMORY_SUGGESTIONS: "0",
        },
      },
    ]);
    expect(webdriver.createSessionCalls).toEqual([{ browserName: "wry" }]);
  });

  test("waitForChatReady retries until the textarea appears", async () => {
    const repoRoot = makeTempDir();
    const webdriver = new FakeWebDriver();
    webdriver.findElementResponses.set('css selector:textarea[placeholder*="输入问题"]', [
      new Error("missing"),
      new Error("still missing"),
      "textarea-id",
    ]);
    let nowMs = 0;

    const driver = new RealDesktopDriver(
      { repoRoot, webdriverUrl: "http://127.0.0.1:4444" },
      {
        startProcess: (options) => createManagedProcess(options.name),
        createWebDriver: () => webdriver,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
      },
    );

    await driver.waitForChatReady(createContext(makeTempDir(), { deadlineMs: 5_000 }));

    expect(webdriver.findElementCalls).toEqual([
      { using: "css selector", value: 'textarea[placeholder*="输入问题"]' },
      { using: "xpath", value: '//textarea[contains(@placeholder, "输入问题") or contains(@aria-label, "输入问题")]' },
      { using: "css selector", value: 'textarea[placeholder*="输入问题"]' },
      { using: "xpath", value: '//textarea[contains(@placeholder, "输入问题") or contains(@aria-label, "输入问题")]' },
      { using: "css selector", value: 'textarea[placeholder*="输入问题"]' },
    ]);
  });

  test("waitForChatReady falls back to the textarea XPath when the placeholder CSS selector misses", async () => {
    const repoRoot = makeTempDir();
    const webdriver = new FakeWebDriver();
    webdriver.findElementResponses.set('css selector:textarea[placeholder*="输入问题"]', [new Error("css missing")]);
    webdriver.findElementResponses.set(
      'xpath://textarea[contains(@placeholder, "输入问题") or contains(@aria-label, "输入问题")]',
      ["textarea-id"],
    );

    const driver = new RealDesktopDriver(
      { repoRoot, webdriverUrl: "http://127.0.0.1:4444" },
      {
        startProcess: (options) => createManagedProcess(options.name),
        createWebDriver: () => webdriver,
      },
    );

    await driver.waitForChatReady(createContext(makeTempDir(), { deadlineMs: Date.now() + 5_000 }));

    expect(webdriver.findElementCalls).toEqual([
      { using: "css selector", value: 'textarea[placeholder*="输入问题"]' },
      { using: "xpath", value: '//textarea[contains(@placeholder, "输入问题") or contains(@aria-label, "输入问题")]' },
    ]);
  });

  test("sendMessage clicks the send button, expectMessage checks DOM content, and openNavigation matches localized labels", async () => {
    const repoRoot = makeTempDir();
    const webdriver = new FakeWebDriver();
    webdriver.findElementResponses.set('css selector:textarea[placeholder*="输入问题"]', ["textarea-id"]);
    webdriver.findElementResponses.set(
      `xpath://button[@aria-label="发送" or normalize-space(.)="发送"]`,
      ["send-id"],
    );
    webdriver.findElementResponses.set(
      `xpath://aside[@aria-label="主导航"]//button[@aria-label="设置" or normalize-space(.)="设置" or .//*[normalize-space(.)="设置"]]`,
      ["settings-id"],
    );
    webdriver.findElementResponses.set(
      `xpath://aside[@aria-label="主导航"]//button[@aria-label="技能" or normalize-space(.)="技能" or .//*[normalize-space(.)="技能"]]`,
      ["skills-id"],
    );
    webdriver.findElementResponses.set(
      `xpath://aside[@aria-label="主导航"]//button[@aria-label="智能体" or normalize-space(.)="智能体" or .//*[normalize-space(.)="智能体"]]`,
      ["agents-id"],
    );
    webdriver.pageSourceResponses = ["<html>nothing yet</html>", "<html>desktop e2e hello</html>"];
    let nowMs = 0;

    const driver = new RealDesktopDriver(
      { repoRoot, webdriverUrl: "http://127.0.0.1:4444" },
      {
        startProcess: (options) => createManagedProcess(options.name),
        createWebDriver: () => webdriver,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        },
      },
    );
    const context = createContext(makeTempDir(), { deadlineMs: 5_000 });

    await driver.sendMessage({ action: "sendMessage", text: "desktop e2e hello" }, context);
    await driver.expectMessage({ action: "expectMessage", text: "desktop e2e hello" }, context);
    await driver.openNavigation({ action: "openNavigation", label: "设置" }, context);
    await driver.openNavigation({ action: "openNavigation", label: "技能" }, context);
    await driver.openNavigation({ action: "openNavigation", label: "智能体" }, context);

    expect(webdriver.typeCalls).toEqual([{ elementId: "textarea-id", text: "desktop e2e hello" }]);
    expect(webdriver.clickCalls).toEqual(["send-id", "settings-id", "skills-id", "agents-id"]);
    expect(webdriver.findElementCalls).toContainEqual({
      using: "xpath",
      value: '//aside[@aria-label="主导航"]//button[@aria-label="技能" or normalize-space(.)="技能" or .//*[normalize-space(.)="技能"]]',
    });
    expect(webdriver.findElementCalls).toContainEqual({
      using: "xpath",
      value: '//aside[@aria-label="主导航"]//button[@aria-label="智能体" or normalize-space(.)="智能体" or .//*[normalize-space(.)="智能体"]]',
    });
  });

  test("captureScreenshot writes the PNG and DOM snapshot", async () => {
    const repoRoot = makeTempDir();
    const scenarioDir = makeTempDir();
    const webdriver = new FakeWebDriver();
    webdriver.screenshotValue = Buffer.from("png-bytes");
    webdriver.pageSourceResponses = ["<html>dom snapshot</html>"];

    const driver = new RealDesktopDriver(
      { repoRoot, webdriverUrl: "http://127.0.0.1:4444" },
      {
        startProcess: (options) => createManagedProcess(options.name),
        createWebDriver: () => webdriver,
      },
    );
    const context = createContext(scenarioDir);

    await driver.captureScreenshot({ action: "captureScreenshot", name: "chat-ready" }, context);

    expect(readFileSync(join(context.artifacts.screenshotsDir, "chat-ready.png"))).toEqual(Buffer.from("png-bytes"));
    expect(readFileSync(join(context.artifacts.scenarioDir, "dom.html"), "utf8")).toBe("<html>dom snapshot</html>");
  });

  test("shutdown deletes the session and stops processes exactly once", async () => {
    const repoRoot = makeTempDir();
    const scenarioDir = makeTempDir();
    const webdriver = new FakeWebDriver();
    const processes = [new FakeManagedProcess("tauri-driver"), new FakeManagedProcess("cargo-tauri-dev")];

    const driver = new RealDesktopDriver(
      { repoRoot, webdriverUrl: "http://127.0.0.1:4444" },
      {
        startProcess: () => {
          const process = processes.shift();
          if (!process) {
            throw new Error("Unexpected extra process start");
          }
          return process;
        },
        createWebDriver: () => webdriver,
      },
    );
    const context = createContext(scenarioDir);

    await driver.launchApp(context);
    await driver.shutdown(context);
    await driver.shutdown(context);

    expect(webdriver.deleteSessionCalls).toBe(1);
    expect(processes).toHaveLength(0);
  });

  test("launchApp fails fast when tauri-driver exits before the WebDriver session is ready", async () => {
    const repoRoot = makeTempDir();
    const scenarioDir = makeTempDir();
    const webdriver = new FakeWebDriver();
    let resolveDriverExit: ((result: { exitCode: number }) => void) | null = null;
    const driverProcess = new FakeManagedProcess("tauri-driver", {
      stdoutLogPath: "/tmp/tauri-driver.stdout.log",
      stderrLogPath: "/tmp/tauri-driver.stderr.log",
      exit: new Promise((resolve) => {
        resolveDriverExit = resolve;
      }),
    });
    const appProcess = new FakeManagedProcess("cargo-tauri-dev");
    const processes = [driverProcess, appProcess];
    webdriver.createSessionResponses = [new Error("not ready yet")];
    let nowMs = 0;

    const driver = new RealDesktopDriver(
      { repoRoot, webdriverUrl: "http://127.0.0.1:4444" },
      {
        startProcess: () => {
          const next = processes.shift();
          if (!next) {
            throw new Error("missing process");
          }
          return next;
        },
        createWebDriver: () => webdriver,
        now: () => nowMs,
        sleep: async (ms) => {
          resolveDriverExit?.({ exitCode: 23 });
          resolveDriverExit = null;
          await Promise.resolve();
          nowMs += ms;
        },
      },
    );

    await expect(driver.launchApp(createContext(scenarioDir, { deadlineMs: 5_000 }))).rejects.toThrow(
      'tauri-driver exited before WebDriver session was ready with exit code 23. Logs: stdout=/tmp/tauri-driver.stdout.log stderr=/tmp/tauri-driver.stderr.log',
    );
  });

  test("shutdown bounds deleteSession and stop waits, escalating process stops before failing", async () => {
    const repoRoot = makeTempDir();
    const scenarioDir = makeTempDir();
    const webdriver = new FakeWebDriver();
    const driverProcess = new FakeManagedProcess("tauri-driver", {
      stopResults: {
        SIGTERM: neverResolve(),
        SIGKILL: neverResolve(),
      },
    });
    const appProcess = new FakeManagedProcess("cargo-tauri-dev", {
      stopResults: {
        SIGTERM: neverResolve(),
        SIGKILL: neverResolve(),
      },
    });
    const processes = [driverProcess, appProcess];
    webdriver.deleteSessionResult = neverResolve();

    const driver = new RealDesktopDriver(
      { repoRoot, webdriverUrl: "http://127.0.0.1:4444" },
      {
        startProcess: () => {
          const next = processes.shift();
          if (!next) {
            throw new Error("missing process");
          }
          return next;
        },
        createWebDriver: () => webdriver,
        cleanupTimeoutMs: 5,
      },
    );
    const context = createContext(scenarioDir);

    await driver.launchApp(context);

    const startedAt = Date.now();
    await expect(driver.shutdown(context)).rejects.toThrow(
      "Timed out after 5ms while deleting WebDriver session",
    );
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(driverProcess.stopSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(appProcess.stopSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

function createContext(
  scenarioDir: string,
  options: { deadlineMs?: number; signal?: AbortSignal } = {},
): DesktopDriverContext {
  const screenshotsDir = join(scenarioDir, "screenshots");
  const logsDir = join(scenarioDir, "logs");
  const controller = new AbortController();

  return {
    scenario: {
      id: "launch-smoke",
      name: "Launch smoke",
      tags: ["desktop"],
      timeoutMs: 10_000,
      steps: [],
    } satisfies DesktopScenario,
    artifacts: {
      scenarioDir,
      screenshotsDir,
      logsDir,
    },
    signal: options.signal ?? controller.signal,
    deadlineMs: options.deadlineMs ?? Date.now() + 10_000,
  };
}

function makeTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "vulture-desktop-driver-"));
  tempDirs.push(path);
  return path;
}

function neverResolve<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function createManagedProcess(name: string): FakeManagedProcess {
  return new FakeManagedProcess(name);
}

interface FakeManagedProcessOptions {
  exit?: Promise<{ exitCode: number }>;
  stdoutLogPath?: string;
  stderrLogPath?: string;
  stopResults?: Partial<Record<NodeJS.Signals, Promise<{ exitCode: number }>>>;
}

class FakeManagedProcess {
  readonly name: string;
  readonly pid = 123;
  readonly stdoutLogPath: string;
  readonly stderrLogPath: string;
  readonly exit: Promise<{ exitCode: number }>;
  readonly stopSignals: NodeJS.Signals[] = [];
  readonly #stopResults: Partial<Record<NodeJS.Signals, Promise<{ exitCode: number }>>>;

  constructor(name: string, options: FakeManagedProcessOptions = {}) {
    this.name = name;
    this.stdoutLogPath = options.stdoutLogPath ?? `/tmp/${name}.stdout.log`;
    this.stderrLogPath = options.stderrLogPath ?? `/tmp/${name}.stderr.log`;
    this.exit = options.exit ?? neverResolve();
    this.#stopResults = options.stopResults ?? {};
  }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<{ exitCode: number }> {
    this.stopSignals.push(signal);
    return await (this.#stopResults[signal] ?? Promise.resolve({ exitCode: 0 }));
  }
}

class FakeWebDriver {
  readonly createSessionCalls: Record<string, unknown>[] = [];
  readonly findElementCalls: Array<{ using: string; value: string }> = [];
  readonly clickCalls: string[] = [];
  readonly typeCalls: Array<{ elementId: string; text: string }> = [];
  readonly findElementResponses = new Map<string, Array<string | Error>>();
  createSessionResponses: Array<string | Error> = [];
  pageSourceResponses: Array<string | Error> = [];
  screenshotValue = Buffer.from("");
  deleteSessionResult: Promise<void> = Promise.resolve();
  deleteSessionCalls = 0;

  async createSession(alwaysMatch: Record<string, unknown>): Promise<string> {
    this.createSessionCalls.push(alwaysMatch);
    const next = this.createSessionResponses.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next ?? "session-1";
  }

  async findElement(using: string, value: string): Promise<string> {
    this.findElementCalls.push({ using, value });
    const key = `${using}:${value}`;
    const queue = this.findElementResponses.get(key);
    const next = queue?.shift();
    if (!next) {
      throw new Error(`Unexpected findElement ${key}`);
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }

  async click(elementId: string): Promise<void> {
    this.clickCalls.push(elementId);
  }

  async type(elementId: string, text: string): Promise<void> {
    this.typeCalls.push({ elementId, text });
  }

  async screenshot(): Promise<Buffer> {
    return this.screenshotValue;
  }

  async pageSource(): Promise<string> {
    const next = this.pageSourceResponses.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next ?? "";
  }

  async deleteSession(): Promise<void> {
    this.deleteSessionCalls += 1;
    await this.deleteSessionResult;
  }
}
