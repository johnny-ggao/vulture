# Harness Engineering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a desktop product E2E harness lane while preserving the existing gateway acceptance, UI smoke, CI, tags, JUnit, and failure-report behavior.

**Architecture:** Keep the current fast lanes intact, then add a separate desktop E2E lane that launches the real Tauri shell against isolated profile/workspace data. The first implementation uses a small Bun runner plus WebDriver/Tauri-driver style protocol boundaries, with artifacts under `.artifacts/desktop-e2e`.

**Tech Stack:** Bun, TypeScript, Rust/Tauri, cargo tests, gateway in-process acceptance runner, happy-dom UI smoke, GitHub Actions artifacts.

---

## File Structure

- Modify `apps/desktop-shell/src/main.rs`
  - Add test-safe root resolution from `VULTURE_DESKTOP_ROOT`.
  - Keep production default unchanged.
- Modify `apps/desktop-shell/src/supervisor.rs`
  - Pass optional `VULTURE_DEFAULT_WORKSPACE` and deterministic harness env into the gateway process.
  - Keep existing default behavior when env vars are absent.
- Modify `apps/desktop-shell/src/state.rs`
  - Add or preserve tests proving custom roots isolate profile state.
- Create `apps/desktop-e2e/package.json`
  - New workspace package for desktop E2E scripts.
- Create `apps/desktop-e2e/src/artifacts.ts`
  - Owns artifact directory creation, summary/JUnit/failure report writing, log path helpers.
- Create `apps/desktop-e2e/src/processes.ts`
  - Owns spawning/stopping `cargo tauri dev` and optional driver process.
- Create `apps/desktop-e2e/src/webdriver.ts`
  - Minimal WebDriver client for session, element lookup, click, type, screenshot, page source.
- Create `apps/desktop-e2e/src/scenarios.ts`
  - Desktop scenario definitions and tags.
- Create `apps/desktop-e2e/src/runner.ts`
  - Scenario execution, step timing, error handling, screenshots/log capture.
- Create `apps/desktop-e2e/src/cli.ts`
  - CLI parsing for `--list`, `--scenario`, `--tag`, env overrides, keep-profile.
- Add tests under `apps/desktop-e2e/src/*.test.ts`
  - Unit tests for CLI parsing, scenario filtering, artifact writers, WebDriver request shape.
- Modify root `package.json`
  - Add `harness:desktop-e2e`.
  - Keep `harness:ci` stable and do not include desktop E2E by default.
- Modify `.github/workflows/harness.yml`
  - Keep default `harness:ci`.
  - Add optional `workflow_dispatch` desktop E2E job or a separate manual job.
- Modify `docs/harness/acceptance.md`
  - Document the new desktop E2E lane and artifacts.

## Task 1: Desktop Shell Test Root Override

**Files:**
- Modify: `apps/desktop-shell/src/main.rs`
- Test: `apps/desktop-shell/src/main.rs` unit tests or extracted helper tests in `apps/desktop-shell/src/lib.rs`

- [ ] **Step 1: Write the failing test for root override**

Add a pure helper test for the desktop root resolver. If `main.rs` cannot be unit-tested directly, move root resolution into `apps/desktop-shell/src/runtime.rs` as:

```rust
pub fn vulture_root_from_env(env: &impl Fn(&str) -> Option<std::ffi::OsString>) -> std::path::PathBuf {
    if let Some(value) = env("VULTURE_DESKTOP_ROOT") {
        return std::path::PathBuf::from(value);
    }
    let home = env("HOME").expect("HOME must be set");
    std::path::PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("Vulture")
}
```

Add tests:

```rust
#[test]
fn root_uses_vulture_desktop_root_when_set() {
    let root = vulture_root_from_env(&|key| match key {
        "VULTURE_DESKTOP_ROOT" => Some("/tmp/vulture-e2e-root".into()),
        "HOME" => Some("/Users/example".into()),
        _ => None,
    });
    assert_eq!(root, std::path::PathBuf::from("/tmp/vulture-e2e-root"));
}

#[test]
fn root_falls_back_to_application_support() {
    let root = vulture_root_from_env(&|key| match key {
        "HOME" => Some("/Users/example".into()),
        _ => None,
    });
    assert_eq!(
        root,
        std::path::PathBuf::from("/Users/example")
            .join("Library")
            .join("Application Support")
            .join("Vulture")
    );
}
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
cargo test -p vulture-desktop-shell root_
```

Expected: fail because the helper does not exist or root resolution ignores `VULTURE_DESKTOP_ROOT`.

- [ ] **Step 3: Implement the helper and use it in `main.rs`**

Replace the existing `vulture_root()` body with:

```rust
fn vulture_root() -> PathBuf {
    runtime::vulture_root_from_env(&|key| std::env::var_os(key))
}
```

If the helper lives in `runtime.rs`, ensure `main.rs` imports it through the existing `mod runtime;`.

- [ ] **Step 4: Verify the test passes**

Run:

