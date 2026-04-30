import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { ConversationStore } from "../domain/conversationStore";
import { MessageStore } from "../domain/messageStore";
import { RunStore } from "../domain/runStore";
import { ArtifactStore } from "../domain/artifactStore";
import { makeArtifactAuditHooks } from "./artifactAuditHooks";
import { createRuntimeHookRunner } from "./runtimeHooks";

function freshFixtures() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-artifact-hook-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const conversations = new ConversationStore(db);
  const messages = new MessageStore(db);
  const runs = new RunStore(db);
  const artifacts = new ArtifactStore(join(dir, "artifacts.json"));
  const conv = conversations.create({ agentId: "a-1", title: "" });
  const userMsg = messages.append({
    conversationId: conv.id,
    role: "user",
    content: "hi",
    runId: null,
  });
  const run = runs.create({
    conversationId: conv.id,
    agentId: "a-1",
    triggeredByMessageId: userMsg.id,
  });
  return {
    runs,
    artifacts,
    runId: run.id,
    conversationId: conv.id,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true });
    },
  };
}

describe("artifactAuditHooks", () => {
  test("indexes a completed tool call output as a data artifact", async () => {
    const fx = freshFixtures();
    try {
      const runner = createRuntimeHookRunner([
        ...makeArtifactAuditHooks({ artifacts: fx.artifacts, runs: fx.runs }),
      ]);

      await runner.emit("tool.afterCall", {
        runId: fx.runId,
        workspacePath: "/tmp/work",
        callId: "c-1",
        toolId: "shell.exec",
        category: "runtime",
        idempotent: false,
        input: { argv: ["pwd"] },
        outcome: "completed",
        durationMs: 12,
        output: { stdout: "/tmp/work\n", exitCode: 0 },
      });

      const items = fx.artifacts.list({ runId: fx.runId });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: "data",
        mimeType: "application/json",
        title: "shell.exec:c-1",
      });
      expect(items[0]?.metadata).toMatchObject({
        callId: "c-1",
        toolId: "shell.exec",
        category: "runtime",
        idempotent: false,
        durationMs: 12,
      });
      expect(items[0]?.content).toContain("/tmp/work");
    } finally {
      fx.cleanup();
    }
  });

  test("skips error / blocked outcomes and empty outputs", async () => {
    const fx = freshFixtures();
    try {
      const runner = createRuntimeHookRunner([
        ...makeArtifactAuditHooks({ artifacts: fx.artifacts, runs: fx.runs }),
      ]);

      await runner.emit("tool.afterCall", {
        runId: fx.runId,
        workspacePath: "/tmp/work",
        callId: "c-err",
        toolId: "shell.exec",
        input: {},
        outcome: "error",
        durationMs: 1,
        error: "boom",
      });
      await runner.emit("tool.afterCall", {
        runId: fx.runId,
        workspacePath: "/tmp/work",
        callId: "c-blk",
        toolId: "shell.exec",
        input: {},
        outcome: "blocked",
        durationMs: 0,
        error: "denied",
      });
      await runner.emit("tool.afterCall", {
        runId: fx.runId,
        workspacePath: "/tmp/work",
        callId: "c-empty",
        toolId: "read",
        input: {},
        outcome: "completed",
        durationMs: 0,
        output: {},
      });

      expect(fx.artifacts.list({ runId: fx.runId })).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });

  test("records the run final text on success", async () => {
    const fx = freshFixtures();
    try {
      const runner = createRuntimeHookRunner([
        ...makeArtifactAuditHooks({ artifacts: fx.artifacts, runs: fx.runs }),
      ]);

      await runner.emit("run.afterSuccess", {
        runId: fx.runId,
        conversationId: fx.conversationId,
        agentId: "a-1",
        model: "gpt-5.4",
        workspacePath: "/tmp/work",
        recovery: false,
        resultMessageId: "m-final",
        finalText: "the answer is 42",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });

      const items = fx.artifacts.list({ runId: fx.runId });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: "text",
        mimeType: "text/plain",
        title: `run:${fx.runId}:final`,
        content: "the answer is 42",
      });
      expect(items[0]?.metadata).toMatchObject({
        resultMessageId: "m-final",
        model: "gpt-5.4",
      });
    } finally {
      fx.cleanup();
    }
  });

  test("skips empty / whitespace-only final text", async () => {
    const fx = freshFixtures();
    try {
      const runner = createRuntimeHookRunner([
        ...makeArtifactAuditHooks({ artifacts: fx.artifacts, runs: fx.runs }),
      ]);

      await runner.emit("run.afterSuccess", {
        runId: fx.runId,
        conversationId: fx.conversationId,
        agentId: "a-1",
        model: "gpt-5.4",
        workspacePath: "/tmp/work",
        recovery: false,
        resultMessageId: "m-empty",
        finalText: "   \n  ",
      });

      expect(fx.artifacts.list({ runId: fx.runId })).toHaveLength(0);
    } finally {
      fx.cleanup();
    }
  });
});
