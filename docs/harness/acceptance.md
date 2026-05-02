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

Run the live LLM harness (real OpenAI):

```bash
OPENAI_API_KEY=sk-... bun run harness:live
OPENAI_API_KEY=sk-... bun run harness:live -- --list
```

The live lane is opt-in — it skips silently with a `Live harness skipped:` message when `OPENAI_API_KEY` is not set, so it cannot accidentally consume tokens. PR/push CI never runs it; only manual `workflow_dispatch` with `runLiveLlm=true` triggers it on GitHub Actions, where the key is read from the `OPENAI_API_KEY` repository secret.

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

Aggregate recent snapshots into duration / pass-rate / flake trends:

```bash
bun run harness:trend
```

Reads `.artifacts/harness-runs/<id>/harness-report/report.json` for each
retained snapshot, computes per-step P50 / P95 / max duration, per-step and
per-lane pass rate, and pass→fail→pass flake candidates over the last 30 runs
(override with `VULTURE_HARNESS_TREND_LIMIT`). Writes `trend.json` and
`trend.md` next to `report.json`. `harness:ci` invokes this automatically at
the end of every run when at least one snapshot exists.

Run the CI harness bundle:

```bash
bun run harness:ci
```

`harness:ci` includes the shared `@vulture/harness-core` tests, harness catalog,
doctor, and orchestrator tests, and typecheck before running the gateway and UI
lanes. This keeps CLI parsing, scenario selection, JUnit output, failure
reports, artifact manifests, catalog generation, coverage health checks, and
aggregate reporting under the same contract as the product harnesses.

`harness:ci` is driven by `scripts/harnessCi.ts` instead of a shell `&&` chain.
It removes stale CI harness artifact directories at the start of the run,
executes each harness step, keeps going after a failed step when later steps can
still produce diagnostic artifacts, and writes a single unified
`.artifacts/harness-report/report.json` (schemaVersion 2) that embeds lane
status, doctor summary, CI step results, artifact validation, and the failure
triage. At the end of the run it snapshots the current CI artifact bundle into
`.artifacts/harness-runs/`, keeps the latest five snapshots plus the latest
passed and failed snapshots, and writes retention, history, and bundle-manifest
reports. Set `VULTURE_HARNESS_RETENTION_KEEP_LAST=<n>` to change the recent
snapshot count.

When GitHub Actions provides `GITHUB_STEP_SUMMARY`, `harness:ci` appends a
compact Markdown summary to the job page. The summary includes step status,
failure list, missing required artifact count, latest retained snapshot, and
key artifact paths. Local runs without `GITHUB_STEP_SUMMARY` do not write this
extra file.

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

### Harness Report (single source of truth)

`harness:ci` writes a single unified report at `.artifacts/harness-report/`:

- `report.json` - schemaVersion 2 aggregate document.
- `report.md` - human-readable CI triage entry point.

The report embeds:

- `lanes` - status of runtime, tool-contract, acceptance, and optional desktop-e2e.
- `doctor` - aggregated counts from `harness-catalog/doctor.json`.
- `ci` - every `harness:ci` step with command, status, exit code, and duration.
  Replaces the previous standalone `ci-summary.json`.
- `artifactValidation` - schema integrity checks for lane manifests, JUnit,
  catalog, doctor, aggregate report, and bundle manifest. Replaces the previous
  standalone `artifact-validation.json`.
- `failures` - unified triage list aggregating failed CI steps, failed/missing
  required lanes, and failed artifact-validation checks, each with a rerun
  command when one is known. Replaces the previous standalone `triage.json`.

The report fails when a required lane manifest is missing, a required lane
failed, a CI step failed, an artifact validation check failed, or doctor
reports a failed check. Missing desktop E2E is treated as optional because that
lane only runs from manual GitHub Actions dispatch.

`bun run harness:report` produces a thinner standalone variant: it reads only
the latest lane manifests plus doctor output and writes a v2 report with
`ci: null` and `artifactValidation: null`. This is for local "what's the lane
status right now?" lookups; the orchestrator's final report is the canonical
artifact.

### Artifact Contracts

The following JSON files are stable harness artifact contracts:

- `harness-report/report.json` (schemaVersion 2)
- `harness-report/retention.json`
- `harness-report/history.json`
- `harness-report/bundle-manifest.json`

For these files, `schemaVersion` and the top-level field set are treated as a
consumer-facing protocol. Adding, removing, or renaming a top-level field should
bump `schemaVersion` and update the contract tests in `@vulture/harness-core`.
Nested fields inside arrays such as `checks`, `items`, `steps`, and `files`
remain diagnostic payloads unless they are documented by a narrower contract.

Standalone `ci-summary.json`, `artifact-validation.json`, and `triage.json` no
longer exist; their content is now embedded in `report.json` as the `ci`,
`artifactValidation`, and `failures` blocks respectively.

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
reason, and a direct path to the snapshot's `report.md` when the snapshot
contains `harness-report`.

