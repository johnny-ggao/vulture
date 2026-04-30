import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startProcess } from "./processes";

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.VULTURE_DESKTOP_E2E_PARENT;
  delete process.env.VULTURE_DESKTOP_E2E_CHILD;

  while (tempDirs.length > 0) {
    const path = tempDirs.pop();
    if (path) {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

describe("startProcess", () => {
  test("captures stdout and stderr logs and resolves exit", async () => {
    const root = makeTempDir();
    const logsDir = join(root, "logs");

    const managed = startProcess({
      name: "driver",
      cwd: root,
      logsDir,
      argv: [
        "bun",
        "-e",
        'console.log("stdout-ready"); console.error("stderr-ready");',
      ],
    });

    await expect(managed.exit).resolves.toEqual({ exitCode: 0 });
    expect(readFileSync(managed.stdoutLogPath, "utf8")).toContain("stdout-ready");
    expect(readFileSync(managed.stderrLogPath, "utf8")).toContain("stderr-ready");
  });

  test("applies env overrides and unsets inherited values", async () => {
    const root = makeTempDir();
    const logsDir = join(root, "logs");
    process.env.VULTURE_DESKTOP_E2E_PARENT = "parent-value";

    const managed = startProcess({
      name: "env-check",
      cwd: root,
      logsDir,
      env: {
        VULTURE_DESKTOP_E2E_PARENT: undefined,
        VULTURE_DESKTOP_E2E_CHILD: "child-value",
      },
      argv: [
        "bun",
        "-e",
        'console.log(JSON.stringify({ parent: process.env.VULTURE_DESKTOP_E2E_PARENT ?? null, child: process.env.VULTURE_DESKTOP_E2E_CHILD ?? null }));',
      ],
    });

    await managed.exit;

    expect(readFileSync(managed.stdoutLogPath, "utf8").trim()).toBe(
      JSON.stringify({
        parent: null,
        child: "child-value",
      }),
    );
  });

  test("sanitizes process names before deriving log paths", async () => {
    const root = makeTempDir();
    const logsDir = join(root, "logs");

    const managed = startProcess({
      name: "../nested/../../escape name",
      cwd: root,
      logsDir,
      argv: ["bun", "-e", ""],
    });

    await managed.exit;

    expect(managed.name).toBe("..-nested-..-..-escape-name");
    expect(managed.stdoutLogPath.startsWith(logsDir)).toBe(true);
    expect(managed.stderrLogPath.startsWith(logsDir)).toBe(true);
    expect(managed.stdoutLogPath).toBe(join(logsDir, "..-nested-..-..-escape-name.stdout.log"));
    expect(managed.stderrLogPath).toBe(join(logsDir, "..-nested-..-..-escape-name.stderr.log"));
  });

  test("stop kills the process and returns the settled exit result", async () => {
    const root = makeTempDir();
    const logsDir = join(root, "logs");

    const managed = startProcess({
      name: "long-running",
      cwd: root,
      logsDir,
      argv: [
        "bun",
        "-e",
        'console.log("started"); setInterval(() => console.log("tick"), 100);',
      ],
    });

    await Bun.sleep(150);

    const stopped = await managed.stop();
    expect(stopped.exitCode).not.toBe(0);
    await expect(managed.exit).resolves.toEqual(stopped);
  });
});

function makeTempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "vulture-desktop-processes-"));
  tempDirs.push(path);
  return path;
}
