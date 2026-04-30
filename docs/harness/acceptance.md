# Acceptance Harness

The acceptance harness runs product-level gateway scenarios and writes artifacts
that can be kept with a bug report or regression investigation.

## Run

```bash
bun run harness:acceptance
```

List available scenarios:

```bash
bun run harness:acceptance --list
```

Run selected scenarios:

```bash
bun run harness:acceptance --scenario run-cancel-active
VULTURE_ACCEPTANCE_SCENARIOS=conversation-happy-path,attachment-content-fetch bun run harness:acceptance
```

Run scenarios by tag:

```bash
bun run harness:acceptance --tag recovery
VULTURE_ACCEPTANCE_TAGS=attachments,mcp bun run harness:acceptance
```

Run a file-backed scenario:

```bash
bun run harness:acceptance --scenario-file apps/gateway/src/harness/scenarios/json-conversation-happy-path.json
```

Run the agent runtime harness:

```bash
bun run harness:runtime
bun run harness:runtime -- --list
bun run harness:runtime -- --scenario tool-success-checkpoint
bun run harness:runtime -- --tag recovery
```

Run the tool contract harness:

```bash
bun run harness:tools
bun run harness:tools -- --list
bun run harness:tools -- --tool read
bun run harness:tools -- --category sessions
```

Run the UI smoke harness:

```bash
bun run harness:ui-smoke
```

Run the desktop E2E harness:

```bash
bun run harness:desktop-e2e -- --list
bun run harness:desktop-e2e -- --scenario launch-smoke
bun run harness:desktop-e2e -- --scenario navigation-smoke
bun run harness:desktop-e2e -- --scenario chat-send-smoke
```

Run the CI harness bundle:

```bash
bun run harness:ci
```

By default the harness uses the gateway's stub LLM path so it stays
deterministic and does not spend API tokens. Set `VULTURE_ACCEPTANCE_REAL_LLM=1`
only when intentionally running a live model smoke.

Temporary profile and workspace directories are isolated per harness process by
default, so multiple selected CLI runs can execute without sharing SQLite state.

## Agent Runtime Harness

The agent runtime harness is an in-process lane for deterministic runtime
protocol checks. It drives scripted LLM yields through `runConversation` and
asserts the runtime emits the expected event stream, tool lifecycle, usage, and
checkpoint behavior without calling a real model, shell, MCP server, or network.

Runtime harness artifacts default to `.artifacts/runtime-harness/` and can be
moved with `VULTURE_RUNTIME_HARNESS_ARTIFACT_DIR`. The lane writes:

- `summary.json` - aggregate scenario status.
- `events.jsonl` - ordered runtime events by scenario.
- `failure-report.md` - present only when a scenario expectation fails.

Useful environment variables:

- `VULTURE_RUNTIME_HARNESS_ARTIFACT_DIR`: output directory.
- `VULTURE_RUNTIME_HARNESS_SCENARIOS`: comma-separated scenario ids.
- `VULTURE_RUNTIME_HARNESS_TAGS`: comma-separated tag names.
- `VULTURE_RUNTIME_HARNESS_WORKSPACE_DIR`: workspace path passed into runtime calls.

Current runtime scenarios:

- `text-stream-usage`: verifies text deltas, token usage, and final output.
- `tool-success-checkpoint`: verifies tool plan/start/complete plus active-tool checkpoint metadata.
- `tool-failure`: verifies failed tool execution produces `tool.failed` and `run.failed`.
- `recovery-input`: verifies recovery input reaches the LLM callable.

## Tool Contract Harness

The tool contract harness scans the real `createCoreToolRegistry()` output and
validates every core tool has an explicit contract fixture. For each tool it
checks identity metadata, Zod parameter validation, category/risk/idempotency,
approval behavior, and OpenAI Agents SDK adapter invocation semantics. This is
the gate that prevents new tools from being added without explicit retry and
approval contracts.

Tool contract artifacts default to `.artifacts/tool-contract-harness/` and can
be moved with `VULTURE_TOOL_CONTRACT_ARTIFACT_DIR`. The lane writes:

- `summary.json` - aggregate tool status.
- `results.json` - per-tool check results.
- `failure-report.md` - present only when one or more contracts fail.

Useful environment variables:

- `VULTURE_TOOL_CONTRACT_ARTIFACT_DIR`: output directory.
- `VULTURE_TOOL_CONTRACT_TOOLS`: comma-separated tool ids.
- `VULTURE_TOOL_CONTRACT_CATEGORIES`: comma-separated categories.
- `VULTURE_TOOL_CONTRACT_WORKSPACE_DIR`: workspace path used for approval checks.

## Artifacts

Each scenario writes a folder under `.artifacts/acceptance/`:

- `summary.json` - scenario status, step results, and resource ids.
- `events.jsonl` - ordered harness observations for replay/debugging.
- `transcript.md` - human-readable scenario transcript.

The suite also writes `.artifacts/acceptance/summary.json` with all scenario
results and artifact paths.

The CLI also writes `.artifacts/acceptance/junit.xml` on every run so CI can
surface acceptance results as machine-readable test cases.

When one or more scenarios fail, the CLI also writes
`.artifacts/acceptance/failure-report.md`. This file is intended for CI artifact
upload and gives the failed scenario id, failed step, error, and scenario
artifact path.

GitHub Actions runs the same bundle through
[.github/workflows/harness.yml](/Users/johnny/Work/vulture/.github/workflows/harness.yml)
and uploads `.artifacts/acceptance` on every run.

Manual GitHub Actions runs can also execute the desktop E2E smoke lane without
changing the default PR/push CI path:

