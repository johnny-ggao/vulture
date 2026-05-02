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

Generate the harness catalog without executing scenarios:

```bash
bun run harness:catalog
```

Run metadata and coverage health checks without executing scenarios:

```bash
bun run harness:doctor
```

Aggregate the latest harness artifacts into one CI triage report:

```bash
bun run harness:report
```

Validate the latest harness artifact schemas:

```bash
bun run harness:artifacts
```

Run the CI harness bundle:

```bash
bun run harness:ci
```

`harness:ci` includes the shared `@vulture/harness-core` tests, harness catalog,
doctor, report, artifact validator, and orchestrator tests, and typecheck before
running the gateway and UI lanes. This keeps CLI parsing, scenario selection,
JUnit output, failure reports, artifact manifests, catalog generation, coverage
health checks, aggregate reporting, and artifact schema validation under the
same contract as the product harnesses.

`harness:ci` is driven by `scripts/harnessCi.ts` instead of a shell `&&` chain.
It removes stale CI harness artifact directories at the start of the run,
executes each harness step, keeps going after a failed step when later steps can
still produce diagnostic artifacts, and exits non-zero only after writing a
fresh `.artifacts/harness-report/ci-summary.json` and `ci-summary.md`. At the
end of the run it snapshots the current CI artifact bundle into
`.artifacts/harness-runs/`, keeps the latest five snapshots plus the latest
passed and failed snapshots, and writes retention and history reports. Set
`VULTURE_HARNESS_RETENTION_KEEP_LAST=<n>` to change the recent snapshot count.

When GitHub Actions provides `GITHUB_STEP_SUMMARY`, `harness:ci` appends a compact
Markdown summary to the job page. The summary includes step status, triage
failures, missing required artifact count, latest retained snapshot, key artifact
paths, and copy-paste rerun commands for failed items. Local runs without
`GITHUB_STEP_SUMMARY` do not write this extra file.

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
- `manifest.json` - shared harness-core manifest with lane, generated time,
  normalized result records, and artifact paths when available.
- `junit.xml` - machine-readable test results for CI surfaces.
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
- `manifest.json` - shared harness-core manifest with lane, generated time,
  normalized result records, and artifact paths when available.
- `junit.xml` - machine-readable test results for CI surfaces.
- `results.json` - per-tool check results.
- `failure-report.md` - present only when one or more contracts fail.

Useful environment variables:

- `VULTURE_TOOL_CONTRACT_ARTIFACT_DIR`: output directory.
- `VULTURE_TOOL_CONTRACT_TOOLS`: comma-separated tool ids.
- `VULTURE_TOOL_CONTRACT_CATEGORIES`: comma-separated categories.
- `VULTURE_TOOL_CONTRACT_WORKSPACE_DIR`: workspace path used for approval checks.

## Artifacts

### Harness Catalog

`bun run harness:catalog` scans all shipped runtime, tool contract, acceptance,
and desktop E2E scenarios and writes a lightweight coverage catalog under
`.artifacts/harness-catalog/`:

- `catalog.json` - machine-readable lane, scenario, and tag index.
- `catalog.md` - human-readable overview for planning coverage work.

The catalog does not execute scenarios. It is a fast inventory step for
answering what the harness currently covers and which tags span which lanes.

`bun run harness:doctor` builds the same catalog and checks harness metadata
plus the minimum harness health policy. Metadata checks fail on invalid lane
ids, duplicate scenario ids within a lane, empty scenario names, malformed
tags, or duplicate tags. Required coverage checks fail the command when core
lanes or key coverage tags disappear. Recommended checks report warning status
in `doctor.json` and `doctor.md` without failing CI.

Doctor artifacts:

- `doctor.json` - machine-readable check results.
- `doctor.md` - human-readable health report.

### Harness Report

`bun run harness:report` reads the latest lane manifests plus doctor output and
writes `.artifacts/harness-report/`:

- `report.json` - machine-readable aggregate status for runtime, tool contract,
  acceptance, optional desktop E2E, and doctor checks.
- `report.md` - human-readable CI triage entry point.

The report fails when a required lane manifest is missing, a required lane
failed, or doctor reports a failed check. Missing desktop E2E is treated as
optional because that lane only runs from manual GitHub Actions dispatch.

`harness:ci` also writes these files into the same directory after the aggregate
report step:

- `ci-summary.json` - machine-readable status for every `harness:ci` step.
- `ci-summary.md` - human-readable status for every `harness:ci` step.

The CI summary is the source of truth for typecheck, unit test, and UI smoke
failures that do not map to a lane manifest. After writing the final CI summary,
`harness:ci` refreshes artifact validation so `artifact-validation.md` reflects
the final `ci-summary.json`. When one or more CI steps fail, `ci-summary.md`
also includes a `Failed Steps` section with copy-paste commands for rerunning
the failed steps locally.

### Failure Triage

After final artifact validation and before retention, `harness:ci` writes a focused triage bundle into
`.artifacts/harness-report/`:

- `triage.json` - machine-readable failed CI steps, lanes, and artifact checks.
- `triage.md` - human-readable failure list with commands and artifact paths.

The triage report aggregates failed CI steps, failed or missing required lanes,
and failed artifact validation checks. Each item includes the most direct
rerun command when one is known. Successful runs still write an empty triage
report with `No failures.` so CI uploads always have the same files.

