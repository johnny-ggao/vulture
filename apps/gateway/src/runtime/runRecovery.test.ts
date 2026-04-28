import { describe, expect, test } from "bun:test";
import type { RunStore } from "../domain/runStore";
import {
  classifyInflightRun,
  recoverInflightRuns,
  type RecoveryCandidate,
} from "./runRecovery";

const base = (overrides: Partial<RecoveryCandidate> = {}): RecoveryCandidate => ({
  runId: "r-1",
  hasRecoveryState: true,
  sdkState: "sdk",
  activeTool: null,
  activeToolHasTerminalEvent: false,
  hasApprovalInterruption: false,
  ...overrides,
});

describe("classifyInflightRun", () => {
  test("missing recovery state fails", () => {
    expect(classifyInflightRun(base({ hasRecoveryState: false }))).toEqual({
      kind: "fail",
      error: {
        code: "internal.recovery_state_unavailable",
        message: "recovery state unavailable for r-1",
      },
    });
  });

  test("missing sdk state fails", () => {
    expect(classifyInflightRun(base({ sdkState: null }))).toEqual({
      kind: "fail",
      error: {
        code: "internal.recovery_state_unavailable",
        message: "recovery state unavailable for r-1",
      },
    });
  });

  test("incomplete active tool becomes recoverable", () => {
    expect(
      classifyInflightRun(
        base({ activeTool: { callId: "c1", tool: "shell.exec", input: {}, startedSeq: 3 } }),
      ),
    ).toEqual({
      kind: "recoverable",
      reason: "incomplete_tool",
      message: "Tool shell.exec may have been interrupted before completion.",
    });
  });

  test("active tool takes precedence over approval interruption", () => {
    expect(
      classifyInflightRun(
        base({
          activeTool: { callId: "c1", tool: "shell.exec", input: {}, startedSeq: 3 },
          hasApprovalInterruption: true,
        }),
      ),
    ).toEqual({
      kind: "recoverable",
      reason: "incomplete_tool",
      message: "Tool shell.exec may have been interrupted before completion.",
    });
  });

  test("approval interruption becomes recoverable", () => {
    expect(classifyInflightRun(base({ hasApprovalInterruption: true }))).toEqual({
      kind: "recoverable",
      reason: "approval_pending",
      message: "Run is waiting for approval.",
    });
  });

  test("model-only checkpoint auto resumes", () => {
    expect(classifyInflightRun(base())).toEqual({ kind: "auto_resume" });
  });
});

