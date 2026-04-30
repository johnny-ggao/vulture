import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, parseDesktopE2EArgs, selectDesktopScenarios } from "./cli";
import type { DesktopDriver } from "./runner";
import { desktopScenarios } from "./scenarios";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("desktop e2e cli", () => {
  test("parses list and separated scenario/tag args", () => {
    expect(
      parseDesktopE2EArgs(["--list", "--scenario", "launch-smoke", "--tag", "smoke,recovery"]),
    ).toEqual({
      list: true,
      scenarios: ["launch-smoke"],
      tags: ["smoke", "recovery"],
    });
  });

  test("parses equals syntax for scenario and tag args", () => {
    expect(parseDesktopE2EArgs(["--scenario=chat-send-smoke", "--tag=desktop,navigation"])).toEqual({
      list: false,
      scenarios: ["chat-send-smoke"],
      tags: ["desktop", "navigation"],
    });
  });

  test("rejects empty tag values from separated and equals syntax", () => {
    expect(() => parseDesktopE2EArgs(["--tag", " , "])).toThrow("--tag requires a value");
    expect(() => parseDesktopE2EArgs(["--tag="])).toThrow("--tag requires a value");
  });

  test("rejects separated tag values when the next token is another flag", () => {
    expect(() => parseDesktopE2EArgs(["--tag", "--list"])).toThrow("--tag requires a value");
    expect(() => parseDesktopE2EArgs(["--tag", "--scenario"])).toThrow("--tag requires a value");
  });

  test("uses environment defaults for scenarios and tags", () => {
    expect(
      parseDesktopE2EArgs([], {
        VULTURE_DESKTOP_E2E_SCENARIOS: "launch-smoke, chat-send-smoke",
        VULTURE_DESKTOP_E2E_TAGS: "desktop, smoke",
      }),
    ).toEqual({
      list: false,
      scenarios: ["launch-smoke", "chat-send-smoke"],
      tags: ["desktop", "smoke"],
    });
  });

  test("selects scenarios by exact id", () => {
    expect(
      selectDesktopScenarios({ scenarios: ["chat-send-smoke", "launch-smoke"], tags: [] }, desktopScenarios).map(
        (scenario) => scenario.id,
      ),
    ).toEqual(["chat-send-smoke", "launch-smoke"]);
  });

  test("dedupes explicit scenarios while preserving first-seen order", () => {
    expect(
      selectDesktopScenarios(
        { scenarios: ["launch-smoke", "chat-send-smoke", "launch-smoke", "chat-send-smoke"], tags: [] },
        desktopScenarios,
      ).map((scenario) => scenario.id),
    ).toEqual(["launch-smoke", "chat-send-smoke"]);
  });

  test("selects scenarios by tag when no explicit scenario ids are provided", () => {
    expect(
      selectDesktopScenarios({ scenarios: [], tags: ["navigation"] }, desktopScenarios).map((scenario) => scenario.id),
    ).toEqual(["navigation-smoke"]);
  });

  test("explicit scenario ids override tag filtering", () => {
    expect(
      selectDesktopScenarios({ scenarios: ["launch-smoke"], tags: ["navigation"] }, desktopScenarios).map(
        (scenario) => scenario.id,
      ),
    ).toEqual(["launch-smoke"]);
  });

  test("throws when tag filters match no scenarios", () => {
    expect(() => selectDesktopScenarios({ scenarios: [], tags: ["missing-tag"] }, desktopScenarios)).toThrow(
      'No desktop E2E scenarios match tags: missing-tag',
    );
  });

  test("throws for unknown scenario ids", () => {
    expect(() =>
      selectDesktopScenarios({ scenarios: ["missing-scenario"], tags: [] }, desktopScenarios),
    ).toThrow("Unknown desktop E2E scenario missing-scenario");
  });

  test("rejects separated scenario ids when the next token is missing or another flag", () => {
    expect(() => parseDesktopE2EArgs(["--scenario", "   "])).toThrow("--scenario requires an id");
    expect(() => parseDesktopE2EArgs(["--scenario", "--list"])).toThrow("--scenario requires an id");
    expect(() => parseDesktopE2EArgs(["--scenario", "--tag"])).toThrow("--scenario requires an id");
  });

  test("lists selected scenarios with id name and tags", async () => {
    const lines: string[] = [];

    const exitCode = await main(["--list", "--tag", "smoke"], {
      write: (message) => {
        lines.push(message);
      },
      writeError: () => {
        throw new Error("did not expect stderr output");
      },
    });

    expect(exitCode).toBe(0);
    expect(lines).toEqual([
      "launch-smoke\tLaunch smoke\tdesktop,smoke",
      "chat-send-smoke\tChat send smoke\tdesktop,smoke,chat",
    ]);
  });

  test("runs selected scenarios, writes suite artifacts, and returns 0 when all scenarios pass", async () => {
    const cwd = makeTempDir();
    const artifactRoot = join(cwd, "custom-artifacts");
    const writes: string[] = [];
    const createdDrivers: Array<{ repoRoot: string; webdriverUrl: string }> = [];
    const runCalls: string[] = [];
    const fakeDriver = createFakeDriver("fake-driver");

    const exitCode = await main(["--scenario", "launch-smoke"], {
      env: {
        VULTURE_DESKTOP_E2E_ARTIFACT_DIR: artifactRoot,
        VULTURE_DESKTOP_E2E_WEBDRIVER_URL: "http://127.0.0.1:4555",
      },
      cwd,
      write: (message) => {
        writes.push(message);
      },
      writeError: (message) => {
        throw new Error(`did not expect stderr output: ${message}`);
      },
    }, {
      createDriver: ({ repoRoot, webdriverUrl }) => {
        createdDrivers.push({ repoRoot, webdriverUrl });
        return fakeDriver;
      },
      runScenario: async ({ artifactRoot: root, driver, scenario }) => {
        runCalls.push(`${scenario.id}:${(driver as FakeDriver).kind}:${root}`);
        return {
          id: scenario.id,
          name: scenario.name,
          status: "passed",
          durationMs: 123,
          artifactPath: join(root, `${scenario.id}-artifacts`),
          steps: [{ name: "1. launchApp", status: "passed" }],
        };
      },
    });

    expect(exitCode).toBe(0);
    expect(createdDrivers).toEqual([{ repoRoot: cwd, webdriverUrl: "http://127.0.0.1:4555" }]);
    expect(runCalls).toEqual([`launch-smoke:fake-driver:${artifactRoot}`]);
    expect(writes).toEqual([
      `PASS launch-smoke (${join(artifactRoot, "launch-smoke-artifacts")})`,
      `Desktop E2E summary: ${join(artifactRoot, "summary.json")}`,
      `Desktop E2E JUnit: ${join(artifactRoot, "junit.xml")}`,
    ]);
    expect(existsSync(join(artifactRoot, "summary.json"))).toBe(true);
    expect(existsSync(join(artifactRoot, "junit.xml"))).toBe(true);
    expect(existsSync(join(artifactRoot, "failure-report.md"))).toBe(false);

    const summary = JSON.parse(readFileSync(join(artifactRoot, "summary.json"), "utf8"));
    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(0);
  });

  test("writes failure artifacts and returns 1 when any selected scenario fails", async () => {
    const cwd = makeTempDir();
    const errors: string[] = [];
    const writes: string[] = [];
    const fakeDriver = createFakeDriver("failed-driver");

    const exitCode = await main(["--scenario", "launch-smoke"], {
      cwd,
      write: (message) => {
        writes.push(message);
      },
      writeError: (message) => {
        errors.push(message);
      },
    }, {
      createDriver: () => fakeDriver,
      runScenario: async ({ artifactRoot, scenario }) => ({
        id: scenario.id,
        name: scenario.name,
        status: "failed",
        durationMs: 456,
        artifactPath: join(artifactRoot, `${scenario.id}-artifacts`),
        steps: [{ name: "1. launchApp", status: "failed", error: "driver missing" }],
      }),
    });

    const artifactRoot = join(cwd, ".artifacts", "desktop-e2e");
    expect(exitCode).toBe(1);
    expect(writes).toContain(`FAIL launch-smoke (${join(artifactRoot, "launch-smoke-artifacts")})`);
    expect(errors).toEqual([`Desktop E2E failure report: ${join(artifactRoot, "failure-report.md")}`]);
    expect(existsSync(join(artifactRoot, "summary.json"))).toBe(true);
    expect(existsSync(join(artifactRoot, "junit.xml"))).toBe(true);
    expect(existsSync(join(artifactRoot, "failure-report.md"))).toBe(true);
    expect(readFileSync(join(artifactRoot, "failure-report.md"), "utf8")).toContain("driver missing");
  });

  test("resolves the workspace repo root when the CLI runs from a nested package cwd", async () => {
    const repoRoot = makeTempDir();
    const packageCwd = join(repoRoot, "apps", "desktop-e2e");
    const calls: Array<{ repoRoot: string; webdriverUrl: string }> = [];

    writeFileSync(join(repoRoot, "package.json"), JSON.stringify({ name: "repo", workspaces: ["apps/*"] }));
    mkdirSync(packageCwd, { recursive: true });

    const exitCode = await main(["--scenario", "launch-smoke"], {
      cwd: packageCwd,
      writeError: (message) => {
        throw new Error(`did not expect stderr output: ${message}`);
      },
    }, {
      createDriver: ({ repoRoot: resolvedRoot, webdriverUrl }) => {
        calls.push({ repoRoot: resolvedRoot, webdriverUrl });
        return createFakeDriver("nested-driver");
      },
      runScenario: async ({ artifactRoot, scenario }) => ({
        id: scenario.id,
        name: scenario.name,
        status: "passed",
        durationMs: 1,
        artifactPath: join(artifactRoot, `${scenario.id}-artifacts`),
        steps: [{ name: "1. launchApp", status: "passed" }],
      }),
    });

    expect(exitCode).toBe(0);
    expect(calls).toEqual([{ repoRoot, webdriverUrl: "http://127.0.0.1:4444" }]);
    expect(existsSync(join(repoRoot, ".artifacts", "desktop-e2e", "summary.json"))).toBe(true);
  });

  test("returns exit code 1 for execution errors", async () => {
    const errors: string[] = [];

    const exitCode = await main(["--scenario", "launch-smoke"], {
      write: () => {
        throw new Error("did not expect stdout output");
      },
      writeError: (message) => {
        errors.push(message);
      },
    }, {
      createDriver: () => createFakeDriver("exploding-driver"),
      runScenario: async () => {
        throw new Error("runner exploded");
      },
    });

    expect(exitCode).toBe(1);
    expect(errors).toEqual(["runner exploded"]);
  });
});

function makeTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "vulture-desktop-cli-"));
  tempDirs.push(path);
  return path;
}

type FakeDriver = DesktopDriver & { kind: string };

function createFakeDriver(kind: string): FakeDriver {
  return {
    kind,
    async launchApp() {},
    async waitForChatReady() {},
    async sendMessage() {},
    async expectMessage() {},
    async openNavigation() {},
    async captureScreenshot() {},
    async shutdown() {},
  };
}
