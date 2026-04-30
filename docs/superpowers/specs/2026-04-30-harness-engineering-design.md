# Harness Engineering Design

Date: 2026-04-30

## Goal

Vulture needs a stable harness strategy that catches regressions across the
desktop product path without turning daily development into slow or flaky test
runs. The chosen scope is a layered harness with a new desktop product E2E lane.
Daily automation stays deterministic by default and uses stub LLM behavior;
real OpenAI and real external MCP smoke tests remain explicit manual or future
nightly lanes.

## Current State

The project now has these harness pieces in progress:

- Gateway acceptance runner with JSON scenario support, tags, JUnit output,
  failure reports, and replayable artifacts.
- UI smoke harness using React integration tests under happy-dom.
- Root `harness:ci` command that runs gateway harness tests, typechecks,
  gateway acceptance, and UI smoke.
- GitHub Actions workflow that runs `harness:ci` and uploads acceptance
  artifacts.

The remaining gap is product-level confidence. Gateway tests prove the protocol
works; happy-dom tests prove selected React behavior works; neither proves the
real Tauri shell, runtime descriptor, gateway startup, window UI, profile paths,
and browser automation path work together.

## Architecture

The harness is split into four lanes.

### Lane 1: Gateway Acceptance

Command: `bun run harness:acceptance`

Purpose: verify gateway protocol behavior in-process. This lane owns API
contracts, run lifecycle, SSE replay, recovery, attachments, idempotency, MCP
configuration, and deterministic stub LLM runs.

It remains the fastest product-level backend signal and is safe for every PR.

### Lane 2: UI Smoke

Command: `bun run harness:ui-smoke`

Purpose: verify high-value React workflows without a real desktop shell. This
lane owns UI state regressions such as active run restore, tool block
persistence, and assistant message rendering.

It remains fast and deterministic, but it is not allowed to claim desktop app
coverage.

### Lane 3: Desktop E2E

Command: `bun run harness:desktop-e2e`

Purpose: verify the real desktop product path. This lane launches the Tauri app
with an isolated profile/workspace, drives the real window, and validates user
visible outcomes.

This lane should use stub LLM behavior by default. It must not require an
OpenAI API key, ChatGPT OAuth, real external MCP servers, or the user's real
`~/.vuture` data.

Initial desktop E2E scenarios:

- Launch app and reach the main chat UI.
- Send a message and observe user plus assistant messages.
- Trigger or seed a completed tool block and verify it remains visible after
  the assistant message is persisted.
- Switch away from a conversation and back, verifying messages remain.
- Restart the app and verify active conversation/run restoration.
- Upload a small text attachment and verify it is shown on the user message.
- Open Settings, Skills, and Agents pages and verify they render without route
  errors.

### Lane 4: CI Bundle

Command: `bun run harness:ci`

Purpose: provide one command for routine validation.

Default PR CI should run lanes 1 and 2 plus typechecks. Desktop E2E should begin
as a separate manual/local workflow until its runtime is stable enough for PR
gating. The CI design should keep a clean path to promote desktop E2E into PR
or scheduled runs later.

## Desktop E2E Runner

The desktop E2E runner should be a small harness package/script, not a large
test framework embedded in application code.

Responsibilities:

- Create a temporary harness root under `.artifacts/desktop-e2e/<run-id>/`.
- Set environment variables so the Tauri app uses temporary profile and
  workspace paths.
- Force deterministic stub LLM behavior.
- Start the desktop app.
- Drive the UI through a browser/window automation tool.
- Capture screenshots, logs, console output, and a final summary.
- Clean temporary runtime state unless `VULTURE_DESKTOP_E2E_KEEP_PROFILE=1`.

Tooling choice should be pragmatic:

- Prefer a tool that can automate the actual Tauri webview/window on macOS.
- If full webview automation is too fragile initially, start with a desktop E2E
  smoke that launches Tauri and verifies runtime/gateway readiness, while UI
  interaction remains in the happy-dom lane. This is an explicit stepping stone,
  not the final state.

## Data And Artifacts

All harness outputs should live under `.artifacts/`.

Proposed structure:

```text
.artifacts/
  acceptance/
    summary.json
    junit.xml
    failure-report.md
    <scenario-id>-<timestamp>/
      summary.json
      events.jsonl
      transcript.md
  desktop-e2e/
    summary.json
    junit.xml
    failure-report.md
    <scenario-id>-<timestamp>/
      summary.json
      screenshots/
      logs/
      dom.html
```

Desktop E2E failures must preserve enough evidence for debugging without
rerunning locally: screenshot, app logs, gateway logs, scenario step results,
and the last known UI/DOM snapshot where available.

## Scenario Model

Gateway acceptance already has a structured step DSL. Desktop E2E should use a
separate scenario model instead of stretching gateway steps to cover UI
automation.

Minimum desktop scenario metadata:

- `id`
- `name`
- `tags`
- `timeoutMs`
- ordered steps

Minimum tags:

- `desktop`
- `smoke`
- `recovery`
- `attachments`
- `tools`
- `navigation`

Desktop steps should be user-level, not implementation-level. Examples:

- `launchApp`
- `waitForChatReady`
- `sendMessage`
- `expectMessage`
- `uploadAttachment`
- `openNavigation`
- `restartApp`
- `expectToolBlock`
- `captureScreenshot`

## Error Handling

Harness failures should be actionable:

- A failed assertion must include the scenario id, step name, expected value,
  actual value, and artifact path.
- Startup failures must include app process logs and whether gateway health was
  reachable.
- Timeouts must record the last successful step and capture a screenshot/logs
  before teardown.
- Cleanup failures must not hide the original test failure.

## CI Strategy

Initial CI split:

- `harness:ci`: gateway harness tests, gateway typecheck, desktop-ui typecheck,
  gateway acceptance, UI smoke.
- `harness:desktop-e2e`: local/manual command, plus optional GitHub workflow
  dispatch.

Promotion path:

1. Local-only desktop E2E until the runner is reliable.
2. Manual GitHub workflow dispatch with artifact upload.
3. Scheduled run if it is stable.
4. PR gating only if runtime and timing flake rate are low.

## Acceptance Criteria

The harness engineering phase is complete when:

- `bun run harness:ci` remains green.
- `bun run harness:desktop-e2e` exists and runs at least the launch, send
  message, navigation, and restore smoke scenarios.
- Desktop E2E uses temporary profile/workspace data by default.
- Desktop E2E does not require real OpenAI credentials.
- Desktop E2E writes summary, JUnit, failure report, logs, and screenshots.
- Documentation explains when to run each harness lane and how to inspect
  artifacts.
- Existing gateway acceptance and UI smoke behavior remains unchanged.

## Non-Goals

- Do not add real OpenAI or ChatGPT OAuth to routine CI.
- Do not require real external MCP servers in PR checks.
- Do not replace gateway acceptance with desktop E2E; they catch different
  classes of failures.
- Do not use the user's real profile or workspace data in automated harnesses.

## Open Implementation Questions

- Which automation tool is most reliable for Tauri webview interaction on the
  current macOS development environment?
- Should desktop E2E start as a separate package or stay under
  `apps/desktop-ui/src/harness`?
- Can the desktop shell expose a test-only runtime descriptor or env override
  for profile/workspace paths without weakening production behavior?
