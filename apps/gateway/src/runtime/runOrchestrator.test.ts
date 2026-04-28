import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { ConversationStore } from "../domain/conversationStore";
import { MessageStore } from "../domain/messageStore";
import { RunStore, type RunRecoveryState } from "../domain/runStore";
import { orchestrateRun } from "./runOrchestrator";
import type { LlmCallable, LlmRecoveryInput, LlmYield, ToolCallable } from "@vulture/agent-runtime";

function freshDeps() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-orchestrator-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const conversations = new ConversationStore(db);
  const messages = new MessageStore(db);
  const runs = new RunStore(db);
  return {
    conversations,
    messages,
    runs,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true });
    },
  };
}

function createRunFixture(
  deps: ReturnType<typeof freshDeps>,
  userInput = "Explain approval recovery",
) {
  const conv = deps.conversations.create({
    agentId: "a-1",
    title: "Pinned title",
  });
  const userMsg = deps.messages.append({
    conversationId: conv.id,
    role: "user",
    content: userInput,
    runId: null,
  });
  const run = deps.runs.create({
    conversationId: conv.id,
    agentId: "a-1",
    triggeredByMessageId: userMsg.id,
  });
  return { conv, run, userInput };
}

function observeRecoveryWrites(runs: RunStore) {
  const saved: RunRecoveryState[] = [];
  const cleared: string[] = [];
  const saveRecoveryState = runs.saveRecoveryState.bind(runs);
  const clearRecoveryState = runs.clearRecoveryState.bind(runs);
  runs.saveRecoveryState = mock((runId: string, state: RunRecoveryState) => {
    saved.push(state);
    saveRecoveryState(runId, state);
  }) as RunStore["saveRecoveryState"];
  runs.clearRecoveryState = mock((runId: string) => {
    cleared.push(runId);
    clearRecoveryState(runId);
  }) as RunStore["clearRecoveryState"];
  return { saved, cleared };
}