1. Open the `Harness` workflow in GitHub Actions.
2. Select `Run workflow`.
3. Set `runDesktopE2E` to `true`.
4. Start the run to execute `bun run harness:desktop-e2e -- --tag smoke` on
   `ubuntu-latest` through `xvfb-run`.
   The workflow installs Tauri CLI, `tauri-driver`, `webkit2gtk-driver`, Xvfb,
   and the standard Tauri v2 Linux build dependencies before launching the
   smoke lane.

When `runDesktopE2E` stays `false`, the manual run behaves like the default CI
path and only runs the `harness` job.

## Desktop E2E

Desktop E2E launches the real Tauri shell through `cargo tauri dev` and drives
the UI through `tauri-driver` + WebDriver. Each selected scenario gets its own
isolated desktop root and default workspace under the scenario artifact
directory, so local SQLite/profile state is not shared across runs.
The lane also forces the gateway onto the stub LLM path by removing inherited
`OPENAI_API_KEY` and disabling Codex credential import for the launched shell.

The GitHub Actions desktop E2E lane targets Linux because current Tauri desktop
WebDriver support is limited to Windows and Linux. Local macOS runs still
require Tauri CLI plus locally installed driver tooling to be available on
`PATH`.

Prerequisites:

- Tauri CLI available for `cargo tauri dev`.
- `tauri-driver` available on `PATH`.
- A local desktop development environment that can launch the Tauri shell.

If `tauri-driver` is missing, the selected scenario fails during `launchApp`.
The harness still writes `.artifacts/desktop-e2e/failure-report.md`,
`summary.json`, and per-scenario log directories so the environment failure can
be attached to a bug report or CI artifact bundle.

Desktop E2E artifacts default to `.artifacts/desktop-e2e/` and can be moved
with `VULTURE_DESKTOP_E2E_ARTIFACT_DIR`. Each scenario artifact directory
contains:

- `summary.json` - per-scenario status and step results.
- `dom.html` - present when a capture step runs; stores the most recent DOM snapshot captured by the desktop driver.
- `screenshots/` - present when capture steps run; stores PNG screenshots captured by scenario steps.
- `logs/` - stdout/stderr logs for `tauri-driver` and `cargo tauri dev`.

The suite root also writes:

- `summary.json` - aggregate desktop E2E results.
- `junit.xml` - machine-readable test results for CI surfaces.
- `failure-report.md` - present only when one or more scenarios fail; removed
  on a later all-green run.

Useful environment variables:

- `VULTURE_DESKTOP_E2E_ARTIFACT_DIR`: output directory for suite + scenario artifacts.
- `VULTURE_DESKTOP_E2E_SCENARIOS`: comma-separated scenario ids.
- `VULTURE_DESKTOP_E2E_TAGS`: comma-separated tags. Tag selection uses OR semantics.
- `VULTURE_DESKTOP_E2E_WEBDRIVER_URL`: WebDriver server URL. Defaults to `http://127.0.0.1:4444`.

## Current Scenarios

- `conversation-happy-path`: creates a conversation, sends one message, waits
  for the run to succeed, and verifies the transcript contains user and
  assistant messages. Tags: `fast`, `chat`.
- `recovery-interrupted-tool`: seeds an interrupted non-idempotent tool run,
  restarts the gateway, and verifies the run becomes recoverable instead of
  being automatically replayed. Tags: `fast`, `recovery`, `tools`.
- `attachment-message-link`: uploads a text attachment, sends it with a
  message, waits for the run, and verifies the user message keeps attachment
  metadata. Tags: `fast`, `attachments`.
- `run-event-terminal-replay`: reads the run SSE stream after completion,
  reconnects from the latest event sequence, and verifies the terminal event is
  replayed for caught-up clients. Tags: `fast`, `sse`, `reconnect`.
- `recovery-list-recoverable-runs`: restarts after an interrupted tool run and
  verifies the conversation recoverable-run query returns that run for restore
  UI flows. Tags: `fast`, `recovery`, `restore`.
- `restore-list-active-runs`: seeds a running run and verifies the conversation
  active-run query returns it for restore effects. Tags: `fast`, `recovery`,
  `restore`.
- `run-cancel-active`: seeds a running run, cancels it, and verifies the
  cancellation status plus SSE event. Tags: `fast`, `runs`.
- `run-create-idempotency`: sends the same create-run request twice with one
  idempotency key and verifies the cached run is reused. Tags: `fast`,
  `idempotency`, `runs`.
- `attachment-content-fetch`: uploads a text attachment and verifies the content
  endpoint returns the uploaded bytes. Tags: `fast`, `attachments`.
- `mcp-config-management`: creates a disabled MCP server config, verifies it is
  listed, and verifies tool listing stays empty without launching an external
  MCP process. Tags: `fast`, `mcp`.

## UI Smoke Coverage

`bun run harness:ui-smoke` runs a focused subset of the App integration suite:

- send message -> assistant message appears through the stub LLM path.
- restore saved active run and resume SSE from the persisted sequence.
- completed tool blocks remain visible after the assistant message is
  persisted.

## Useful Environment Variables

- `VULTURE_ACCEPTANCE_ARTIFACT_DIR`: output directory.
- `VULTURE_ACCEPTANCE_SCENARIOS`: comma-separated scenario ids.
- `VULTURE_ACCEPTANCE_TAGS`: comma-separated tag names. Tag selection uses OR
  semantics.
- `VULTURE_ACCEPTANCE_TIMEOUT_MS`: per-run wait timeout.
- `VULTURE_ACCEPTANCE_KEEP_PROFILE=1`: keep temporary profile/workspace data.
- `VULTURE_ACCEPTANCE_REAL_LLM=1`: allow the real configured LLM path.