Negative artifact fixtures live in the `@vulture/harness-core` tests. They
intentionally corrupt manifests, JUnit counts, doctor checks, and embedded
ci/artifactValidation/failures blocks to verify failure diagnostics without
shipping a default failing harness command.

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
and uploads a `harness-artifacts` bundle on every run. The workflow uses
`bun install --frozen-lockfile`, opts JavaScript actions into the Node 24 runtime
transition, and warns when the upload step cannot find the expected artifact
directories. The bundle contains:

- `.artifacts/runtime-harness`
- `.artifacts/tool-contract-harness`
- `.artifacts/acceptance`
- `.artifacts/harness-catalog`
- `.artifacts/harness-report`
- `.artifacts/harness-runs`

The upload keeps each lane's `manifest.json`, `junit.xml`, summaries, failure
reports, the unified `harness-report/report.{json,md}`, retention, history,
bundle manifest reports, and retained historical snapshots together for CI
triage. GitHub retains the uploaded bundle for 14 days. Local and uploaded
historical snapshots live under `.artifacts/harness-runs/` and are governed by
the retention policy above.

The desktop E2E lane runs in two modes:

- **Nightly soak** (cron `0 7 * * *`, 07:00 UTC / 15:00 Beijing): runs
  automatically on `main` so the lane stays exercised even though it does not
  gate PRs. Failures upload `desktop-e2e-artifacts` and surface as a red status
  on the workflow runs page.
- **Manual dispatch**: open the `Harness` workflow, click `Run workflow`, set
  `runDesktopE2E` to `true`, and start the run. Behaves like nightly but
  triggered on demand. When `runDesktopE2E` stays `false`, the manual run
  skips desktop E2E and only runs the `harness` job.

Both modes execute `bun run harness:desktop-e2e -- --tag smoke` on
`ubuntu-latest` through `xvfb-run`. The workflow installs Tauri CLI,
`tauri-driver`, `webkit2gtk-driver`, Xvfb, and the standard Tauri v2 Linux
build dependencies before launching the smoke lane.

Both GitHub Actions jobs have explicit timeouts so a stuck harness process does
not consume a runner indefinitely: 30 minutes for the default harness job and 60
minutes for the desktop E2E lane.

When the nightly schedule fails (either `harness:ci` or
`harness:desktop-e2e`), the workflow opens or comments on a tracking issue
labeled `nightly-failure` with the run URL, commit SHA, and a pointer to the
relevant artifact bundle. The issue title is stable per job
(`Nightly harness:ci failing` / `Nightly desktop-e2e failing`) so repeated
failures coalesce into one rolling thread instead of spamming new issues.
This is the only path that turns nightly red into action — without it,
failures sit silent on the workflow runs page.

### Live LLM lane

The `harness:live` lane covers the real OpenAI path that stub-only harnesses
cannot exercise. A single smoke scenario (`hello-text`) sends one short prompt
and asserts the assistant returns nonempty text under 200 characters. It runs
in two situations:

- **Local**: `OPENAI_API_KEY=... bun run harness:live`. Without the key the
  command exits 0 with an explicit "skipped" message — there is no path that
  silently bills the user.
- **GitHub Actions manual dispatch**: open the `Harness` workflow, set
  `runLiveLlm=true`, and trigger. The job reads `secrets.OPENAI_API_KEY` and
  uploads `live-llm-artifacts` for 14 days. The job is `if`-gated so it only
  runs from explicit dispatch — never on PR, push, or schedule.

The live lane writes to `.artifacts/live-harness/` (manifest, junit,
failure-report, summary, transcripts.jsonl). It is registered in the harness
lane registry with `required: false`, so its absence from a routine `harness:ci`
run is treated as expected, not a failure.

Add a new scenario by editing `defaultLiveHarnessScenarios` in
`apps/gateway/src/harness/liveHarness.ts`. Scenarios should be cheap (one
small prompt, low max-tokens) and assert behavior that does not depend on
specific model wording — the assertion runs against a real model whose output
varies.

### Desktop E2E promotion criteria

Desktop E2E starts as nightly-only. Promote it to PR gating only after **all**
of the following are observed on `main`:

1. **Stability**: 14 consecutive nightly runs pass. Read off
   `harness-report/trend.md`'s `desktop-e2e` lane row (Failed = 0).
2. **Speed**: median wallclock ≤ 8 minutes. Use the `desktop-e2e` row's `P50`
   in the trend Step durations table.
3. **Flake rate**: < 5% across the prior 30 nightly runs (a flake = a
   pass→fail→pass pattern reported under "Flake candidates" in the trend).
4. **Cost**: nightly cron does not regularly bump up against the 60-minute
   timeout.

Only when **all four** are met for two consecutive weeks should the lane move
into the default `harness` job (or its own job) and become a PR blocker.
Document the promotion in the PR that flips the gate so the bar is auditable.

Demotion: if any criterion regresses for more than 7 nightly runs after
promotion, demote the lane back to nightly-only and open a tracking issue
before merging further desktop-ui changes that depend on the gate.

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