```bash
cargo test -p vulture-desktop-shell root_
```

Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-shell/src/main.rs apps/desktop-shell/src/runtime.rs
git commit -m "test(shell): allow isolated desktop harness root"
```

## Task 2: Gateway Harness Env From Desktop Shell

**Files:**
- Modify: `apps/desktop-shell/src/supervisor.rs`
- Test: `apps/desktop-shell/src/supervisor.rs`

- [ ] **Step 1: Write the failing test for gateway env forwarding**

Add a test next to `spawn_does_not_export_default_workspace` that proves the harness can intentionally export a workspace:

```rust
#[tokio::test]
async fn spawn_exports_default_workspace_when_spec_sets_it() {
    use std::io::Write;

    let dir = tempdir();
    let workspace = dir.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let env_file = dir.join("default-workspace-env.txt");
    let entry = dir.join("fake-gateway-env.ts");
    std::fs::File::create(&entry)
        .unwrap()
        .write_all(
            format!(
                "await Bun.write('{}', process.env.VULTURE_DEFAULT_WORKSPACE ?? ''); console.log('READY 12345'); setTimeout(()=>{{}}, 60_000);",
                env_file.display()
            )
            .as_bytes(),
        )
        .unwrap();

    let spec = SpawnSpec {
        bun_bin: PathBuf::from("bun"),
        gateway_entry: entry,
        workdir: dir.clone(),
        gateway_port: 12345,
        shell_port: 12346,
        token: "x".repeat(43),
        shell_pid: std::process::id(),
        profile_dir: Arc::new(RwLock::new(dir.clone())),
        default_workspace: Some(workspace.clone()),
    };

    let mut running = spawn_gateway(&spec).await.expect("spawn ready");
    let value = std::fs::read_to_string(&env_file).unwrap();
    assert_eq!(value, workspace.display().to_string());
    signal_gateway_shutdown(&mut running.child).await;
    let _ = std::fs::remove_dir_all(dir);
}
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
cargo test -p vulture-desktop-shell spawn_exports_default_workspace_when_spec_sets_it
```

Expected: fail because `SpawnSpec` has no `default_workspace`.

- [ ] **Step 3: Add `default_workspace` to `SpawnSpec` and process env**

Update `SpawnSpec`:

```rust
pub struct SpawnSpec {
    pub bun_bin: PathBuf,
    pub gateway_entry: PathBuf,
    pub workdir: PathBuf,
    pub gateway_port: u16,
    pub shell_port: u16,
    pub token: String,
    pub shell_pid: u32,
    pub profile_dir: Arc<RwLock<PathBuf>>,
    pub default_workspace: Option<PathBuf>,
}
```

In `spawn_gateway`, after setting `VULTURE_PROFILE_DIR`:

```rust
if let Some(default_workspace) = &spec.default_workspace {
    cmd.env("VULTURE_DEFAULT_WORKSPACE", default_workspace);
}
cmd.env("VULTURE_MEMORY_SUGGESTIONS", "0");
```

Update every `SpawnSpec` construction in tests and `main.rs` with either `None` or the harness env value.

- [ ] **Step 4: Wire `main.rs` to env**

In `main.rs`, set:

```rust
let default_workspace = std::env::var_os("VULTURE_DESKTOP_DEFAULT_WORKSPACE").map(PathBuf::from);
```

Then pass `default_workspace` into `SpawnSpec`.

- [ ] **Step 5: Verify shell tests**

Run:

```bash
cargo test -p vulture-desktop-shell spawn_
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop-shell/src/main.rs apps/desktop-shell/src/supervisor.rs
git commit -m "feat(shell): pass harness workspace to gateway"
```

## Task 3: Desktop E2E Package Skeleton And Artifact Writers

**Files:**
- Create: `apps/desktop-e2e/package.json`
- Create: `apps/desktop-e2e/src/artifacts.ts`
- Create: `apps/desktop-e2e/src/artifacts.test.ts`
- Modify: root `package.json`

- [ ] **Step 1: Write artifact writer tests**

Create `apps/desktop-e2e/src/artifacts.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopArtifactRun, writeDesktopFailureReport, writeDesktopJUnit, writeDesktopSummary } from "./artifacts";

