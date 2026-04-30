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
   `macos-latest`.

When `runDesktopE2E` stays `false`, the manual run behaves like the default CI
path and only runs the `harness` job.

## Desktop E2E

Desktop E2E launches the real Tauri shell through `cargo tauri dev` and drives
the UI through `tauri-driver` + WebDriver. Each selected scenario gets its own
isolated desktop root and default workspace under the scenario artifact
directory, so local SQLite/profile state is not shared across runs.

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
- `failure-report.md` - present only when one or more scenarios fail.

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
