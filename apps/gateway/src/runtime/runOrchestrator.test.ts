import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { ConversationStore } from "../domain/conversationStore";
import { MessageStore } from "../domain/messageStore";
import { RunStore } from "../domain/runStore";
import { orchestrateRun } from "./runOrchestrator";
import type { LlmCallable, LlmYield, ToolCallable } from "@vulture/agent-runtime";

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