describe("desktop e2e artifacts", () => {
  test("creates per-run artifact directories", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-desktop-e2e-artifacts-"));
    try {
      const run = createDesktopArtifactRun(root, "launch-smoke", "fixed-run");
      expect(run.scenarioDir.endsWith("launch-smoke-fixed-run")).toBe(true);
      expect(run.screenshotsDir.endsWith("screenshots")).toBe(true);
      expect(run.logsDir.endsWith("logs")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writes summary, junit, and failure report", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-desktop-e2e-artifacts-"));
    try {
      const result = {
        id: "launch-smoke",
        name: "Launch smoke",
        status: "failed" as const,
        durationMs: 12,
        artifactPath: "/tmp/artifact",
        steps: [{ name: "waitForChatReady", status: "failed" as const, error: "chat not ready" }],
      };
      writeDesktopSummary(root, [result]);
      writeDesktopJUnit(root, [result]);
      writeDesktopFailureReport(root, [result]);
      expect(readFileSync(join(root, "summary.json"), "utf8")).toContain("launch-smoke");
      expect(readFileSync(join(root, "junit.xml"), "utf8")).toContain("chat not ready");
      expect(readFileSync(join(root, "failure-report.md"), "utf8")).toContain("waitForChatReady");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
bun test apps/desktop-e2e/src/artifacts.test.ts
```

Expected: fail because files do not exist.

- [ ] **Step 3: Create package and artifact implementation**

Create `apps/desktop-e2e/package.json`:

```json
{
  "name": "@vulture/desktop-e2e",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "test": "bun test src",
    "desktop-e2e": "bun src/cli.ts",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/bun": "^1.3.13",
    "typescript": "^5.8.0"
  }
}
```

Create `apps/desktop-e2e/src/artifacts.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DesktopStepResult {
  name: string;
  status: "passed" | "failed";
  error?: string;
}

export interface DesktopScenarioResult {
  id: string;
  name: string;
  status: "passed" | "failed";
  durationMs: number;
  artifactPath: string;
  steps: DesktopStepResult[];
}

export function createDesktopArtifactRun(root: string, scenarioId: string, runId = new Date().toISOString()) {
  const safeRunId = runId.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const scenarioDir = join(root, `${scenarioId}-${safeRunId}`);
  const screenshotsDir = join(scenarioDir, "screenshots");
  const logsDir = join(scenarioDir, "logs");
  mkdirSync(screenshotsDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  return { scenarioDir, screenshotsDir, logsDir };
}

export function writeDesktopSummary(root: string, results: readonly DesktopScenarioResult[]) {
  mkdirSync(root, { recursive: true });
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.length - passed;
  const path = join(root, "summary.json");
  writeFileSync(path, `${JSON.stringify({ total: results.length, passed, failed, results }, null, 2)}\n`);
  return path;
}

export function writeDesktopJUnit(root: string, results: readonly DesktopScenarioResult[]) {
  mkdirSync(root, { recursive: true });
  const failures = results.filter((result) => result.status === "failed").length;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="vulture.desktop-e2e" tests="${results.length}" failures="${failures}">`,
  ];
  for (const result of results) {
    lines.push(`  <testcase classname="vulture.desktop-e2e" name="${xml(result.name)}">`);
    const failed = result.steps.find((step) => step.status === "failed");
    if (failed) {
      const message = `${failed.name}: ${failed.error ?? "unknown"}`;
      lines.push(`    <failure message="${xml(message)}">${xml(message)}</failure>`);
    }
    lines.push(`    <system-out>${xml(result.artifactPath)}</system-out>`);
    lines.push("  </testcase>");
  }
  lines.push("</testsuite>");
  const path = join(root, "junit.xml");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

export function writeDesktopFailureReport(root: string, results: readonly DesktopScenarioResult[]) {
  const failed = results.filter((result) => result.status === "failed");
  if (failed.length === 0) return null;
  const lines = ["# Desktop E2E Failure Report", "", `Failed: ${failed.length}/${results.length}`, ""];
  for (const result of failed) {
    const failedStep = result.steps.find((step) => step.status === "failed");
    lines.push(`## ${result.id}`, "", `Name: ${result.name}`, `Artifacts: ${result.artifactPath}`);
    if (failedStep) {
      lines.push(`Failed step: ${failedStep.name}`, `Error: ${failedStep.error ?? "unknown"}`);
    }
    lines.push("");
  }
  const path = join(root, "failure-report.md");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
```

- [ ] **Step 4: Add root script**

In root `package.json`, add:

```json
"harness:desktop-e2e": "bun --filter @vulture/desktop-e2e desktop-e2e"
```

- [ ] **Step 5: Verify tests**

Run:

```bash
bun test apps/desktop-e2e/src/artifacts.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add package.json apps/desktop-e2e/package.json apps/desktop-e2e/src/artifacts.ts apps/desktop-e2e/src/artifacts.test.ts
git commit -m "feat(harness): add desktop e2e artifact package"
```

## Task 4: Desktop E2E CLI And Scenario Filtering

**Files:**
- Create: `apps/desktop-e2e/src/scenarios.ts`
- Create: `apps/desktop-e2e/src/cli.ts`
- Create: `apps/desktop-e2e/src/cli.test.ts`

- [ ] **Step 1: Write CLI tests**

Create `apps/desktop-e2e/src/cli.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseDesktopE2EArgs, selectDesktopScenarios } from "./cli";
import { desktopScenarios } from "./scenarios";

describe("desktop e2e cli", () => {
  test("parses list, scenario, and tag args", () => {
    expect(parseDesktopE2EArgs(["--list"])).toMatchObject({ list: true });
    expect(parseDesktopE2EArgs(["--scenario", "launch-smoke"]).scenarios).toEqual(["launch-smoke"]);
    expect(parseDesktopE2EArgs(["--tag", "smoke,recovery"]).tags).toEqual(["smoke", "recovery"]);
  });

  test("selects scenarios by id or tag", () => {
    expect(selectDesktopScenarios({ scenarios: ["launch-smoke"], tags: [] }, desktopScenarios).map((s) => s.id)).toEqual(["launch-smoke"]);
    expect(selectDesktopScenarios({ scenarios: [], tags: ["navigation"] }, desktopScenarios).map((s) => s.id)).toContain("navigation-smoke");
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
bun test apps/desktop-e2e/src/cli.test.ts
```

Expected: fail because CLI and scenarios do not exist.

- [ ] **Step 3: Implement scenario definitions**

Create `apps/desktop-e2e/src/scenarios.ts`:

```ts
export interface DesktopScenario {
  id: string;
  name: string;
  tags: string[];
  timeoutMs: number;
  steps: Array<
    | { action: "launchApp" }
    | { action: "waitForChatReady" }
    | { action: "sendMessage"; text: string }
    | { action: "expectMessage"; text: string }
    | { action: "openNavigation"; label: string }
    | { action: "captureScreenshot"; name: string }
  >;
}

export const desktopScenarios: DesktopScenario[] = [
  {
    id: "launch-smoke",
    name: "Launch smoke",
    tags: ["desktop", "smoke"],
    timeoutMs: 60_000,
    steps: [
      { action: "launchApp" },
      { action: "waitForChatReady" },
      { action: "captureScreenshot", name: "chat-ready" },
    ],
  },
  {
    id: "chat-send-smoke",
    name: "Chat send smoke",
    tags: ["desktop", "smoke", "chat"],
    timeoutMs: 90_000,
    steps: [
      { action: "launchApp" },
      { action: "waitForChatReady" },
      { action: "sendMessage", text: "desktop e2e hello" },
      { action: "expectMessage", text: "desktop e2e hello" },
      { action: "captureScreenshot", name: "chat-sent" },
    ],
  },
  {
    id: "navigation-smoke",
    name: "Navigation smoke",
    tags: ["desktop", "navigation"],
    timeoutMs: 90_000,
    steps: [
      { action: "launchApp" },
      { action: "waitForChatReady" },
      { action: "openNavigation", label: "设置" },
      { action: "openNavigation", label: "技能" },
      { action: "openNavigation", label: "智能体" },
      { action: "captureScreenshot", name: "navigation" },
    ],
  },
];
```

- [ ] **Step 4: Implement CLI parsing**

Create `apps/desktop-e2e/src/cli.ts`:

```ts
import { desktopScenarios, type DesktopScenario } from "./scenarios";

export interface DesktopE2EArgs {
  list: boolean;
  scenarios: string[];
  tags: string[];
}

export function parseDesktopE2EArgs(argv: readonly string[]): DesktopE2EArgs {
  const out: DesktopE2EArgs = {
    list: false,
    scenarios: list(process.env.VULTURE_DESKTOP_E2E_SCENARIOS ?? ""),
    tags: list(process.env.VULTURE_DESKTOP_E2E_TAGS ?? ""),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") {
      out.list = true;
    } else if (arg === "--scenario") {
      const value = argv[++i];
      if (!value) throw new Error("--scenario requires an id");
      out.scenarios.push(value);
    } else if (arg === "--tag") {
      const value = argv[++i];
      if (!value) throw new Error("--tag requires a value");
      out.tags.push(...list(value));
    } else if (arg.startsWith("--scenario=")) {
      out.scenarios.push(arg.slice("--scenario=".length));
    } else if (arg.startsWith("--tag=")) {
      out.tags.push(...list(arg.slice("--tag=".length)));
    } else {
      throw new Error(`Unknown argument ${arg}`);
    }
  }
  return out;
}

export function selectDesktopScenarios(
  input: Pick<DesktopE2EArgs, "scenarios" | "tags">,
  scenarios: readonly DesktopScenario[] = desktopScenarios,
): DesktopScenario[] {
  let selected = [...scenarios];
  if (input.tags.length > 0) {
    const tags = new Set(input.tags);
    selected = selected.filter((scenario) => scenario.tags.some((tag) => tags.has(tag)));
  }
  if (input.scenarios.length > 0) {
    selected = input.scenarios.map((id) => {
      const scenario = scenarios.find((item) => item.id === id);
      if (!scenario) throw new Error(`Unknown desktop E2E scenario ${id}`);
      return scenario;
    });
  }
  return selected;
}

function list(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

if (import.meta.main) {
  const args = parseDesktopE2EArgs(process.argv.slice(2));
  const selected = selectDesktopScenarios(args);
  if (args.list) {
    for (const scenario of selected) {
      console.log(`${scenario.id}\t${scenario.name}\t${scenario.tags.join(",")}`);
    }
  } else {
    console.error("Desktop E2E real driver is intentionally disabled until Task 7.");
    process.exitCode = 1;
  }
}
```

- [ ] **Step 5: Verify CLI tests and list command**

Run:

```bash
bun test apps/desktop-e2e/src/cli.test.ts
bun --filter @vulture/desktop-e2e desktop-e2e --list
```

Expected: tests pass and list prints the three scenarios.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop-e2e/src/scenarios.ts apps/desktop-e2e/src/cli.ts apps/desktop-e2e/src/cli.test.ts
git commit -m "feat(harness): define desktop e2e scenarios"
```

## Task 5: Process And WebDriver Infrastructure

**Files:**
- Create: `apps/desktop-e2e/src/processes.ts`
- Create: `apps/desktop-e2e/src/webdriver.ts`
- Create: `apps/desktop-e2e/src/webdriver.test.ts`

- [ ] **Step 1: Write WebDriver request tests**

Create `apps/desktop-e2e/src/webdriver.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { WebDriverClient } from "./webdriver";

describe("WebDriverClient", () => {
  test("creates sessions and sends element commands", async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    const client = new WebDriverClient("http://127.0.0.1:4444", async (input, init) => {
      const url = new URL(String(input));
      calls.push({
        path: url.pathname,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.pathname === "/session") {
        return Response.json({ value: { sessionId: "s1" } });
      }
      if (url.pathname === "/session/s1/element") {
        return Response.json({ value: { "element-6066-11e4-a52e-4f735466cecf": "e1" } });
      }
      return Response.json({ value: null });
    });

    await client.createSession();
    const element = await client.findElement("css selector", "button");
    await client.click(element);

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /session",
      "POST /session/s1/element",
      "POST /session/s1/element/e1/click",
    ]);
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
bun test apps/desktop-e2e/src/webdriver.test.ts
```

Expected: fail because `webdriver.ts` does not exist.

- [ ] **Step 3: Implement minimal WebDriver client**

Create `apps/desktop-e2e/src/webdriver.ts`:

```ts
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

export class WebDriverClient {
  private sessionId: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async createSession(): Promise<string> {
    const response = await this.request<{ sessionId?: string }>("/session", {
      capabilities: { alwaysMatch: {} },
    });
    const sessionId = response.sessionId;
    if (!sessionId) throw new Error("WebDriver session response missing sessionId");
    this.sessionId = sessionId;
    return sessionId;
  }

  async findElement(using: "css selector" | "xpath", value: string): Promise<string> {
    const response = await this.request<Record<string, string>>(this.sessionPath("/element"), { using, value });
    const element = response[ELEMENT_KEY];
    if (!element) throw new Error(`Element not found: ${using} ${value}`);
    return element;
  }

  async click(elementId: string): Promise<void> {
    await this.request(this.sessionPath(`/element/${elementId}/click`), {});
  }

  async type(elementId: string, text: string): Promise<void> {
    await this.request(this.sessionPath(`/element/${elementId}/value`), { text, value: [...text] });
  }

  async screenshot(): Promise<Buffer> {
    const value = await this.request<string>(this.sessionPath("/screenshot"), undefined, "GET");
    return Buffer.from(value, "base64");
  }

  async pageSource(): Promise<string> {
    return await this.request<string>(this.sessionPath("/source"), undefined, "GET");
  }

  async deleteSession(): Promise<void> {
    if (!this.sessionId) return;
    await this.request(`/session/${this.sessionId}`, undefined, "DELETE");
    this.sessionId = null;
  }

  private sessionPath(path: string): string {
    if (!this.sessionId) throw new Error("WebDriver session has not been created");
    return `/session/${this.sessionId}${path}`;
  }

  private async request<T>(path: string, body?: unknown, method = "POST"): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({})) as { value?: T; message?: string };
    if (!response.ok) throw new Error(payload.message ?? `WebDriver HTTP ${response.status} ${path}`);
    return payload.value as T;
  }
}
```

- [ ] **Step 4: Implement process helpers**

Create `apps/desktop-e2e/src/processes.ts`:

```ts
import { spawn, type Subprocess } from "bun";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ManagedProcess {
  process: Subprocess;
  stop(): Promise<void>;
}

export function startProcess(name: string, command: string[], cwd: string, env: Record<string, string>, logsDir: string): ManagedProcess {
  mkdirSync(logsDir, { recursive: true });
  const stdoutPath = join(logsDir, `${name}.stdout.log`);
  const stderrPath = join(logsDir, `${name}.stderr.log`);
  const child = spawn(command, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  void pipeToFile(child.stdout, stdoutPath);
  void pipeToFile(child.stderr, stderrPath);
  return {
    process: child,
    async stop() {
      child.kill();
      await child.exited.catch(() => undefined);
    },
  };
}

async function pipeToFile(stream: ReadableStream<Uint8Array> | null, path: string): Promise<void> {
  if (!stream) {
    writeFileSync(path, "");
    return;
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  writeFileSync(path, Buffer.concat(chunks));
}
```

- [ ] **Step 5: Verify WebDriver tests**

Run:

```bash
bun test apps/desktop-e2e/src/webdriver.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop-e2e/src/processes.ts apps/desktop-e2e/src/webdriver.ts apps/desktop-e2e/src/webdriver.test.ts
git commit -m "feat(harness): add desktop e2e process and webdriver helpers"
```

## Task 6: Desktop E2E Runner

**Files:**
- Create: `apps/desktop-e2e/src/runner.ts`
- Modify: `apps/desktop-e2e/src/cli.ts`
- Test: `apps/desktop-e2e/src/runner.test.ts`

- [ ] **Step 1: Write runner unit test with fake step driver**

Create `apps/desktop-e2e/src/runner.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDesktopScenario } from "./runner";

describe("desktop e2e runner", () => {
  test("records passed and failed steps with artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-desktop-runner-"));
    try {
      const result = await runDesktopScenario({
        artifactRoot: root,
        repoRoot: process.cwd(),
        scenario: {
          id: "fake",
          name: "Fake",
          tags: ["desktop"],
          timeoutMs: 1000,
          steps: [
            { action: "launchApp" },
            { action: "expectMessage", text: "ok" },
          ],
        },
        driver: {
          launchApp: async () => undefined,
          waitForChatReady: async () => undefined,
          sendMessage: async () => undefined,
          expectMessage: async () => undefined,
          openNavigation: async () => undefined,
          captureScreenshot: async () => undefined,
          shutdown: async () => undefined,
        },
      });
      expect(result.status).toBe("passed");
      expect(result.steps.map((step) => step.status)).toEqual(["passed", "passed"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
bun test apps/desktop-e2e/src/runner.test.ts
```

Expected: fail because runner does not exist.

- [ ] **Step 3: Implement runner interfaces and fakeable execution**

Create `apps/desktop-e2e/src/runner.ts`:

```ts
import { writeFileSync } from "node:fs";
import { createDesktopArtifactRun, type DesktopScenarioResult, type DesktopStepResult } from "./artifacts";
import type { DesktopScenario } from "./scenarios";

export interface DesktopDriver {
  launchApp(): Promise<void>;
  waitForChatReady(): Promise<void>;
  sendMessage(text: string): Promise<void>;
  expectMessage(text: string): Promise<void>;
  openNavigation(label: string): Promise<void>;
  captureScreenshot(name: string): Promise<void>;
  shutdown(): Promise<void>;
}

export interface RunDesktopScenarioOptions {
  artifactRoot: string;
  repoRoot: string;
  scenario: DesktopScenario;
  driver: DesktopDriver;
}

export async function runDesktopScenario(options: RunDesktopScenarioOptions): Promise<DesktopScenarioResult> {
  const started = Date.now();
  const artifact = createDesktopArtifactRun(options.artifactRoot, options.scenario.id);
  const steps: DesktopStepResult[] = [];
  let status: DesktopScenarioResult["status"] = "passed";
  try {
    for (const step of options.scenario.steps) {
      try {
        if (step.action === "launchApp") await options.driver.launchApp();
        if (step.action === "waitForChatReady") await options.driver.waitForChatReady();
        if (step.action === "sendMessage") await options.driver.sendMessage(step.text);
        if (step.action === "expectMessage") await options.driver.expectMessage(step.text);
        if (step.action === "openNavigation") await options.driver.openNavigation(step.label);
        if (step.action === "captureScreenshot") await options.driver.captureScreenshot(step.name);
        steps.push({ name: step.action, status: "passed" });
      } catch (cause) {
        status = "failed";
        steps.push({ name: step.action, status: "failed", error: cause instanceof Error ? cause.message : String(cause) });
        break;
      }
    }
  } finally {
    await options.driver.shutdown().catch(() => undefined);
  }
  const result: DesktopScenarioResult = {
    id: options.scenario.id,
    name: options.scenario.name,
    status,
    durationMs: Date.now() - started,
    artifactPath: artifact.scenarioDir,
    steps,
  };
  writeFileSync(`${artifact.scenarioDir}/summary.json`, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
```

- [ ] **Step 4: Wire CLI to runner with an explicit driver placeholder**

In `cli.ts`, replace the "wired in next task" branch with a call to runner only after a real driver exists. For this task, keep runtime protected:

```ts
console.error("Desktop E2E real driver is wired in Task 7.");
process.exitCode = 1;
```

This preserves CLI tests while making the boundary explicit.

- [ ] **Step 5: Verify runner tests**

Run:

```bash
bun test apps/desktop-e2e/src/runner.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop-e2e/src/runner.ts apps/desktop-e2e/src/runner.test.ts apps/desktop-e2e/src/cli.ts
git commit -m "feat(harness): add desktop e2e scenario runner"
```

## Task 7: Real Desktop Driver And Launch Smoke

**Files:**
- Create: `apps/desktop-e2e/src/desktopDriver.ts`
- Modify: `apps/desktop-e2e/src/cli.ts`
- Modify: `docs/harness/acceptance.md`

- [ ] **Step 1: Add driver implementation**

Create `apps/desktop-e2e/src/desktopDriver.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startProcess, type ManagedProcess } from "./processes";
import { WebDriverClient } from "./webdriver";
import type { DesktopDriver } from "./runner";

export interface DesktopDriverOptions {
  repoRoot: string;
  artifactPath: string;
  screenshotsDir: string;
  logsDir: string;
  rootDir: string;
  workspaceDir: string;
  webdriverUrl: string;
}

export class RealDesktopDriver implements DesktopDriver {
  private app: ManagedProcess | null = null;
  private driver: ManagedProcess | null = null;
  private readonly webdriver: WebDriverClient;

  constructor(private readonly options: DesktopDriverOptions) {
    this.webdriver = new WebDriverClient(options.webdriverUrl);
  }

  async launchApp(): Promise<void> {
    mkdirSync(this.options.rootDir, { recursive: true });
    mkdirSync(this.options.workspaceDir, { recursive: true });
    this.driver = startProcess("tauri-driver", ["tauri-driver", "--port", "4444"], this.options.repoRoot, {}, this.options.logsDir);
    this.app = startProcess("tauri", ["cargo", "tauri", "dev"], join(this.options.repoRoot, "apps/desktop-shell"), {
      VULTURE_DESKTOP_ROOT: this.options.rootDir,
      VULTURE_DESKTOP_DEFAULT_WORKSPACE: this.options.workspaceDir,
      VULTURE_MEMORY_SUGGESTIONS: "0",
    }, this.options.logsDir);
    await wait(5000);
    await this.webdriver.createSession();
  }

  async waitForChatReady(): Promise<void> {
    await this.retry(async () => {
      await this.webdriver.findElement("css selector", "textarea");
    }, 30_000);
  }

  async sendMessage(text: string): Promise<void> {
    const textarea = await this.webdriver.findElement("css selector", "textarea");
    await this.webdriver.type(textarea, text);
    const send = await this.webdriver.findElement("xpath", "//*[contains(@aria-label,'发送') or text()='发送']");
    await this.webdriver.click(send);
  }

  async expectMessage(text: string): Promise<void> {
    await this.retry(async () => {
      const source = await this.webdriver.pageSource();
      if (!source.includes(text)) throw new Error(`message not found: ${text}`);
    }, 30_000);
  }

  async openNavigation(label: string): Promise<void> {
    const button = await this.webdriver.findElement("xpath", `//*[text()='${label}' or @aria-label='${label}']`);
    await this.webdriver.click(button);
  }

  async captureScreenshot(name: string): Promise<void> {
    const shot = await this.webdriver.screenshot();
    writeFileSync(join(this.options.screenshotsDir, `${name}.png`), shot);
    const source = await this.webdriver.pageSource().catch(() => "");
    writeFileSync(join(this.options.artifactPath, "dom.html"), source);
  }

  async shutdown(): Promise<void> {
    await this.webdriver.deleteSession().catch(() => undefined);
    await this.app?.stop();
    await this.driver?.stop();
  }

  private async retry(fn: () => Promise<void>, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      try {
        await fn();
        return;
      } catch (cause) {
        last = cause;
        await wait(500);
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 2: Wire CLI to real driver**

In `cli.ts`, when not `--list`:

```ts
import { resolve, join } from "node:path";
import { mkdirSync } from "node:fs";
import { createDesktopArtifactRun, writeDesktopFailureReport, writeDesktopJUnit, writeDesktopSummary } from "./artifacts";
import { RealDesktopDriver } from "./desktopDriver";
import { runDesktopScenario } from "./runner";
```

Then run selected scenarios:

```ts
const artifactRoot = resolve(process.env.VULTURE_DESKTOP_E2E_ARTIFACT_DIR ?? ".artifacts/desktop-e2e");
mkdirSync(artifactRoot, { recursive: true });
const results = [];
for (const scenario of selected) {
  const preview = createDesktopArtifactRun(artifactRoot, scenario.id);
  const driver = new RealDesktopDriver({
    repoRoot: resolve("../.."),
    artifactPath: preview.scenarioDir,
    screenshotsDir: preview.screenshotsDir,
    logsDir: preview.logsDir,
    rootDir: join(preview.scenarioDir, "root"),
    workspaceDir: join(preview.scenarioDir, "workspace"),
    webdriverUrl: process.env.VULTURE_DESKTOP_E2E_WEBDRIVER_URL ?? "http://127.0.0.1:4444",
  });
  results.push(await runDesktopScenario({ artifactRoot, repoRoot: resolve("../.."), scenario, driver }));
}
writeDesktopSummary(artifactRoot, results);
writeDesktopJUnit(artifactRoot, results);
writeDesktopFailureReport(artifactRoot, results);
process.exitCode = results.every((result) => result.status === "passed") ? 0 : 1;
```

Adjust `runDesktopScenario` to accept a precreated artifact directory or move artifact creation entirely into the CLI so screenshots and summary share the same directory. Keep one owner for artifact directory creation.

- [ ] **Step 3: Document prerequisites**

In `docs/harness/acceptance.md`, add:

```markdown
## Desktop E2E

Run:

```bash
bun run harness:desktop-e2e -- --list
bun run harness:desktop-e2e -- --scenario launch-smoke
```

Prerequisites:

- Tauri CLI available for `cargo tauri dev`.
- `tauri-driver` available on PATH.

Desktop E2E uses temporary `VULTURE_DESKTOP_ROOT` and
`VULTURE_DESKTOP_DEFAULT_WORKSPACE` paths under `.artifacts/desktop-e2e`.
It does not use real OpenAI credentials by default.
```

- [ ] **Step 4: Run local launch smoke**

Run:

```bash
bun run harness:desktop-e2e -- --scenario launch-smoke
```

Expected: scenario passes and writes `.artifacts/desktop-e2e/summary.json`, `junit.xml`, screenshots, and logs.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-e2e/src/desktopDriver.ts apps/desktop-e2e/src/cli.ts docs/harness/acceptance.md
git commit -m "feat(harness): run desktop e2e launch smoke"
```

## Task 8: Navigation And Chat Desktop Scenarios

**Files:**
- Modify: `apps/desktop-e2e/src/scenarios.ts`
- Modify: `apps/desktop-e2e/src/desktopDriver.ts`
- Modify: `docs/harness/acceptance.md`

- [ ] **Step 1: Run existing selected scenarios to identify selector gaps**

Run:

```bash
bun run harness:desktop-e2e -- --scenario navigation-smoke
bun run harness:desktop-e2e -- --scenario chat-send-smoke
```

Expected: at least one may fail initially due real UI selectors or stub timing.

- [ ] **Step 2: Harden selectors without adding test-only UI text**

Update `RealDesktopDriver` to prefer stable accessibility selectors:

```ts
async openNavigation(label: string): Promise<void> {
  const element = await this.webdriver.findElement(
    "xpath",
    `//*[@aria-label='主导航']//*[text()='${label}' or @aria-label='${label}']`,
  );
  await this.webdriver.click(element);
}
```

For send:

```ts
const textarea = await this.webdriver.findElement("css selector", "textarea[placeholder*='输入问题']");
const send = await this.webdriver.findElement("xpath", "//*[@aria-label='发送']");
```

- [ ] **Step 3: Re-run scenarios**

Run:

```bash
bun run harness:desktop-e2e -- --scenario navigation-smoke
bun run harness:desktop-e2e -- --scenario chat-send-smoke
```

Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop-e2e/src/scenarios.ts apps/desktop-e2e/src/desktopDriver.ts docs/harness/acceptance.md
git commit -m "test(harness): cover desktop navigation and chat smoke"
```

## Task 9: Manual Workflow Dispatch For Desktop E2E

**Files:**
- Modify: `.github/workflows/harness.yml`
- Modify: `docs/harness/acceptance.md`

- [ ] **Step 1: Add workflow dispatch input**

Modify `.github/workflows/harness.yml`:

```yaml
on:
  pull_request:
  push:
    branches:
      - main
  workflow_dispatch:
    inputs:
      runDesktopE2E:
        description: Run desktop E2E lane
        required: false
        default: "false"
```

- [ ] **Step 2: Add optional desktop job**

Add:

```yaml
  desktop-e2e:
    if: github.event_name == 'workflow_dispatch' && inputs.runDesktopE2E == 'true'
    runs-on: macos-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - name: Install dependencies
        run: bun install
      - name: Install Tauri driver
        run: cargo install tauri-driver --locked
      - name: Run desktop E2E
        run: bun run harness:desktop-e2e -- --tag smoke
      - name: Upload desktop E2E artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: desktop-e2e-artifacts
          path: .artifacts/desktop-e2e
          if-no-files-found: ignore
```

- [ ] **Step 3: Validate YAML**

Run:

```bash
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/harness.yml"); puts "workflow yaml ok"'
```

Expected: `workflow yaml ok`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/harness.yml docs/harness/acceptance.md
git commit -m "ci(harness): add manual desktop e2e workflow"
```

## Task 10: Final Verification

**Files:**
- All changed files.

- [ ] **Step 1: Run fast harness CI**

Run:

```bash
bun run harness:ci
```

Expected: pass.

- [ ] **Step 2: Run desktop E2E smoke locally**

Run:

```bash
bun run harness:desktop-e2e -- --tag smoke
```

Expected: launch and chat smoke scenarios pass, with artifacts under `.artifacts/desktop-e2e`.

- [ ] **Step 3: Run Rust shell tests**

Run:

```bash
cargo test -p vulture-desktop-shell
```

Expected: pass.

- [ ] **Step 4: Inspect artifacts**

Run:

```bash
test -f .artifacts/desktop-e2e/summary.json
test -f .artifacts/desktop-e2e/junit.xml
find .artifacts/desktop-e2e -path '*screenshots/*.png' -print | head
```

Expected: summary and JUnit exist, at least one screenshot is printed.

- [ ] **Step 5: Commit final docs or fixes**

```bash
git status --short
git add docs/harness/acceptance.md package.json apps/desktop-e2e apps/desktop-shell .github/workflows/harness.yml
git commit -m "test(harness): add desktop product e2e lane"
```

## Self-Review

Spec coverage:

- Four lanes: covered by package scripts, docs, and workflow tasks.
- Desktop E2E isolated root/workspace: covered by Tasks 1, 2, and 7.
- Stub/default deterministic behavior: covered by Tasks 2 and 7.
- Artifacts summary/JUnit/failure/screenshots/logs: covered by Tasks 3, 7, and 10.
- Desktop scenarios launch/chat/navigation: covered by Tasks 4, 7, and 8.
- CI strategy: covered by Tasks 3, 9, and 10.

Known implementation risk:

- Tauri-driver/WebDriver behavior may require environment-specific selector or launch tweaks. The plan contains a fallback-ready split: Task 7 first establishes launch smoke, Task 8 hardens real UI scenarios after observing actual selector behavior.