describe("orchestrateRun recovery persistence", () => {
  test("saves recovery metadata, records LLM checkpoints, and clears recovery on success", async () => {
    const deps = freshDeps();
    try {
      const { conv, run, userInput } = createRunFixture(deps);
      const observed = observeRecoveryWrites(deps.runs);
      const llm: LlmCallable = mock(async function* (
        input: Parameters<LlmCallable>[0],
      ): AsyncGenerator<LlmYield, void, unknown> {
        input.onCheckpoint?.({ sdkState: "sdk-1", activeTool: null });
        yield { kind: "final", text: "ok" };
      });

      await orchestrateRun(
        {
          runs: deps.runs,
          messages: deps.messages,
          conversations: deps.conversations,
          llm,
          tools: async () => ({}),
          cancelSignals: new Map(),
        },
        {
          runId: run.id,
          agentId: "a-1",
          model: "gpt-5.4",
          systemPrompt: "main",
          conversationId: conv.id,
          userInput,
          workspacePath: "/tmp/work",
          providerKind: "codex",
        },
      );

      expect(observed.saved[0]).toMatchObject({
        schemaVersion: 1,
        sdkState: null,
        metadata: {
          runId: run.id,
          conversationId: conv.id,
          agentId: "a-1",
          model: "gpt-5.4",
          systemPrompt: "main",
          userInput,
          workspacePath: "/tmp/work",
          providerKind: "codex",
        },
        checkpointSeq: -1,
        activeTool: null,
      });
      expect(observed.saved[0]?.metadata.updatedAt).toEqual(expect.any(String));
      expect(observed.saved).toContainEqual(
        expect.objectContaining({
          sdkState: "sdk-1",
          checkpointSeq: 0,
          activeTool: null,
        }),
      );
      expect(observed.cleared).toEqual([run.id]);
      expect(deps.runs.getRecoveryState(run.id)).toBeNull();
    } finally {
      deps.cleanup();
    }
  });

  test("persists token usage reported by the LLM", async () => {
    const deps = freshDeps();
    try {
      const { conv, run, userInput } = createRunFixture(deps);
      const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
        yield {
          kind: "usage",
          usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
        };
        yield { kind: "final", text: "ok" };
      });

      await orchestrateRun(
        {
          runs: deps.runs,
          messages: deps.messages,
          conversations: deps.conversations,
          llm,
          tools: async () => ({}),
          cancelSignals: new Map(),
        },
        {
          runId: run.id,
          agentId: "a-1",
          model: "gpt-5.4",
          systemPrompt: "main",
          conversationId: conv.id,
          userInput,
          workspacePath: "/tmp/work",
        },
      );

      expect(deps.runs.get(run.id)?.usage).toEqual({
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 125,
      });
      expect(
        deps.runs.listEventsAfter(run.id, -1).some((event) => event.type === "run.usage"),
      ).toBe(true);
    } finally {
      deps.cleanup();
    }
  });

  test("clears recovery state after a failed LLM/tool run", async () => {
    const deps = freshDeps();
    try {
      const { conv, run, userInput } = createRunFixture(deps);
      const observed = observeRecoveryWrites(deps.runs);
      const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
        yield {
          kind: "tool.plan",
          callId: "call-1",
          tool: "shell.exec",
          input: { argv: ["pwd"] },
        };
        yield { kind: "await.tool", callId: "call-1" };
        yield { kind: "final", text: "unreachable" };
      });

      await orchestrateRun(
        {
          runs: deps.runs,
          messages: deps.messages,
          conversations: deps.conversations,
          llm,
          tools: async () => {
            throw new Error("tool failed");
          },
          cancelSignals: new Map(),
        },
        {
          runId: run.id,
          agentId: "a-1",
          model: "gpt-5.4",
          systemPrompt: "main",
          conversationId: conv.id,
          userInput,
          workspacePath: "/tmp/work",
        },
      );

      expect(deps.runs.get(run.id)?.status).toBe("failed");
      expect(observed.cleared).toEqual([run.id]);
      expect(deps.runs.getRecoveryState(run.id)).toBeNull();
    } finally {
      deps.cleanup();
    }
  });

  test("records active tool checkpoint with real tool event sequence and preserves previous SDK state", async () => {
    const deps = freshDeps();
    try {
      const { conv, run, userInput } = createRunFixture(deps);
      const observed = observeRecoveryWrites(deps.runs);
      const llm: LlmCallable = mock(async function* (
        input: Parameters<LlmCallable>[0],
      ): AsyncGenerator<LlmYield, void, unknown> {
        input.onCheckpoint?.({ sdkState: "sdk-prev", activeTool: null });
        yield { kind: "text.delta", text: "working" };
        input.onCheckpoint?.({
          sdkState: null,
          activeTool: {
            callId: "call-1",
            tool: "shell.exec",
            input: { argv: ["pwd"] },
            approvalToken: "approval-1",
          },
        });
        yield {
          kind: "tool.plan",
          callId: "call-1",
          tool: "shell.exec",
          input: { argv: ["pwd"] },
        };
        yield { kind: "final", text: "ok" };
      });

      await orchestrateRun(
        {
          runs: deps.runs,
          messages: deps.messages,
          conversations: deps.conversations,
          llm,
          tools: async () => ({}),
          cancelSignals: new Map(),
        },
        {
          runId: run.id,
          agentId: "a-1",
          model: "gpt-5.4",
          systemPrompt: "main",
          conversationId: conv.id,
          userInput,
          workspacePath: "/tmp/work",
        },
      );

      expect(observed.saved).toContainEqual(
        expect.objectContaining({
          sdkState: "sdk-prev",
          checkpointSeq: 2,
          activeTool: {
            callId: "call-1",
            tool: "shell.exec",
            input: { argv: ["pwd"] },
            approvalToken: "approval-1",
            startedSeq: 2,
          },
        }),
      );
    } finally {
      deps.cleanup();
    }
  });

  test("passes recovery input through to the LLM", async () => {
    const deps = freshDeps();
    try {
      const { conv, run, userInput } = createRunFixture(deps);
      const recovery: LlmRecoveryInput = { sdkState: "resume-state", retryToolCallId: null };
      let seenRecovery: LlmRecoveryInput | undefined;
      const llm: LlmCallable = mock(async function* (
        input: Parameters<LlmCallable>[0],
      ): AsyncGenerator<LlmYield, void, unknown> {
        seenRecovery = input.recovery;
        yield { kind: "final", text: "ok" };
      });

      await orchestrateRun(
        {
          runs: deps.runs,
          messages: deps.messages,
          conversations: deps.conversations,
          llm,
          tools: async () => ({}),
          cancelSignals: new Map(),
        },
        {
          runId: run.id,
          agentId: "a-1",
          model: "gpt-5.4",
          systemPrompt: "main",
          conversationId: conv.id,
          userInput,
          workspacePath: "/tmp/work",
          recovery,
        },
      );

      expect(seenRecovery).toEqual(recovery);
    } finally {
      deps.cleanup();
    }
  });

  test("clears recovery state without overwriting a cancelled run", async () => {
    const deps = freshDeps();
    try {
      const { conv, run, userInput } = createRunFixture(deps);
      const observed = observeRecoveryWrites(deps.runs);
      const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
        deps.runs.markCancelled(run.id);
        yield { kind: "final", text: "late result" };
      });

      await orchestrateRun(
        {
          runs: deps.runs,
          messages: deps.messages,
          conversations: deps.conversations,
          llm,
          tools: async () => ({}),
          cancelSignals: new Map(),
        },
        {
          runId: run.id,
          agentId: "a-1",
          model: "gpt-5.4",
          systemPrompt: "main",
          conversationId: conv.id,
          userInput,
          workspacePath: "/tmp/work",
        },
      );

      expect(deps.runs.get(run.id)?.status).toBe("cancelled");
      expect(observed.cleared).toEqual([run.id]);
      expect(deps.runs.getRecoveryState(run.id)).toBeNull();
    } finally {
      deps.cleanup();
    }
  });

  test("marks failed and clears recovery state when the LLM throws", async () => {
    const deps = freshDeps();
    try {
      const { conv, run, userInput } = createRunFixture(deps);
      const observed = observeRecoveryWrites(deps.runs);
      const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
        throw new Error("llm exploded");
      });

      await orchestrateRun(
        {
          runs: deps.runs,
          messages: deps.messages,
          conversations: deps.conversations,
          llm,
          tools: async () => ({}),
          cancelSignals: new Map(),
        },
        {
          runId: run.id,
          agentId: "a-1",
          model: "gpt-5.4",
          systemPrompt: "main",
          conversationId: conv.id,
          userInput,
          workspacePath: "/tmp/work",
        },
      );

      expect(deps.runs.get(run.id)?.status).toBe("failed");
      expect(deps.runs.get(run.id)?.error?.message).toBe("llm exploded");
      expect(observed.cleared).toEqual([run.id]);
      expect(deps.runs.getRecoveryState(run.id)).toBeNull();
    } finally {
      deps.cleanup();
    }
  });

  test("invalid recovery state fails terminally even in recovery mode", async () => {
    const deps = freshDeps();
    try {
      const { conv, run, userInput } = createRunFixture(deps);
      const observed = observeRecoveryWrites(deps.runs);
      const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
        throw new Error("internal.recovery_state_invalid: bad checkpoint");
      });

      await orchestrateRun(
        {
          runs: deps.runs,
          messages: deps.messages,
          conversations: deps.conversations,
          llm,
          tools: async () => ({}),
          cancelSignals: new Map(),
        },
        {
          runId: run.id,
          agentId: "a-1",
          model: "gpt-5.4",
          systemPrompt: "main",
          conversationId: conv.id,
          userInput,
          workspacePath: "/tmp/work",
          recovery: { sdkState: "bad-state", retryToolCallId: null },
          recoveryFailureMode: "recoverable",
        },
      );

      expect(deps.runs.get(run.id)?.status).toBe("failed");
      expect(deps.runs.get(run.id)?.error?.message).toContain("internal.recovery_state_invalid");
      expect(observed.cleared).toEqual([run.id]);
      expect(deps.runs.getRecoveryState(run.id)).toBeNull();
    } finally {
      deps.cleanup();
    }
  });
});