### Artifact Schema Validation

`bun run harness:artifacts` validates the latest harness artifact bundle and
writes these files into `.artifacts/harness-report/`:

- `artifact-validation.json` - machine-readable artifact validation checks.
- `artifact-validation.md` - human-readable artifact validation report.

The validator checks required lane manifests, JUnit count consistency, catalog
shape, doctor status consistency, aggregate report consistency, and
`ci-summary.json` when it is present. Desktop E2E artifacts are optional because
that lane is manually dispatched. Failed checks include the artifact path plus
expected, actual, hint, and a copy-paste command when the validator can identify
a concrete mismatch.

During `harness:ci`, the final artifact validation also requires a bundle
manifest and checks stable artifact contracts. The standalone
`bun run harness:artifacts` command remains usable before the full CI-only
artifact set exists.

### Artifact Contracts

The following JSON files are stable harness artifact contracts:

- `harness-report/report.json`
- `harness-report/ci-summary.json`
- `harness-report/artifact-validation.json`
- `harness-report/triage.json`
- `harness-report/retention.json`
- `harness-report/history.json`
- `harness-report/bundle-manifest.json`

For these files, `schemaVersion` and the top-level field set are treated as a
consumer-facing protocol. Adding, removing, or renaming a top-level field should
bump `schemaVersion` and update the contract tests in `@vulture/harness-core`.
Nested fields inside arrays such as `checks`, `items`, `steps`, and `files`
remain diagnostic payloads unless they are documented by a narrower contract.

### Bundle Manifest

At the end of `harness:ci`, the harness writes:

- `bundle-manifest.json` - machine-readable artifact file inventory.
- `bundle-manifest.md` - human-readable file inventory.

The bundle manifest enumerates the current CI artifact directories, records each
file path, size, modification time, and SHA-256 hash, and marks required files as
present or missing. The manifest excludes its own JSON and Markdown files from
the file hash list to avoid a self-hash loop, but final artifact validation still
requires `harness-report/bundle-manifest.json` to exist and have a valid schema.

### Artifact Retention

`harness:ci` archives the latest CI bundle after failure triage. The
snapshot lives under `.artifacts/harness-runs/<run-id>/` and includes the current
runtime, tool contract, acceptance, catalog, and report directories. Each
snapshot includes `retention-manifest.json` with the run id, status, timestamp,
source root, and copied artifact directories.

The retention policy keeps:

- the latest `VULTURE_HARNESS_RETENTION_KEEP_LAST` snapshots, defaulting to `5`;
- the latest passed snapshot;
- the latest failed snapshot.

Older snapshots are removed after the new snapshot is written. The current run
also writes `.artifacts/harness-report/retention.json` and `retention.md`, which
list kept and deleted snapshots plus deletion errors if cleanup could not remove
an old snapshot.

After retention, `harness:ci` writes `.artifacts/harness-report/history.json` and
`history.md`. The history index includes only retained snapshots and lists each
snapshot's timestamp, status, archive path, artifact directories, retention
reason, and direct paths to `report.md`, `ci-summary.md`, and
`artifact-validation.md` when the snapshot contains `harness-report`.

Negative artifact fixtures live in the `@vulture/harness-core` tests. They
intentionally corrupt manifests, JUnit counts, doctor checks, aggregate reports,
and CI summaries to verify failure diagnostics without shipping a default
failing harness command.

### Acceptance Artifacts

Each scenario writes a folder under `.artifacts/acceptance/`:

- `summary.json` - scenario status, step results, and resource ids.
- `events.jsonl` - ordered harness observations for replay/debugging.
- `transcript.md` - human-readable scenario transcript.

The suite also writes `.artifacts/acceptance/summary.json` with all scenario
results and artifact paths.

The suite also writes `.artifacts/acceptance/manifest.json` using the shared
harness-core manifest schema, so all harness lanes expose lane, result, and
artifact metadata in a consistent machine-readable shape.

The CLI also writes `.artifacts/acceptance/junit.xml` on every run so CI can
surface acceptance results as machine-readable test cases.

When one or more scenarios fail, the CLI also writes
`.artifacts/acceptance/failure-report.md`. This file is intended for CI artifact
upload and gives the failed scenario id, failed step, error, and scenario
artifact path.

GitHub Actions runs the same bundle through
[.github/workflows/harness.yml](/Users/johnny/Work/vulture/.github/workflows/harness.yml)
and uploads a `harness-artifacts` bundle on every run. The bundle contains:

- `.artifacts/runtime-harness`
- `.artifacts/tool-contract-harness`
- `.artifacts/acceptance`
- `.artifacts/harness-catalog`
- `.artifacts/harness-report`

The upload keeps each lane's `manifest.json`, `junit.xml`, summaries, failure
reports, aggregate `harness-report/report.md`, CI summary, failure triage,
artifact validation, retention, history, and bundle manifest reports together for CI triage. GitHub retains the
uploaded bundle for 14 days. Local historical snapshots live under
`.artifacts/harness-runs/` and are governed by the retention policy above.

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
`PATH`. When enabled, CI uploads `.artifacts/desktop-e2e` as
`desktop-e2e-artifacts` and retains it for 14 days.

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
- `manifest.json` - shared harness-core manifest with lane, generated time,
  normalized result records, and artifact paths.
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