describe("recoverInflightRuns", () => {
  function makeRuns(overrides: {
    state: ReturnType<RunStore["getRecoveryState"]>;
    activeToolHasTerminalEvent?: boolean;
  }) {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const runs = {
      listInflight: () => [{ id: "r-1" }],
      getRecoveryState: () => overrides.state,
      hasTerminalToolEvent: (_runId: string, _callId: string) =>
        overrides.activeToolHasTerminalEvent ?? false,
      markFailed: (...args: unknown[]) => calls.push({ method: "markFailed", args }),
      markRecoverable: (...args: unknown[]) => calls.push({ method: "markRecoverable", args }),
      appendEvent: (...args: unknown[]) => calls.push({ method: "appendEvent", args }),
    } as unknown as RunStore;
    return { runs, calls };
  }

  test("fails inflight run when recovery state is missing", async () => {
    const { runs, calls } = makeRuns({ state: null });

    await expect(recoverInflightRuns({ runs })).resolves.toEqual([]);

    expect(calls).toEqual([
      {
        method: "markFailed",
        args: [
          "r-1",
          {
            code: "internal.recovery_state_unavailable",
            message: "recovery state unavailable for r-1",
          },
        ],
      },
    ]);
  });

  test("marks incomplete active tool recoverable", async () => {
    const { runs, calls } = makeRuns({
      state: {
        schemaVersion: 1,
        sdkState: "sdk",
        metadata: {
          runId: "r-1",
          conversationId: "c-1",
          agentId: "a-1",
          model: "gpt-5.4",
          systemPrompt: "system",
          userInput: "hi",
          workspacePath: "/tmp/work",
          providerKind: "api_key",
          updatedAt: "2026-04-27T00:00:00.000Z",
        },
        checkpointSeq: 3,
        activeTool: { callId: "tc-1", tool: "shell.exec", input: {}, startedSeq: 3 },
      },
    });

    await expect(recoverInflightRuns({ runs })).resolves.toEqual([]);

    expect(calls).toEqual([
      { method: "markRecoverable", args: ["r-1"] },
      {
        method: "appendEvent",
        args: [
          "r-1",
          {
            type: "run.recoverable",
            reason: "incomplete_tool",
            message: "Tool shell.exec may have been interrupted before completion.",
          },
        ],
      },
    ]);
  });

  test("returns auto resume action for model checkpoint", async () => {
    const { runs, calls } = makeRuns({
      state: {
        schemaVersion: 1,
        sdkState: "sdk",
        metadata: {
          runId: "r-1",
          conversationId: "c-1",
          agentId: "a-1",
          model: "gpt-5.4",
          systemPrompt: "system",
          userInput: "hi",
          workspacePath: "/tmp/work",
          providerKind: "api_key",
          updatedAt: "2026-04-27T00:00:00.000Z",
        },
        checkpointSeq: 3,
        activeTool: null,
      },
    });

    await expect(recoverInflightRuns({ runs })).resolves.toEqual([
      { kind: "auto_resume", runId: "r-1" },
    ]);
    expect(calls).toEqual([{ method: "markRecoverable", args: ["r-1"] }]);
  });

  test("marks SDK approval interruptions recoverable without auto resume", async () => {
    const { runs, calls } = makeRuns({
      state: {
        schemaVersion: 1,
        sdkState: "sdk-with-interruption",
        metadata: {
          runId: "r-1",
          conversationId: "c-1",
          agentId: "a-1",
          model: "gpt-5.4",
          systemPrompt: "system",
          userInput: "hi",
          workspacePath: "/tmp/work",
          providerKind: "api_key",
          updatedAt: "2026-04-27T00:00:00.000Z",
        },
        checkpointSeq: 3,
        activeTool: null,
      },
    });
    const seenSdkStates: string[] = [];
    const seenRunIds: string[] = [];

    await expect(
      recoverInflightRuns({
        runs,
        hasApprovalInterruption: async (sdkState, runId) => {
          seenSdkStates.push(sdkState);
          seenRunIds.push(runId);
          return true;
        },
      }),
    ).resolves.toEqual([]);

    expect(seenSdkStates).toEqual(["sdk-with-interruption"]);
    expect(seenRunIds).toEqual(["r-1"]);
    expect(calls).toEqual([
      { method: "markRecoverable", args: ["r-1"] },
      {
        method: "appendEvent",
        args: [
          "r-1",
          {
            type: "run.recoverable",
            reason: "approval_pending",
            message: "Run is waiting for approval.",
          },
        ],
      },
    ]);
  });

  test("auto resumes active tool when terminal event exists", async () => {
    const { runs, calls } = makeRuns({
      activeToolHasTerminalEvent: true,
      state: {
        schemaVersion: 1,
        sdkState: "sdk",
        metadata: {
          runId: "r-1",
          conversationId: "c-1",
          agentId: "a-1",
          model: "gpt-5.4",
          systemPrompt: "system",
          userInput: "hi",
          workspacePath: "/tmp/work",
          providerKind: "api_key",
          updatedAt: "2026-04-27T00:00:00.000Z",
        },
        checkpointSeq: 3,
        activeTool: { callId: "tc-1", tool: "shell.exec", input: {}, startedSeq: 3 },
      },
    });

    await expect(recoverInflightRuns({ runs })).resolves.toEqual([
      { kind: "auto_resume", runId: "r-1" },
    ]);
    expect(calls).toEqual([{ method: "markRecoverable", args: ["r-1"] }]);
  });
});