describe("orchestrateRun title generation", () => {
  test("updates provisional conversation title after a successful first run", async () => {
    const deps = freshDeps();
    const userInput = "Explain how approval recovery works in this app";
    const conv = deps.conversations.create({
      agentId: "a-1",
      title: userInput.slice(0, 40),
    });
    const userMsg = deps.messages.append({
      conversationId: conv.id,
      role: "user",
      content: userInput,
      runId: null,
    });
    const run = deps.runs.create({
      conversationId: conv.id,
      agentId: "a-1",
      triggeredByMessageId: userMsg.id,
    });

    let call = 0;
    const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
      call += 1;
      if (call === 1) {
        yield { kind: "final", text: "Approval recovery stores active state." };
        return;
      }
      yield { kind: "final", text: "Approval Recovery" };
    });
    const tools: ToolCallable = mock(async () => {
      throw new Error("tools should not be called");
    });

    await orchestrateRun(
      {
        runs: deps.runs,
        messages: deps.messages,
        conversations: deps.conversations,
        llm,
        tools,
        cancelSignals: new Map(),
      },
      {
        runId: run.id,
        agentId: "a-1",
        model: "gpt-5.4",
        systemPrompt: "main",
        conversationId: conv.id,
        userInput,
        workspacePath: "",
      },
    );

    const completed = deps.runs
      .listEventsAfter(run.id, -1)
      .find((event) => event.type === "run.completed");
    const finalRun = deps.runs.get(run.id);
    expect(deps.conversations.get(conv.id)?.title).toBe("Approval Recovery");
    expect(finalRun?.resultMessageId).toBeTruthy();
    expect(completed?.resultMessageId).toBe(finalRun?.resultMessageId ?? undefined);
    expect(llm).toHaveBeenCalledTimes(2);
    deps.cleanup();
  });

  test("does not replace a non-provisional title", async () => {
    const deps = freshDeps();
    const userInput = "Explain approval recovery";
    const conv = deps.conversations.create({
      agentId: "a-1",
      title: "Pinned title",
    });
    const userMsg = deps.messages.append({
      conversationId: conv.id,
      role: "user",
      content: userInput,
      runId: null,
    });
    const run = deps.runs.create({
      conversationId: conv.id,
      agentId: "a-1",
      triggeredByMessageId: userMsg.id,
    });
    const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
      yield { kind: "final", text: "Main answer" };
    });

    await orchestrateRun(
      {
        runs: deps.runs,
        messages: deps.messages,
        conversations: deps.conversations,
        llm,
        tools: async () => ({}),
        cancelSignals: new Map(),
      },
      {
        runId: run.id,
        agentId: "a-1",
        model: "gpt-5.4",
        systemPrompt: "main",
        conversationId: conv.id,
        userInput,
        workspacePath: "",
      },
    );

    expect(deps.conversations.get(conv.id)?.title).toBe("Pinned title");
    expect(llm).toHaveBeenCalledTimes(1);
    deps.cleanup();
  });

  test("does not generate a title for an empty conversation title", async () => {
    const deps = freshDeps();
    const userInput = "Explain approval recovery";
    const conv = deps.conversations.create({
      agentId: "a-1",
    });
    const userMsg = deps.messages.append({
      conversationId: conv.id,
      role: "user",
      content: userInput,
      runId: null,
    });
    const run = deps.runs.create({
      conversationId: conv.id,
      agentId: "a-1",
      triggeredByMessageId: userMsg.id,
    });
    const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
      yield { kind: "final", text: "Main answer" };
    });

    await orchestrateRun(
      {
        runs: deps.runs,
        messages: deps.messages,
        conversations: deps.conversations,
        llm,
        tools: async () => ({}),
        cancelSignals: new Map(),
      },
      {
        runId: run.id,
        agentId: "a-1",
        model: "gpt-5.4",
        systemPrompt: "main",
        conversationId: conv.id,
        userInput,
        workspacePath: "",
      },
    );

    expect(deps.conversations.get(conv.id)?.title).toBe("");
    expect(llm).toHaveBeenCalledTimes(1);
    deps.cleanup();
  });

  test("does not generate a title for configuration fallback text", async () => {
    const deps = freshDeps();
    const userInput = "Explain approval recovery";
    const conv = deps.conversations.create({
      agentId: "a-1",
      title: userInput.slice(0, 40),
    });
    const userMsg = deps.messages.append({
      conversationId: conv.id,
      role: "user",
      content: userInput,
      runId: null,
    });
    const run = deps.runs.create({
      conversationId: conv.id,
      agentId: "a-1",
      triggeredByMessageId: userMsg.id,
    });
    const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
      yield {
        kind: "final",
        text: "OPENAI_API_KEY not configured. Set the key via Settings or set the env var, then retry.",
      };
    });

    await orchestrateRun(
      {
        runs: deps.runs,
        messages: deps.messages,
        conversations: deps.conversations,
        llm,
        tools: async () => ({}),
        cancelSignals: new Map(),
      },
      {
        runId: run.id,
        agentId: "a-1",
        model: "gpt-5.4",
        systemPrompt: "main",
        conversationId: conv.id,
        userInput,
        workspacePath: "",
      },
    );

    expect(deps.conversations.get(conv.id)?.title).toBe(userInput.slice(0, 40));
    expect(llm).toHaveBeenCalledTimes(1);
    deps.cleanup();
  });
});
